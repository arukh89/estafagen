// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title IAgentIdRegistry
/// @notice Minimal view of the SPACE ID Agent ID registry (ERC-721, non-transferable).
/// @dev Only `balanceOf` is needed: a return value greater than 0 means the
///      address holds an Agent ID. On BNB Chain mainnet this is
///      0x60b9262456de011f7d15a54cdd8c48baaa8b022f; on BSC Testnet the
///      MockAgentIdRegistry from Round 1 stands in with the exact same signature.
interface IAgentIdRegistry {
    /// @notice Returns the number of Agent IDs held by `account`.
    /// @param account The address to check.
    /// @return balance The Agent ID balance (0 = not a holder).
    function balanceOf(address account) external view returns (uint256 balance);
}

/// @title EstafAgen
/// @notice Agent-to-agent task delegation plus an agent directory, gated by Agent ID.
/// @dev Holders of an Agent ID publish what their agent can do in the directory
///      (opt-in, self-published — the Agent Card pattern); other holders find an
///      agent by capability and delegate subtasks to it. Every step is recorded
///      on-chain (parentId chain + events) so anyone can read the delegation chain.
///
///      Compliance: the directory contains ONLY entries published by holders
///      themselves for the purpose of receiving delegations. It is NOT a
///      name-to-address lookup for other people: there is no lookup of
///      non-listed holders, and anyone can remove their own profile.
///
///      No token, no payments, no rewards. The contract holds no funds and has
///      no payable / withdraw / mint / tax / freeze functions and no proxy.
///      There is deliberately no ReentrancyGuard: the contract holds no funds,
///      makes no external call after a state change, and the only external call
///      is the registry's view `balanceOf`, performed as a check before any
///      state change (checks-effects-interactions).
///
///      Documented v1 limits:
///      - The `.ai` name in a profile is self-declared, NOT read on-chain from
///        the registry. The holder's address is always shown next to the name.
///      - Capability claims are unverified: anyone can write anything. The
///        trustworthy part is the recorded delegation chain, not the claims.
///      - Completing a subtask does NOT auto-update the parent task's status;
///        the chain is read from parentId + events.
///      - No task deadlines. No rewards or payments.
///
///      Round 5 additions (ADDITIVE only — no existing function signature or
///      struct layout changed, so the Round 4 deployment ABI stays compatible):
///      - ProfileExtras: availability, capacity note, guild, Agent Card URL
///        + wallet signature, and lastUpdated (heartbeat). Stored in a
///        separate mapping with its own getter; publishing a profile also
///        refreshes lastUpdated, removing a profile deletes the extras.
///      - Two-sided attestations: after a task completes, its creator
///        attests the work quality (1-5) and its assignee attests the brief
///        clarity (1-5). One attestation of each kind per task.
///      - Reputation staking: accepting with a stake (1-10 points) records
///        the stake on-chain. Points only — no funds, no token. The score
///        itself is computed off-chain by the frontend indexer from events
///        (see frontend/estafagen.js computeReputation()): +10 per completed
///        delegation, +(stars-3)x2 per attestation received, +stake on a
///        staked completion, -stake when a staked task is cancelled after
///        acceptance. The contract has no "failed" status, so a cancel after
///        acceptance is the observable failure signal.
contract EstafAgen is Ownable2Step, Pausable {
    /// @notice Caller does not hold an Agent ID (`balanceOf` returned 0).
    error NotAgentIdHolder();
    /// @notice Caller is not the assignee of the task.
    error NotAssignee();
    /// @notice Caller is not the creator of the task.
    error NotCreator();
    /// @notice The task is not in a status that allows this action (or does not exist).
    error InvalidStatus();
    /// @notice The task cannot be delegated from (completed, cancelled, rejected,
    ///         not yet accepted, or does not exist).
    error NotDelegatable();
    /// @notice The Agent ID registry address passed to the constructor is zero.
    /// @dev Extra guard beyond the plan's error list: a zero registry would make
    ///      every holder check fail, bricking the contract.
    error InvalidRegistryAddress();
    /// @notice An attestation of this kind already exists for this task (one each).
    error AlreadyAttested();
    /// @notice An attestation score is outside 1-5.
    error InvalidScore();
    /// @notice A reputation stake is outside 1-10.
    error InvalidStake();
    /// @notice An availability value is outside 0-2 (0 unspecified, 1 available, 2 busy).
    error InvalidAvailability();

    /// @notice Lifecycle of a task.
    enum Status {
        Open, // Root task, or task not yet delegated. Assignee is the creator.
        Delegated, // Subtask created by delegateTask, waiting for the assignee.
        Accepted, // Assignee accepted the delegation and is working on it.
        Completed, // Assignee marked the task done.
        Rejected, // Assignee declined the delegation.
        Cancelled // Creator cancelled the task.
    }

    /// @notice A directory entry, published by a holder about their own agent.
    /// @dev `name` is self-declared (not read from the registry). `exists`
    ///      distinguishes a published profile from an empty one.
    struct Profile {
        bool exists;
        string name;
        string capabilities;
        string description;
    }

    /// @notice A task. `parentId == 0` marks a root task created by createTask.
    struct Task {
        uint256 id;
        string title;
        string description;
        address creator;
        address assignee;
        uint256 parentId;
        Status status;
        uint256 createdAt;
    }

    /// @notice Extra directory fields for a profile (Round 5).
    /// @dev Kept in a separate mapping on purpose: the original Profile
    ///      struct (and therefore the getProfile() return shape) never
    ///      changes, so the Round 4 deployment ABI stays compatible.
    ///      `availability`: 0 = unspecified, 1 = available, 2 = busy.
    ///      `agentCardUrl` is the holder's own A2A Agent Card URL
    ///      (/.well-known/agent.json), set only in their own profile edit
    ///      flow; `agentCardSignature` is the holder's wallet signature
    ///      over the message "EstafAgen agent-card verification\n<url>",
    ///      which anyone can verify recovers to the holder's address.
    ///      `lastUpdated` is the heartbeat: refreshed on publish,
    ///      extras update, and renew; the UI calls a profile "stale"
    ///      when it is older than 30 days.
    struct ProfileExtras {
        uint8 availability;
        string capacityNote;
        string guild;
        string agentCardUrl;
        string agentCardSignature;
        uint256 lastUpdated;
    }

    /// @notice A single attestation on a completed task (Round 5).
    /// @dev One quality attestation (by the creator, about the assignee)
    ///      and one brief attestation (by the assignee, about the creator)
    ///      per task. `score` is 1-5 stars.
    struct Attestation {
        bool exists;
        uint8 score;
        address attester;
        uint256 createdAt;
    }

    /// @notice Emitted when a holder publishes or updates their profile.
    /// @param holder The holder publishing the profile.
    /// @param name The self-declared `.ai` name in the profile.
    event ProfilePublished(address indexed holder, string name);

    /// @notice Emitted when a holder removes their profile.
    /// @param holder The holder removing the profile.
    event ProfileRemoved(address indexed holder);

    /// @notice Emitted when a root task is created.
    /// @param taskId The new task id.
    /// @param creator The holder creating the task (also its first assignee).
    event TaskCreated(uint256 indexed taskId, address indexed creator);

    /// @notice Emitted when a subtask is created by delegation.
    /// @param taskId The new subtask id.
    /// @param parentId The id of the task it was delegated from.
    /// @param delegator The holder delegating (creator or assignee of the parent).
    /// @param assignee The holder receiving the delegation.
    event TaskDelegated(
        uint256 indexed taskId,
        uint256 indexed parentId,
        address indexed delegator,
        address assignee
    );

    /// @notice Emitted when the assignee accepts a delegation.
    /// @param taskId The delegated task id.
    /// @param assignee The assignee accepting.
    event DelegationAccepted(uint256 indexed taskId, address indexed assignee);

    /// @notice Emitted when the assignee rejects a delegation.
    /// @param taskId The delegated task id.
    /// @param assignee The assignee rejecting.
    event DelegationRejected(uint256 indexed taskId, address indexed assignee);

    /// @notice Emitted when the assignee marks a task complete.
    /// @param taskId The completed task id.
    /// @param assignee The assignee completing it.
    event TaskCompleted(uint256 indexed taskId, address indexed assignee);

    /// @notice Emitted when the creator cancels a task.
    /// @param taskId The cancelled task id.
    /// @param creator The creator cancelling it.
    event TaskCancelled(uint256 indexed taskId, address indexed creator);

    /// @notice Emitted when a holder sets or updates their profile extras.
    /// @param holder The holder updating the extras.
    event ProfileExtrasUpdated(address indexed holder);

    /// @notice Emitted when a holder renews their profile heartbeat.
    /// @param holder The holder renewing.
    /// @param timestamp The new lastUpdated value (block time).
    event ProfileRenewed(address indexed holder, uint256 timestamp);

    /// @notice Emitted when a task creator attests the work quality (1-5).
    /// @param taskId The completed task id.
    /// @param attester The creator attesting (the delegator).
    /// @param assignee The assignee whose work is attested.
    /// @param score Stars, 1-5.
    event QualityAttested(
        uint256 indexed taskId,
        address indexed attester,
        address indexed assignee,
        uint8 score
    );

    /// @notice Emitted when a task assignee attests the brief clarity (1-5).
    /// @param taskId The completed task id.
    /// @param attester The assignee attesting.
    /// @param creator The creator whose brief is attested.
    /// @param score Stars, 1-5.
    event BriefAttested(
        uint256 indexed taskId,
        address indexed attester,
        address indexed creator,
        uint8 score
    );

    /// @notice Emitted when an assignee accepts with a reputation stake.
    /// @param taskId The delegated task id.
    /// @param assignee The assignee staking.
    /// @param stake Points staked (1-10). No funds involved.
    event ReputationStaked(uint256 indexed taskId, address indexed assignee, uint8 stake);

    /// @notice The Agent ID registry used for holder gating (immutable).
    IAgentIdRegistry public immutable agentIdRegistry;

    /// @notice Directory profiles by holder address.
    mapping(address => Profile) private _profiles;

    /// @notice Tasks by id. Ids start at 1; id 0 means "no parent".
    mapping(uint256 => Task) private _tasks;

    /// @notice Next task id to assign. Starts at 1 so 0 stays the root sentinel.
    uint256 private _nextTaskId = 1;

    /// @notice Profile extras by holder address (Round 5).
    mapping(address => ProfileExtras) private _extras;

    /// @notice Quality attestations by task id (Round 5).
    mapping(uint256 => Attestation) private _qualityAttestations;

    /// @notice Brief attestations by task id (Round 5).
    mapping(uint256 => Attestation) private _briefAttestations;

    /// @notice Reputation stake (points) recorded at accept, by task id (Round 5).
    mapping(uint256 => uint8) private _stakes;

    /// @notice Content hash (keccak256 of the plaintext) for private tasks, by task id (Round 5).
    /// @dev Zero hash means "not a private task".
    mapping(uint256 => bytes32) private _contentHashes;

    /// @notice Deploys EstafAgen gated by `agentIdRegistry_`.
    /// @dev The deployer becomes the owner (Ownable2Step). Owner powers are
    ///      pause/unpause only. Reverts on a zero registry address.
    /// @param agentIdRegistry_ Address of the Agent ID registry (mainnet:
    ///      the official SPACE ID contract; testnet: the mock registry).
    constructor(address agentIdRegistry_) Ownable(msg.sender) {
        if (agentIdRegistry_ == address(0)) {
            revert InvalidRegistryAddress();
        }
        agentIdRegistry = IAgentIdRegistry(agentIdRegistry_);
    }

    /// @notice Reverts unless `account` holds an Agent ID.
    /// @param account The address to check via the registry.
    function _requireHolder(address account) private view {
        if (agentIdRegistry.balanceOf(account) == 0) {
            revert NotAgentIdHolder();
        }
    }

    /// @notice Reverts unless `taskId` names an existing task.
    /// @dev Nonexistent ids revert with InvalidStatus: returning a zero-filled
    ///      struct would look like a real Open task, which would mislead readers.
    /// @param taskId The task id to check.
    function _requireTaskExists(uint256 taskId) private view {
        if (taskId == 0 || taskId >= _nextTaskId) {
            revert InvalidStatus();
        }
    }

    /// @notice Returns true if `account` holds an Agent ID.
    /// @dev Read-only helper for the frontend (holder check before sending a tx).
    /// @param account The address to check.
    /// @return True when `balanceOf(account) > 0`.
    function isHolder(address account) external view returns (bool) {
        return agentIdRegistry.balanceOf(account) > 0;
    }

    /// @notice Returns the number of tasks created so far.
    /// @return The task count (ids run 1..count).
    function taskCount() external view returns (uint256) {
        return _nextTaskId - 1;
    }

    /// @notice Returns a holder's published profile.
    /// @param holder The holder address.
    /// @return The profile (exists == false when never published or removed).
    function getProfile(address holder) external view returns (Profile memory) {
        return _profiles[holder];
    }

    /// @notice Returns true if `holder` currently has a published profile.
    /// @param holder The holder address.
    /// @return True when a profile exists.
    function hasProfile(address holder) external view returns (bool) {
        return _profiles[holder].exists;
    }

    /// @notice Returns a task by id.
    /// @dev Reverts InvalidStatus for ids that do not exist yet.
    /// @param taskId The task id.
    /// @return The task.
    function getTask(uint256 taskId) external view returns (Task memory) {
        _requireTaskExists(taskId);
        return _tasks[taskId];
    }

    /// @notice Returns a holder's profile extras (Round 5).
    /// @dev All fields default to empty/zero when never set. `lastUpdated`
    ///      is 0 for a holder who never published a profile.
    /// @param holder The holder address.
    /// @return The extras (availability, capacity note, guild, Agent Card
    ///      URL + signature, lastUpdated heartbeat).
    function getProfileExtras(address holder) external view returns (ProfileExtras memory) {
        return _extras[holder];
    }

    /// @notice Returns the quality attestation for a task, if any (Round 5).
    /// @param taskId The task id.
    /// @return The attestation (exists == false when never attested).
    function getQualityAttestation(uint256 taskId) external view returns (Attestation memory) {
        return _qualityAttestations[taskId];
    }

    /// @notice Returns the brief attestation for a task, if any (Round 5).
    /// @param taskId The task id.
    /// @return The attestation (exists == false when never attested).
    function getBriefAttestation(uint256 taskId) external view returns (Attestation memory) {
        return _briefAttestations[taskId];
    }

    /// @notice Returns the reputation stake recorded at accept, if any (Round 5).
    /// @param taskId The task id.
    /// @return The staked points (0 = accepted without a stake).
    function getStake(uint256 taskId) external view returns (uint8) {
        return _stakes[taskId];
    }

    /// @notice Returns the content hash of a private task, if any (Round 5).
    /// @dev Zero hash means the task is public (plaintext in `description`).
    /// @param taskId The task id.
    /// @return The keccak256 hash of the private plaintext, or zero.
    function getTaskContentHash(uint256 taskId) external view returns (bytes32) {
        return _contentHashes[taskId];
    }

    /// @notice Publishes (or updates) the caller's own directory profile.
    /// @dev Holder-gated. Upsert: calling again replaces name/capabilities/
    ///      description. The `.ai` name is self-declared, not read on-chain.
    ///      Also refreshes the heartbeat (`lastUpdated` in the extras),
    ///      so publishing counts as renewing the profile.
    /// @param name The self-declared `.ai` name of the caller's agent.
    /// @param capabilities Free-text capabilities (what the agent can do).
    /// @param description Free-text description.
    function publishProfile(
        string calldata name,
        string calldata capabilities,
        string calldata description
    ) external whenNotPaused {
        _requireHolder(msg.sender);
        _profiles[msg.sender] = Profile({
            exists: true,
            name: name,
            capabilities: capabilities,
            description: description
        });
        _extras[msg.sender].lastUpdated = block.timestamp;
        emit ProfilePublished(msg.sender, name);
    }

    /// @notice Removes the caller's own directory profile.
    /// @dev Not holder-gated on purpose: a holder whose Agent ID was revoked
    ///      can still remove their profile. Reverts InvalidStatus when there
    ///      is no profile to remove. Also deletes the profile extras
    ///      (availability, guild, Agent Card URL + signature, heartbeat).
    function removeProfile() external whenNotPaused {
        if (!_profiles[msg.sender].exists) {
            revert InvalidStatus();
        }
        delete _profiles[msg.sender];
        delete _extras[msg.sender];
        emit ProfileRemoved(msg.sender);
    }

    /// @notice Sets (or updates) the caller's profile extras (Round 5).
    /// @dev Holder-gated and requires an existing profile: extras attach to
    ///      a published profile. Upsert: calling again replaces all fields.
    ///      Refreshes the heartbeat. The Agent Card URL is validated
    ///      client-side (https, except http://localhost for local dev);
    ///      the contract stores whatever string it is given, and the
    ///      signature is what makes the badge trustworthy, not the URL.
    /// @param availability 0 = unspecified, 1 = available, 2 = busy.
    /// @param capacityNote Free-text note, e.g. "2 slots this week".
    /// @param guild Free-text guild name (no on-chain membership check:
    ///      anyone can claim any guild name; trust comes from scores).
    /// @param agentCardUrl The holder's own A2A Agent Card URL.
    /// @param agentCardSignature The holder's wallet signature over
    ///      "EstafAgen agent-card verification\n<url>".
    function setProfileExtras(
        uint8 availability,
        string calldata capacityNote,
        string calldata guild,
        string calldata agentCardUrl,
        string calldata agentCardSignature
    ) external whenNotPaused {
        _requireHolder(msg.sender);
        if (!_profiles[msg.sender].exists) {
            revert InvalidStatus();
        }
        if (availability > 2) {
            revert InvalidAvailability();
        }
        _extras[msg.sender] = ProfileExtras({
            availability: availability,
            capacityNote: capacityNote,
            guild: guild,
            agentCardUrl: agentCardUrl,
            agentCardSignature: agentCardSignature,
            lastUpdated: block.timestamp
        });
        emit ProfileExtrasUpdated(msg.sender);
    }

    /// @notice Renews the caller's profile heartbeat (Round 5).
    /// @dev Holder-gated, requires an existing profile. One click, one
    ///      transaction; the UI shows a profile as "stale" when its
    ///      lastUpdated is older than 30 days.
    function renewProfile() external whenNotPaused {
        _requireHolder(msg.sender);
        if (!_profiles[msg.sender].exists) {
            revert InvalidStatus();
        }
        _extras[msg.sender].lastUpdated = block.timestamp;
        emit ProfileRenewed(msg.sender, block.timestamp);
    }

    /// @notice Creates a root task. The caller is its creator and first assignee.
    /// @dev Holder-gated. The task starts Open with parentId 0.
    /// @param title Short title of the task.
    /// @param description Longer description of what needs doing.
    /// @return taskId The id of the new task.
    function createTask(
        string calldata title,
        string calldata description
    ) external whenNotPaused returns (uint256 taskId) {
        _requireHolder(msg.sender);
        taskId = _nextTaskId++;
        _tasks[taskId] = Task({
            id: taskId,
            title: title,
            description: description,
            creator: msg.sender,
            assignee: msg.sender,
            parentId: 0,
            status: Status.Open,
            createdAt: block.timestamp
        });
        emit TaskCreated(taskId, msg.sender);
    }

    /// @notice Delegates a subtask of `parentId` to `to`.
    /// @dev Caller must be the parent's creator or assignee, and the parent must
    ///      be Open or Accepted. `to` must hold an Agent ID; `to` does NOT need
    ///      a published profile. The new subtask starts Delegated.
    /// @param parentId Id of the task to delegate from.
    /// @param to Address of the holder receiving the delegation.
    /// @param title Short title of the subtask.
    /// @param description Longer description of the subtask.
    /// @return taskId The id of the new subtask.
    function delegateTask(
        uint256 parentId,
        address to,
        string calldata title,
        string calldata description
    ) external whenNotPaused returns (uint256 taskId) {
        _requireHolder(msg.sender);
        if (parentId == 0 || parentId >= _nextTaskId) {
            revert NotDelegatable();
        }
        Task storage parent = _tasks[parentId];
        if (msg.sender != parent.creator && msg.sender != parent.assignee) {
            revert NotCreator();
        }
        if (parent.status != Status.Open && parent.status != Status.Accepted) {
            revert NotDelegatable();
        }
        _requireHolder(to);
        taskId = _nextTaskId++;
        _tasks[taskId] = Task({
            id: taskId,
            title: title,
            description: description,
            creator: msg.sender,
            assignee: to,
            parentId: parentId,
            status: Status.Delegated,
            createdAt: block.timestamp
        });
        emit TaskDelegated(taskId, parentId, msg.sender, to);
    }

    /// @notice Accepts a delegation. Only the assignee, only while Delegated.
    /// @dev Holder-gated: the assignee must still hold an Agent ID to accept.
    /// @param taskId The delegated task id.
    function acceptDelegation(uint256 taskId) external whenNotPaused {
        _requireHolder(msg.sender);
        _requireTaskExists(taskId);
        Task storage task = _tasks[taskId];
        if (msg.sender != task.assignee) {
            revert NotAssignee();
        }
        if (task.status != Status.Delegated) {
            revert InvalidStatus();
        }
        task.status = Status.Accepted;
        emit DelegationAccepted(taskId, msg.sender);
    }

    /// @notice Accepts a delegation while staking reputation points (Round 5).
    /// @dev Same checks as acceptDelegation, plus a stake of 1-10 points.
    ///      The stake is recorded on-chain (no funds: points only) and the
    ///      frontend indexer scores it: completing returns the stake as
    ///      score, a cancel after acceptance burns it. Accepting without
    ///      a stake stays possible via acceptDelegation().
    /// @param taskId The delegated task id.
    /// @param stake Points staked (1-10).
    function acceptDelegationStaked(uint256 taskId, uint8 stake) external whenNotPaused {
        if (stake < 1 || stake > 10) {
            revert InvalidStake();
        }
        _requireHolder(msg.sender);
        _requireTaskExists(taskId);
        Task storage task = _tasks[taskId];
        if (msg.sender != task.assignee) {
            revert NotAssignee();
        }
        if (task.status != Status.Delegated) {
            revert InvalidStatus();
        }
        task.status = Status.Accepted;
        _stakes[taskId] = stake;
        emit DelegationAccepted(taskId, msg.sender);
        emit ReputationStaked(taskId, msg.sender, stake);
    }

    /// @notice Rejects a delegation. Only the assignee, only while Delegated.
    /// @dev Not holder-gated: declining needs no Agent ID (cleanup action).
    /// @param taskId The delegated task id.
    function rejectDelegation(uint256 taskId) external whenNotPaused {
        _requireTaskExists(taskId);
        Task storage task = _tasks[taskId];
        if (msg.sender != task.assignee) {
            revert NotAssignee();
        }
        if (task.status != Status.Delegated) {
            revert InvalidStatus();
        }
        task.status = Status.Rejected;
        emit DelegationRejected(taskId, msg.sender);
    }

    /// @notice Delegates a PRIVATE subtask of `parentId` to `to` (Round 5).
    /// @dev Same checks as delegateTask. Only the content HASH is stored
    ///      on-chain (keccak256 of the plaintext, computed client-side);
    ///      the plaintext itself is never published — the delegator shares
    ///      it off-chain with the assignee, who can verify it in the UI
    ///      by pasting it (the frontend hashes and compares). The task
    ///      description is left empty on purpose; the UI marks the task
    ///      private when its content hash is non-zero.
    /// @param parentId Id of the task to delegate from.
    /// @param to Address of the holder receiving the delegation.
    /// @param title Short title of the subtask (public).
    /// @param contentHash keccak256 hash of the private plaintext.
    /// @return taskId The id of the new subtask.
    function delegateTaskPrivate(
        uint256 parentId,
        address to,
        string calldata title,
        bytes32 contentHash
    ) external whenNotPaused returns (uint256 taskId) {
        _requireHolder(msg.sender);
        if (parentId == 0 || parentId >= _nextTaskId) {
            revert NotDelegatable();
        }
        Task storage parent = _tasks[parentId];
        if (msg.sender != parent.creator && msg.sender != parent.assignee) {
            revert NotCreator();
        }
        if (parent.status != Status.Open && parent.status != Status.Accepted) {
            revert NotDelegatable();
        }
        _requireHolder(to);
        taskId = _nextTaskId++;
        _tasks[taskId] = Task({
            id: taskId,
            title: title,
            description: "",
            creator: msg.sender,
            assignee: to,
            parentId: parentId,
            status: Status.Delegated,
            createdAt: block.timestamp
        });
        _contentHashes[taskId] = contentHash;
        emit TaskDelegated(taskId, parentId, msg.sender, to);
    }

    /// @notice Marks an accepted task complete. Only the assignee, only while Accepted.
    /// @dev Not holder-gated. Completing a subtask does NOT change the parent
    ///      task's status (documented v1 limit).
    /// @param taskId The task id.
    function completeTask(uint256 taskId) external whenNotPaused {
        _requireTaskExists(taskId);
        Task storage task = _tasks[taskId];
        if (msg.sender != task.assignee) {
            revert NotAssignee();
        }
        if (task.status != Status.Accepted) {
            revert InvalidStatus();
        }
        task.status = Status.Completed;
        emit TaskCompleted(taskId, msg.sender);
    }

    /// @notice Attests the work quality of a completed task (Round 5).
    /// @dev Only the task's creator (the delegator), only while Completed,
    ///      score 1-5, once per task. The score counts toward the assignee's
    ///      reputation: +(stars-3)x2 in the frontend indexer.
    /// @param taskId The completed task id.
    /// @param score Stars, 1-5.
    function attestQuality(uint256 taskId, uint8 score) external whenNotPaused {
        if (score < 1 || score > 5) {
            revert InvalidScore();
        }
        _requireTaskExists(taskId);
        Task storage task = _tasks[taskId];
        if (msg.sender != task.creator) {
            revert NotCreator();
        }
        if (task.status != Status.Completed) {
            revert InvalidStatus();
        }
        if (_qualityAttestations[taskId].exists) {
            revert AlreadyAttested();
        }
        _qualityAttestations[taskId] = Attestation({
            exists: true,
            score: score,
            attester: msg.sender,
            createdAt: block.timestamp
        });
        emit QualityAttested(taskId, msg.sender, task.assignee, score);
    }

    /// @notice Attests the brief clarity of a completed task (Round 5).
    /// @dev Only the task's assignee, only while Completed, score 1-5,
    ///      once per task. The score counts toward the creator's reputation:
    ///      +(stars-3)x2 in the frontend indexer.
    /// @param taskId The completed task id.
    /// @param score Stars, 1-5.
    function attestBrief(uint256 taskId, uint8 score) external whenNotPaused {
        if (score < 1 || score > 5) {
            revert InvalidScore();
        }
        _requireTaskExists(taskId);
        Task storage task = _tasks[taskId];
        if (msg.sender != task.assignee) {
            revert NotAssignee();
        }
        if (task.status != Status.Completed) {
            revert InvalidStatus();
        }
        if (_briefAttestations[taskId].exists) {
            revert AlreadyAttested();
        }
        _briefAttestations[taskId] = Attestation({
            exists: true,
            score: score,
            attester: msg.sender,
            createdAt: block.timestamp
        });
        emit BriefAttested(taskId, msg.sender, task.creator, score);
    }

    /// @notice Cancels a task. Only the creator, any time before it is Completed.
    /// @dev Also reverts when already Cancelled. Cancelling a subtask does not
    ///      affect its parent or its own subtasks.
    /// @param taskId The task id.
    function cancelTask(uint256 taskId) external whenNotPaused {
        _requireTaskExists(taskId);
        Task storage task = _tasks[taskId];
        if (msg.sender != task.creator) {
            revert NotCreator();
        }
        if (task.status == Status.Completed || task.status == Status.Cancelled) {
            revert InvalidStatus();
        }
        task.status = Status.Cancelled;
        emit TaskCancelled(taskId, msg.sender);
    }

    /// @notice Pauses all state-changing functions. Owner only.
    /// @dev Use to halt the directory and delegation in an emergency. Reads
    ///      (getters) keep working while paused.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpauses the contract. Owner only.
    function unpause() external onlyOwner {
        _unpause();
    }
}
