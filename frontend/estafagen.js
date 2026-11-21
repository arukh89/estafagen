/**
 * EstafAgen — shared contract client (frontend logic, no DOM).
 *
 * Used by BOTH:
 *  - the browser UI (frontend/app.js), loaded after the ethers v6 UMD build
 *    from the CDN, where `window.ethers` is the global;
 *  - the local integration test (scripts/integration-test.js), loaded via
 *    require() in Node, where ethers comes from node_modules.
 *
 * UMD wrapper: in Node, `module.exports = factory(require('ethers'))`;
 * in the browser, `window.EstafAgen = factory(window.ethers)`.
 *
 * The client never touches the DOM and never asks the user to sign anything
 * except through an explicit write call made by the UI. Reads use a provider;
 * writes take an ethers Signer.
 *
 * Compliance note: the directory is discovered ONLY from ProfilePublished
 * events (self-published, opt-in entries). There is no name->address lookup
 * for holders who never published a profile. The `.ai` name shown for a
 * profile is self-declared by its publisher, not read from the registry;
 * the holder address is always shown next to it.
 */

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('ethers'));
    } else {
        root.EstafAgen = factory(root.ethers);
    }
})(typeof self !== 'undefined' ? self : this, function (ethers) {
    'use strict';

    // ------------------------------------------------------------------
    // ABI (human-readable, copied from contracts/EstafAgen.sol)
    // ------------------------------------------------------------------
    var ESTAFAGEN_ABI = [
        // Custom errors (declared so ethers decodes reverts by name —
        // explainError() matches on these names; without them a revert
        // would surface only as an opaque hex blob).
        'error NotAgentIdHolder()',
        'error NotAssignee()',
        'error NotCreator()',
        'error InvalidStatus()',
        'error NotDelegatable()',
        'error InvalidRegistryAddress()',
        'error AlreadyAttested()',
        'error InvalidScore()',
        'error InvalidStake()',
        'error InvalidAvailability()',
        // Views
        'function isHolder(address account) view returns (bool)',
        'function taskCount() view returns (uint256)',
        'function getProfile(address holder) view returns (tuple(bool exists, string name, string capabilities, string description))',
        'function getProfileExtras(address holder) view returns (tuple(uint8 availability, string capacityNote, string guild, string agentCardUrl, string agentCardSignature, uint256 lastUpdated))',
        'function hasProfile(address holder) view returns (bool)',
        'function getTask(uint256 taskId) view returns (tuple(uint256 id, string title, string description, address creator, address assignee, uint256 parentId, uint8 status, uint256 createdAt))',
        'function getQualityAttestation(uint256 taskId) view returns (tuple(bool exists, uint8 score, address attester, uint256 createdAt))',
        'function getBriefAttestation(uint256 taskId) view returns (tuple(bool exists, uint8 score, address attester, uint256 createdAt))',
        'function getStake(uint256 taskId) view returns (uint8)',
        'function getTaskContentHash(uint256 taskId) view returns (bytes32)',
        'function paused() view returns (bool)',
        // Writes
        'function publishProfile(string name, string capabilities, string description)',
        'function removeProfile()',
        'function setProfileExtras(uint8 availability, string capacityNote, string guild, string agentCardUrl, string agentCardSignature)',
        'function renewProfile()',
        'function createTask(string title, string description) returns (uint256)',
        'function delegateTask(uint256 parentId, address to, string title, string description) returns (uint256)',
        'function delegateTaskPrivate(uint256 parentId, address to, string title, bytes32 contentHash) returns (uint256)',
        'function acceptDelegation(uint256 taskId)',
        'function acceptDelegationStaked(uint256 taskId, uint8 stake)',
        'function rejectDelegation(uint256 taskId)',
        'function completeTask(uint256 taskId)',
        'function cancelTask(uint256 taskId)',
        'function attestQuality(uint256 taskId, uint8 score)',
        'function attestBrief(uint256 taskId, uint8 score)',
        // Events
        'event ProfilePublished(address indexed holder, string name)',
        'event ProfileRemoved(address indexed holder)',
        'event ProfileExtrasUpdated(address indexed holder)',
        'event ProfileRenewed(address indexed holder, uint256 timestamp)',
        'event TaskCreated(uint256 indexed taskId, address indexed creator)',
        'event TaskDelegated(uint256 indexed taskId, uint256 indexed parentId, address indexed delegator, address assignee)',
        'event DelegationAccepted(uint256 indexed taskId, address indexed assignee)',
        'event DelegationRejected(uint256 indexed taskId, address indexed assignee)',
        'event TaskCompleted(uint256 indexed taskId, address indexed assignee)',
        'event TaskCancelled(uint256 indexed taskId, address indexed creator)',
        'event QualityAttested(uint256 indexed taskId, address indexed attester, address indexed assignee, uint8 score)',
        'event BriefAttested(uint256 indexed taskId, address indexed attester, address indexed creator, uint8 score)',
        'event ReputationStaked(uint256 indexed taskId, address indexed assignee, uint8 stake)',
    ];

    // Task statuses, in contract enum order (EstafAgen.Status).
    // NOTE (Round 2 design): a root task can NEVER become Completed — roots
    // start Open and completeTask() only accepts Accepted subtasks. The UI
    // must therefore never offer "complete" on a root task; roots are
    // ongoing containers whose subtasks get completed.
    var STATUS = ['Open', 'Delegated', 'Accepted', 'Completed', 'Rejected', 'Cancelled'];
    var STATUS_LABEL_ID = {
        Open: 'Open',
        Delegated: 'Delegated',
        Accepted: 'Accepted',
        Completed: 'Completed',
        Rejected: 'Rejected',
        Cancelled: 'Cancelled',
    };

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function shortAddress(addr) {
        if (!addr || typeof addr !== 'string' || addr.length < 10) return addr || '';
        return addr.slice(0, 6) + '…' + addr.slice(-4);
    }

    function isAddress(value) {
        try {
            return ethers.isAddress(value);
        } catch (e) {
            return false;
        }
    }

    function normalizeTask(raw) {
        return {
            id: Number(raw.id),
            title: raw.title,
            description: raw.description,
            creator: raw.creator,
            assignee: raw.assignee,
            parentId: Number(raw.parentId),
            status: Number(raw.status),
            statusName: STATUS[Number(raw.status)],
            statusLabel: STATUS_LABEL_ID[STATUS[Number(raw.status)]],
            createdAt: Number(raw.createdAt),
            isRoot: Number(raw.parentId) === 0,
        };
    }

    function normalizeProfile(holder, raw) {
        return {
            holder: holder,
            exists: !!raw.exists,
            name: raw.name,
            capabilities: raw.capabilities,
            description: raw.description,
        };
    }

    // Availability states for profile extras (Round 5): 0 unspecified,
    // 1 available, 2 busy.
    var AVAILABILITY = ['Unspecified', 'Available', 'Busy'];
    var AVAILABILITY_LABEL = {
        Unspecified: 'Availability not set',
        Available: 'Available',
        Busy: 'Busy',
    };

    function normalizeProfileExtras(holder, raw) {
        return {
            holder: holder,
            availability: Number(raw.availability),
            availabilityName: AVAILABILITY[Number(raw.availability)] || 'Unspecified',
            availabilityLabel: AVAILABILITY_LABEL[AVAILABILITY[Number(raw.availability)] || 'Unspecified'],
            capacityNote: raw.capacityNote,
            guild: raw.guild,
            agentCardUrl: raw.agentCardUrl,
            agentCardSignature: raw.agentCardSignature,
            lastUpdated: Number(raw.lastUpdated),
        };
    }

    function normalizeAttestation(raw) {
        return {
            exists: !!raw.exists,
            score: Number(raw.score),
            attester: raw.attester,
            createdAt: Number(raw.createdAt),
        };
    }

    // ------------------------------------------------------------------
    // Reputation (Round 5) — computed CLIENT-SIDE from on-chain events.
    // There is no server: the browser is the indexer. Every score is
    // verifiable by replaying the same events.
    //
    // Score (points, floored at 0, no cap):
    //   +10  per delegation completed (to the assignee)
    //   +(stars-3)x2 per quality attestation received (to the assignee)
    //   +(stars-3)x2 per brief attestation received (to the creator)
    //   +stake on a staked completion (stake recorded at accept, 1-10)
    //   -stake when a staked task is cancelled after acceptance
    //   -2  when a task is cancelled after acceptance with no stake
    //   0   for a rejected delegation (declining is legitimate)
    //   0   for a cancel before acceptance
    // Levels: 0-9 Newcomer, 10-29 Rising, 30-99 Trusted, 100+ Elite.
    // ------------------------------------------------------------------
    var REPUTATION_POINTS_PER_COMPLETION = 10;
    var REPUTATION_CANCEL_NO_STAKE_PENALTY = 2;

    function reputationLevel(score) {
        if (score >= 100) return 'Elite';
        if (score >= 30) return 'Trusted';
        if (score >= 10) return 'Rising';
        return 'Newcomer';
    }

    function emptyReputation(holder) {
        return {
            holder: holder,
            score: 0,
            level: 'Newcomer',
            completed: 0,
            delegatedTo: 0,
            accepted: 0,
            rejected: 0,
            cancelledAfterAccept: 0,
            stakedCompleted: 0,
            stakedBurned: 0,
            qualityReceived: [],
            briefReceived: [],
            qualityAvg: null,
            briefAvg: null,
        };
    }

    // ------------------------------------------------------------------
    // Agent Card verification (Round 5).
    // The badge means: the holder proved wallet ownership of the URL
    // (their signature over the verification message recovers to their
    // address) AND the card parsed as an A2A Agent Card at verification
    // time. The signature lives on-chain in the profile extras, so the
    // badge can be checked WITHOUT fetching anything — directory listings
    // never auto-fetch arbitrary URLs (phishing vector).
    // ------------------------------------------------------------------
    function agentCardMessage(url) {
        return 'EstafAgen agent-card verification\n' + url;
    }

    // Recovers the signer of `signature` over agentCardMessage(url).
    // Returns true only when it equals `holder`. Pure function — no fetch.
    function verifyAgentCardSignature(holder, url, signature) {
        try {
            if (!holder || !url || !signature) return false;
            var recovered = ethers.verifyMessage(agentCardMessage(url), signature);
            return recovered.toLowerCase() === String(holder).toLowerCase();
        } catch (e) {
            return false;
        }
    }

    // Checks an already-fetched Agent Card JSON against the A2A shape:
    // a non-empty `name` and a non-empty `skills` array whose entries
    // have a `name`. Returns { ok, reasons } — never throws.
    function verifyAgentCardShape(card) {
        var reasons = [];
        if (!card || typeof card !== 'object' || Array.isArray(card)) {
            return { ok: false, reasons: ['Card is not a JSON object.'] };
        }
        if (typeof card.name !== 'string' || !card.name.trim()) {
            reasons.push('Card has no name.');
        }
        if (!Array.isArray(card.skills) || card.skills.length === 0) {
            reasons.push('Card has no skills list.');
        } else if (card.skills.some(function (sk) { return !sk || typeof sk.name !== 'string' || !sk.name.trim(); })) {
            reasons.push('Every skill needs a name.');
        }
        return { ok: reasons.length === 0, reasons: reasons };
    }

    // Fetches an Agent Card URL and validates its shape. Client-side only,
    // called explicitly by the holder in their own profile edit flow (or
    // by a user pressing "Verify" on one profile) — never automatically
    // for directory listings. Throws on network/CORS/parse failure; the
    // caller turns that into a plain message (many servers do not send
    // CORS headers, so a fetch failure does NOT prove the card is fake).
    async function fetchAgentCard(url) {
        var res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('Agent Card fetch failed (HTTP ' + res.status + ').');
        var card = await res.json();
        var check = verifyAgentCardShape(card);
        if (!check.ok) throw new Error('Not an A2A Agent Card: ' + check.reasons.join(' '));
        return card;
    }

    // Private-delegation hash scheme (Round 5): keccak256 of the UTF-8
    // plaintext. The delegator shares the plaintext off-chain; anyone
    // with it can recompute the hash and compare with the on-chain value.
    function contentHashFor(text) {
        return ethers.keccak256(ethers.toUtf8Bytes(text || ''));
    }

    // ------------------------------------------------------------------
    // English error explanations (never raw codes).
    // `err` is the error object thrown by ethers; `context` is one of
    // 'tx' (a sent transaction failed) or 'call' (a read / preflight failed).
    // Raw details are only written to the console by the caller, never shown.
    //
    // Decoding note (verified 22 Nov 2026, Round 3 integration test):
    // ethers v6 does NOT decode a custom error when the revert surfaces
    // from gas estimation — the error only carries the 4-byte selector
    // (e.g. data "0x09c7d30b" for NotAssignee()). So revertName() below
    // maps selectors to names itself (ethers.id(name + '()').slice(0, 10))
    // and also accepts a name ethers already decoded into reason/message.
    // ------------------------------------------------------------------
    var CUSTOM_ERRORS = [
        'NotAgentIdHolder',
        'NotAssignee',
        'NotCreator',
        'InvalidStatus',
        'NotDelegatable',
        'InvalidRegistryAddress',
        'AlreadyAttested',
        'InvalidScore',
        'InvalidStake',
        'InvalidAvailability',
    ];
    var ERROR_SELECTORS = {};
    CUSTOM_ERRORS.forEach(function (name) {
        ERROR_SELECTORS[ethers.id(name + '()').slice(0, 10).toLowerCase()] = name;
    });

    // Flatten every field an ethers v6 error may carry a decoded revert
    // name (or any other useful text) in. Single source of truth for
    // error-text assembly (F20): revertName(), explainError() and the
    // integration test all use this instead of their own copies.
    function flattenErrorText(err) {
        var parts = [];
        try {
            if (err) {
                if (err.reason) parts.push(String(err.reason));
                if (err.message) parts.push(String(err.message));
                if (err.code) parts.push(String(err.code));
                if (err.errorName) parts.push(String(err.errorName));
                if (err.data) parts.push(String(err.data));
                if (err.error) {
                    if (err.error.message) parts.push(String(err.error.message));
                    if (err.error.data) parts.push(String(err.error.data));
                }
            }
        } catch (e) { /* ignore */ }
        return parts.join(' ');
    }

    // Returns the contract custom-error name for a revert, or null.
    function revertName(err) {
        if (err && err.errorName) return err.errorName;
        var text = flattenErrorText(err);
        var i, j;
        for (i = 0; i < CUSTOM_ERRORS.length; i++) {
            if (text.indexOf(CUSTOM_ERRORS[i]) !== -1) return CUSTOM_ERRORS[i];
        }
        var m = text.match(/0x[0-9a-fA-F]{8}\b/g);
        if (m) {
            for (j = 0; j < m.length; j++) {
                var name = ERROR_SELECTORS[m[j].toLowerCase()];
                if (name) return name;
            }
        }
        return null;
    }

    function explainError(err, context, faucetUrl) {
        var text = flattenErrorText(err);

        // 1. User rejected the signature in their wallet.
        if (
            (err && (err.code === 4001 || err.code === 'ACTION_REJECTED')) ||
            /user rejected|user denied|ACTION_REJECTED/i.test(text)
        ) {
            return 'Cancelled. No funds moved.';
        }

        // 2. Contract custom errors (matched by name, decoded from the
        //    revert selector when ethers did not decode it itself).
        var name = revertName(err);
        if (name === 'NotAgentIdHolder') {
            return 'This address does not hold an Agent ID yet. Claim an Agent ID first in the Binance app (Wallet > Agent ID banner), then try again.';
        }
        if (name === 'NotAssignee') {
            return 'Only the assignee of this task can take that step.';
        }
        if (name === 'NotCreator') {
            return 'Only the creator of this task can take that step.';
        }
        if (name === 'NotDelegatable') {
            return 'This task can no longer be delegated (already completed, cancelled, rejected, or not yet accepted).';
        }
        if (name === 'InvalidStatus') {
            return 'This task is not in a status that allows that step.';
        }
        if (name === 'AlreadyAttested') {
            return 'This task has already been attested. Each task can only be attested once per side.';
        }
        if (name === 'InvalidScore') {
            return 'An attestation score must be between 1 and 5 stars.';
        }
        if (name === 'InvalidStake') {
            return 'A reputation stake must be between 1 and 10 points.';
        }
        if (name === 'InvalidAvailability') {
            return 'Availability must be unspecified, available, or busy.';
        }
        if (/EnforcedPause/i.test(text)) {
            return 'The contract is paused by the owner. Try again later.';
        }
        if (/OwnableUnauthorizedAccount/i.test(text)) {
            return 'This address does not have permission for that step.';
        }

        // 3. Out of gas money (testnet tBNB / mainnet BNB).
        if (/insufficient funds|INSUFFICIENT_FUNDS/i.test(text)) {
            var faucet = faucetUrl
                ? ' Claim free tBNB from the official faucet (' + faucetUrl + '), then try again.'
                : ' Claim free tBNB from the official faucet, then try again.';
            return 'Insufficient balance for gas fees.' + faucet;
        }

        // 4. Network / provider problems.
        if (
            (err && (err.code === 'NETWORK_ERROR' || err.code === 'TIMEOUT' || err.code === 'SERVER_ERROR')) ||
            /could not detect network|network error|timeout|timed out|failed to fetch|ECONNREFUSED|getaddrinfo/i.test(text)
        ) {
            return 'Failed to connect to the network. Check your connection, then try again.';
        }

        // 5. Wrong network usually surfaces as a call failure on an address
        // with no code; keep the message generic but actionable.
        if (context === 'call') {
            return 'Could not read contract data. Make sure the selected network is correct, then try again.';
        }
        return 'Transaction failed. No funds moved. Try again.';
    }

    // ------------------------------------------------------------------
    // Client factory
    // ------------------------------------------------------------------
    function createClient(provider, addresses) {
        if (!provider) throw new Error('provider is required');
        if (!addresses || !addresses.estafagen) {
            throw new Error('estafagen contract address is required');
        }
        var readContract = new ethers.Contract(addresses.estafagen, ESTAFAGEN_ABI, provider);
        var registryAddress = addresses.registry || null;

        function withSigner(signer) {
            return readContract.connect(signer);
        }

        // -- reads ------------------------------------------------------
        async function isHolder(account) {
            return await readContract.isHolder(account);
        }

        async function isPaused() {
            return await readContract.paused();
        }

        async function getProfile(holder) {
            var raw = await readContract.getProfile(holder);
            return normalizeProfile(holder, raw);
        }

        async function getProfileExtras(holder) {
            var raw = await readContract.getProfileExtras(holder);
            return normalizeProfileExtras(holder, raw);
        }

        // Fail-soft variant of getProfileExtras: deployments that predate
        // the Round 5 contract have no such function — the eth_call
        // fails to decode, and the caller gets default (empty) extras
        // instead of an error, so the basic directory keeps working
        // against an old deployment until the contract is redeployed.
        async function getProfileExtrasOrDefault(holder) {
            try {
                return await getProfileExtras(holder);
            } catch (e) {
                return normalizeProfileExtras(holder, {
                    availability: 0,
                    capacityNote: '',
                    guild: '',
                    agentCardUrl: '',
                    agentCardSignature: '',
                    lastUpdated: 0,
                });
            }
        }

        async function hasProfile(holder) {
            return await readContract.hasProfile(holder);
        }

        async function getTask(taskId) {
            var raw = await readContract.getTask(taskId);
            return normalizeTask(raw);
        }

        async function getTaskCount() {
            return Number(await readContract.taskCount());
        }

        async function getQualityAttestation(taskId) {
            var raw = await readContract.getQualityAttestation(taskId);
            return normalizeAttestation(raw);
        }

        async function getBriefAttestation(taskId) {
            var raw = await readContract.getBriefAttestation(taskId);
            return normalizeAttestation(raw);
        }

        // Fail-soft variants (see getProfileExtrasOrDefault): return
        // "never attested" when the deployment predates Round 5.
        async function getQualityAttestationOrDefault(taskId) {
            try {
                return await getQualityAttestation(taskId);
            } catch (e) {
                return { exists: false, score: 0, attester: ethers.ZeroAddress, createdAt: 0 };
            }
        }

        async function getBriefAttestationOrDefault(taskId) {
            try {
                return await getBriefAttestation(taskId);
            } catch (e) {
                return { exists: false, score: 0, attester: ethers.ZeroAddress, createdAt: 0 };
            }
        }

        async function getStake(taskId) {
            return Number(await readContract.getStake(taskId));
        }

        async function getTaskContentHash(taskId) {
            return await readContract.getTaskContentHash(taskId);
        }

        // True when the task has a non-zero content hash (private task).
        async function isPrivateTask(taskId) {
            var hash = await getTaskContentHash(taskId);
            return hash !== '0x' + '0'.repeat(64);
        }

        async function listTasks(limit) {
            var count = await getTaskCount();
            // Newest first, at most `limit` (default 100) — the old code
            // awaited one RPC call per task in sequence (F16).
            var max = (typeof limit === 'number' && limit > 0) ? limit : 100;
            var ids = [];
            for (var i = count; i >= Math.max(1, count - max + 1); i--) ids.push(i);
            var tasks = await Promise.all(ids.map(function (id) { return getTask(id); }));
            tasks.sort(function (a, b) { return b.id - a.id; });
            return tasks;
        }

        // Directory discovery: ONLY from self-published ProfilePublished
        // events. Holders who never published are invisible by design.
        //
        // The scan starts at `deployedFromBlock` (from config.js), NOT
        // block 0 (F5): on BSC Testnet block 0 means ~144M blocks and
        // public RPCs time out on a range that wide. Results are cached
        // in memory per client (one client per chain): a refresh only
        // scans events since the last scanned block and re-reads the
        // profiles of holders with a new event. The boundary block is
        // re-scanned on purpose, so an event landing in the same block
        // after our query is not missed; re-reads are idempotent.
        var deployedFromBlock = (addresses && typeof addresses.deployedFromBlock === 'number')
            ? addresses.deployedFromBlock
            : 0;
        var profileCache = {};         // holder address -> profile
        var profileCacheToBlock = null; // last block fully scanned, or null
        async function listProfiles() {
            var from = (profileCacheToBlock === null) ? deployedFromBlock : profileCacheToBlock;
            var published = await readContract.queryFilter(
                readContract.filters.ProfilePublished(),
                from,
                'latest'
            );
            var removed = await readContract.queryFilter(
                readContract.filters.ProfileRemoved(),
                from,
                'latest'
            );
            var maxBlock = null;
            published.concat(removed).forEach(function (ev) {
                if (maxBlock === null || ev.blockNumber > maxBlock) maxBlock = ev.blockNumber;
            });
            var holders = {};
            published.forEach(function (ev) { holders[ev.args.holder] = true; });
            removed.forEach(function (ev) { holders[ev.args.holder] = true; });
            var keys = Object.keys(holders);
            var fresh = await Promise.all(keys.map(function (h) { return getProfile(h); }));
            fresh.forEach(function (p) {
                if (p.exists) profileCache[p.holder] = p;
                else delete profileCache[p.holder];
            });
            if (maxBlock !== null) profileCacheToBlock = maxBlock;
            return Object.keys(profileCache).map(function (h) { return profileCache[h]; });
        }

        // Case-insensitive substring match over name + capabilities +
        // description. Empty query returns everything.
        async function searchProfiles(query) {
            var all = await listProfiles();
            var q = (query || '').trim().toLowerCase();
            if (!q) return all;
            return all.filter(function (p) {
                return (
                    (p.name || '').toLowerCase().indexOf(q) !== -1 ||
                    (p.capabilities || '').toLowerCase().indexOf(q) !== -1 ||
                    (p.description || '').toLowerCase().indexOf(q) !== -1
                );
            });
        }

        // -- reputation event log (Round 5) ------------------------------
        // Same incremental pattern as listProfiles (F5): scan from
        // deployedFromBlock, then only since the last scanned block.
        // Events are merged in (blockNumber, logIndex) order and deduped
        // by transaction hash + log index. The log is the single source
        // of truth for scores, provenance, swarm state, and analytics.
        var REPUTATION_EVENT_NAMES = [
            'TaskCreated',
            'TaskDelegated',
            'DelegationAccepted',
            'DelegationRejected',
            'TaskCompleted',
            'TaskCancelled',
            'QualityAttested',
            'BriefAttested',
            'ReputationStaked',
        ];
        var eventLog = [];              // merged, ordered event records
        var eventSeen = {};             // "txHash:logIndex" -> true
        var eventCacheToBlock = null;   // last block fully scanned, or null

        function eventKey(ev) {
            return ev.transactionHash + ':' + ev.index;
        }

        async function scanEvents() {
            var from = (eventCacheToBlock === null) ? deployedFromBlock : eventCacheToBlock;
            var perType = await Promise.all(REPUTATION_EVENT_NAMES.map(function (name) {
                return readContract.queryFilter(readContract.filters[name](), from, 'latest');
            }));
            var maxBlock = null;
            perType.forEach(function (list) {
                list.forEach(function (ev) {
                    if (maxBlock === null || ev.blockNumber > maxBlock) maxBlock = ev.blockNumber;
                    var key = eventKey(ev);
                    if (eventSeen[key]) return;
                    eventSeen[key] = true;
                    eventLog.push(ev);
                });
            });
            eventLog.sort(function (a, b) {
                return (a.blockNumber - b.blockNumber) || (a.index - b.index);
            });
            if (maxBlock !== null) eventCacheToBlock = maxBlock;
            return eventLog;
        }

        // Replays the event log into per-task state and per-address
        // reputation. Pure function of the log — anyone replaying the
        // same events gets the same scores.
        function replayReputation(log) {
            var tasks = {};   // taskId -> {creator, assignee, status, stake}
            var reps = {};    // address (lowercase) -> reputation object
            function rep(addr) {
                var key = String(addr).toLowerCase();
                if (!reps[key]) reps[key] = emptyReputation(addr);
                return reps[key];
            }
            log.forEach(function (ev) {
                var a = ev.args;
                var id;
                if (ev.fragment && ev.fragment.name === 'TaskDelegated') {
                    id = Number(a.taskId);
                    tasks[id] = {
                        creator: a.delegator,
                        assignee: a.assignee,
                        status: 'Delegated',
                        stake: 0,
                    };
                    rep(a.assignee).delegatedTo++;
                } else if (ev.fragment && ev.fragment.name === 'DelegationAccepted') {
                    id = Number(a.taskId);
                    if (tasks[id]) tasks[id].status = 'Accepted';
                    rep(a.assignee).accepted++;
                } else if (ev.fragment && ev.fragment.name === 'DelegationRejected') {
                    id = Number(a.taskId);
                    if (tasks[id]) tasks[id].status = 'Rejected';
                    rep(a.assignee).rejected++;
                } else if (ev.fragment && ev.fragment.name === 'TaskCompleted') {
                    id = Number(a.taskId);
                    var t = tasks[id];
                    if (t) {
                        t.status = 'Completed';
                        var r = rep(a.assignee);
                        r.completed++;
                        r.score += REPUTATION_POINTS_PER_COMPLETION;
                        if (t.stake > 0) {
                            r.score += t.stake;
                            r.stakedCompleted++;
                        }
                    }
                } else if (ev.fragment && ev.fragment.name === 'TaskCancelled') {
                    id = Number(a.taskId);
                    var tc = tasks[id];
                    if (tc) {
                        if (tc.status === 'Accepted') {
                            var rc = rep(tc.assignee);
                            rc.cancelledAfterAccept++;
                            if (tc.stake > 0) {
                                rc.score -= tc.stake;
                                rc.stakedBurned++;
                            } else {
                                rc.score -= REPUTATION_CANCEL_NO_STAKE_PENALTY;
                            }
                        }
                        tc.status = 'Cancelled';
                    }
                } else if (ev.fragment && ev.fragment.name === 'QualityAttested') {
                    rep(a.assignee).score += (Number(a.score) - 3) * 2;
                    rep(a.assignee).qualityReceived.push({
                        taskId: Number(a.taskId),
                        score: Number(a.score),
                        attester: a.attester,
                    });
                } else if (ev.fragment && ev.fragment.name === 'BriefAttested') {
                    rep(a.creator).score += (Number(a.score) - 3) * 2;
                    rep(a.creator).briefReceived.push({
                        taskId: Number(a.taskId),
                        score: Number(a.score),
                        attester: a.attester,
                    });
                } else if (ev.fragment && ev.fragment.name === 'ReputationStaked') {
                    id = Number(a.taskId);
                    if (tasks[id]) tasks[id].stake = Number(a.stake);
                }
            });
            Object.keys(reps).forEach(function (key) {
                var r = reps[key];
                if (r.score < 0) r.score = 0;
                r.level = reputationLevel(r.score);
                if (r.qualityReceived.length > 0) {
                    var qs = r.qualityReceived.reduce(function (s, x) { return s + x.score; }, 0);
                    r.qualityAvg = qs / r.qualityReceived.length;
                }
                if (r.briefReceived.length > 0) {
                    var bs = r.briefReceived.reduce(function (s, x) { return s + x.score; }, 0);
                    r.briefAvg = bs / r.briefReceived.length;
                }
            });
            return { tasks: tasks, reputations: reps };
        }

        // Reputation of one address (0 points, Newcomer, when no history).
        async function computeReputation(holder) {
            var log = await scanEvents();
            var replayed = replayReputation(log);
            var key = String(holder).toLowerCase();
            return replayed.reputations[key] || emptyReputation(holder);
        }

        // Reputation of every address with any history, best first.
        async function computeAllReputations() {
            var log = await scanEvents();
            var replayed = replayReputation(log);
            var all = Object.keys(replayed.reputations).map(function (k) { return replayed.reputations[k]; });
            all.sort(function (a, b) {
                return (b.score - a.score) || (b.completed - a.completed);
            });
            return all;
        }

        // Directory profiles enriched with extras + reputation, RANKED BY
        // SCORE (best first), not by self-claims. Ties break on completed
        // count, then name. Profiles without any history score 0.
        async function listProfilesRanked() {
            var profiles = await listProfiles();
            var log = await scanEvents();
            var replayed = replayReputation(log);
            var enriched = await Promise.all(profiles.map(async function (p) {
                var extras = await getProfileExtrasOrDefault(p.holder);
                var key = p.holder.toLowerCase();
                var rep = replayed.reputations[key] || emptyReputation(p.holder);
                var cardVerified = verifyAgentCardSignature(
                    p.holder, extras.agentCardUrl, extras.agentCardSignature
                );
                return {
                    profile: p,
                    extras: extras,
                    reputation: rep,
                    agentCardVerified: !!(extras.agentCardUrl && cardVerified),
                };
            }));
            enriched.sort(function (a, b) {
                return (b.reputation.score - a.reputation.score) ||
                    (b.reputation.completed - a.reputation.completed) ||
                    String(a.profile.name || '').localeCompare(String(b.profile.name || ''));
            });
            return enriched;
        }

        // Agent CV: a public resume built from on-chain history.
        // profile + extras + reputation + completed tasks (with titles)
        // + attestations received and given + full task history.
        async function getAgentCV(holder) {
            var profile = await getProfile(holder);
            var extras = await getProfileExtrasOrDefault(holder);
            var rep = await computeReputation(holder);
            var log = await scanEvents();
            var replayed = replayReputation(log);
            var completedIds = [];
            var historyIds = [];
            Object.keys(replayed.tasks).forEach(function (id) {
                var t = replayed.tasks[id];
                if (t.assignee && String(t.assignee).toLowerCase() === String(holder).toLowerCase()) {
                    historyIds.push(Number(id));
                    if (t.status === 'Completed') completedIds.push(Number(id));
                }
                if (t.creator && String(t.creator).toLowerCase() === String(holder).toLowerCase() &&
                    historyIds.indexOf(Number(id)) === -1) {
                    historyIds.push(Number(id));
                }
            });
            // Cap on-chain reads: newest 20 completed / 20 history
            // tasks, so a long history never stalls the page.
            var completedTasks = await Promise.all(completedIds.slice(-20).map(function (id) { return getTask(id); }));
            var historyTasks = await Promise.all(historyIds.slice(-20).map(function (id) { return getTask(id); }));
            historyTasks.sort(function (a, b) { return b.id - a.id; });
            return {
                profile: profile,
                extras: extras,
                reputation: rep,
                agentCardVerified: !!(extras.agentCardUrl &&
                    verifyAgentCardSignature(holder, extras.agentCardUrl, extras.agentCardSignature)),
                completedTasks: completedTasks,
                historyTasks: historyTasks,
            };
        }

        // Provenance tree: pre-order walk from `rootId` over the task
        // parent/child links. Returns [{ task, depth }] — depth 0 is the
        // root. Built from the current task list (max 100 newest), so
        // very old chains may be cut off; the chain viewer says so.
        async function getProvenance(rootId) {
            var tasks = await listTasks(100);
            var byId = {};
            var children = {};
            tasks.forEach(function (t) {
                byId[t.id] = t;
                if (t.parentId !== 0) {
                    if (!children[t.parentId]) children[t.parentId] = [];
                    children[t.parentId].push(t.id);
                }
            });
            var out = [];
            var guard = 0;
            function walk(id, depth) {
                if (!byId[id] || guard++ > 200) return;
                out.push({ task: byId[id], depth: depth });
                (children[id] || []).sort(function (a, b) { return a - b; }).forEach(function (cid) {
                    walk(cid, depth + 1);
                });
            }
            walk(Number(rootId), 0);
            return out;
        }

        // Swarm view: all direct subtasks of a root task, with status
        // counts and a completion percentage. Delegation itself stays
        // one transaction per assignee (the user confirms each).
        async function getSwarm(rootId) {
            var tasks = await listTasks(100);
            var kids = tasks.filter(function (t) { return t.parentId === Number(rootId); });
            var counts = { Open: 0, Delegated: 0, Accepted: 0, Completed: 0, Rejected: 0, Cancelled: 0 };
            kids.forEach(function (t) { counts[t.statusName] = (counts[t.statusName] || 0) + 1; });
            var total = kids.length;
            var done = counts.Completed;
            return {
                rootId: Number(rootId),
                children: kids,
                counts: counts,
                total: total,
                completed: done,
                progressPct: total === 0 ? 0 : Math.round((done / total) * 100),
            };
        }

        // Public analytics, computed from events + profiles + tasks.
        // No server: the browser computes this on refresh.
        async function computeAnalytics() {
            var profiles = await listProfiles();
            var log = await scanEvents();
            var replayed = replayReputation(log);
            var tasks = await listTasks(100);
            var total = await getTaskCount();
            var delegations = 0;
            var completed = 0;
            var decided = 0;
            var recentCutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
            var recentDelegations = 0;
            tasks.forEach(function (t) {
                if (!t.isRoot) {
                    delegations++;
                    if (t.createdAt >= recentCutoff) recentDelegations++;
                }
                if (t.statusName === 'Completed') completed++;
                if (t.statusName === 'Completed' || t.statusName === 'Rejected' || t.statusName === 'Cancelled') decided++;
            });
            var capCounts = {};
            profiles.forEach(function (p) {
                (p.capabilities || '').split(',').forEach(function (c) {
                    var cap = c.trim().toLowerCase();
                    if (!cap) return;
                    capCounts[cap] = (capCounts[cap] || 0) + 1;
                });
            });
            var topCapabilities = Object.keys(capCounts).map(function (c) {
                return { capability: c, count: capCounts[c] };
            }).sort(function (a, b) { return b.count - a.count; }).slice(0, 5);
            var allReps = await computeAllReputations();
            var topAgents = allReps.slice(0, 5);
            // Guilds are free-text labels on profiles (no separate
            // contract): aggregate member count + average score per guild.
            var guilds = {};
            var extrasList = await Promise.all(profiles.map(function (p) { return getProfileExtrasOrDefault(p.holder); }));
            extrasList.forEach(function (x, i) {
                var g = (x.guild || '').trim();
                if (!g) return;
                if (!guilds[g]) guilds[g] = { guild: g, members: 0, totalScore: 0 };
                var key = profiles[i].holder.toLowerCase();
                var rep = replayed.reputations[key];
                guilds[g].members++;
                guilds[g].totalScore += rep ? rep.score : 0;
            });
            var guildList = Object.keys(guilds).map(function (g) {
                return {
                    guild: g,
                    members: guilds[g].members,
                    avgScore: guilds[g].members ? Math.round(guilds[g].totalScore / guilds[g].members) : 0,
                };
            }).sort(function (a, b) { return (b.members - a.members) || (b.avgScore - a.avgScore); });
            return {
                profiles: profiles.length,
                tasks: total,
                delegations: delegations,
                completed: completed,
                completionRate: decided === 0 ? null : Math.round((completed / decided) * 100),
                recentDelegations7d: recentDelegations,
                topCapabilities: topCapabilities,
                topAgents: topAgents,
                guilds: guildList,
            };
        }

        // Walk parentId from `taskId` up to the root. Returns leaf-first:
        // [task, parent, grandparent, ..., root].
        async function getChain(taskId) {
            var chain = [];
            var current = Number(taskId);
            var guard = 0;
            while (current !== 0 && guard < 50) {
                var task = await getTask(current);
                chain.push(task);
                current = task.parentId;
                guard++;
            }
            return chain;
        }

        // -- writes (each returns the mined receipt) --------------------
        // `onStage` is an optional progress callback used by the UI:
        //   2 = waiting for the user to confirm in their wallet,
        //   3 = waiting for the network (tx hash known),
        //   4 = mined (receipt known).
        async function waitTx(txPromise, onStage) {
            if (onStage) onStage(2);
            var tx = await txPromise;
            if (onStage) onStage(3, tx.hash);
            var receipt = await tx.wait();
            if (onStage) onStage(4, receipt);
            // Read-after-write visibility (verified 2026-11-22 on the
            // local Hardhat node, and possible on load-balanced public
            // RPCs too): right after tx.wait() returns, eth_blockNumber
            // can still report the PREVIOUS block and eth_getLogs with
            // a nonzero fromBlock can miss the receipt's events for a
            // moment — while eth_call already sees the new state and
            // eth_getLogs from block 0 already finds the event. The
            // incremental scanners (listProfiles, scanEvents) read
            // events, so a read immediately after a write could miss
            // the write's effects (e.g. a removed profile still listed
            // until the next refresh). Do not return until the chain
            // tip has caught up to the receipt's block; bounded at
            // ~10 s so a lagging endpoint never hangs the UI.
            var target = receipt.blockNumber;
            for (var i = 0; i < 50; i++) {
                var tip = await provider.getBlockNumber();
                if (tip >= target) break;
                await new Promise(function (r) { setTimeout(r, 200); });
            }
            return receipt;
        }

        async function publishProfile(signer, name, capabilities, description, onStage) {
            return await waitTx(withSigner(signer).publishProfile(name, capabilities, description), onStage);
        }

        async function removeProfile(signer, onStage) {
            return await waitTx(withSigner(signer).removeProfile(), onStage);
        }

        async function setProfileExtras(signer, availability, capacityNote, guild, agentCardUrl, agentCardSignature, onStage) {
            return await waitTx(
                withSigner(signer).setProfileExtras(availability, capacityNote, guild, agentCardUrl, agentCardSignature),
                onStage
            );
        }

        async function renewProfile(signer, onStage) {
            return await waitTx(withSigner(signer).renewProfile(), onStage);
        }

        async function createTask(signer, title, description, onStage) {
            return await waitTx(withSigner(signer).createTask(title, description), onStage);
        }

        async function delegateTask(signer, parentId, to, title, description, onStage) {
            return await waitTx(withSigner(signer).delegateTask(parentId, to, title, description), onStage);
        }

        async function delegateTaskPrivate(signer, parentId, to, title, contentHash, onStage) {
            return await waitTx(withSigner(signer).delegateTaskPrivate(parentId, to, title, contentHash), onStage);
        }

        async function acceptDelegation(signer, taskId, onStage) {
            return await waitTx(withSigner(signer).acceptDelegation(taskId), onStage);
        }

        async function acceptDelegationStaked(signer, taskId, stake, onStage) {
            return await waitTx(withSigner(signer).acceptDelegationStaked(taskId, stake), onStage);
        }

        async function rejectDelegation(signer, taskId, onStage) {
            return await waitTx(withSigner(signer).rejectDelegation(taskId), onStage);
        }

        async function completeTask(signer, taskId, onStage) {
            return await waitTx(withSigner(signer).completeTask(taskId), onStage);
        }

        async function cancelTask(signer, taskId, onStage) {
            return await waitTx(withSigner(signer).cancelTask(taskId), onStage);
        }

        async function attestQuality(signer, taskId, score, onStage) {
            return await waitTx(withSigner(signer).attestQuality(taskId, score), onStage);
        }

        async function attestBrief(signer, taskId, score, onStage) {
            return await waitTx(withSigner(signer).attestBrief(taskId, score), onStage);
        }

        return {
            addresses: { estafagen: addresses.estafagen, registry: registryAddress },
            contract: readContract,
            isHolder: isHolder,
            isPaused: isPaused,
            getProfile: getProfile,
            getProfileExtras: getProfileExtras,
            getProfileExtrasOrDefault: getProfileExtrasOrDefault,
            hasProfile: hasProfile,
            listProfiles: listProfiles,
            listProfilesRanked: listProfilesRanked,
            searchProfiles: searchProfiles,
            getAgentCV: getAgentCV,
            getTask: getTask,
            getTaskCount: getTaskCount,
            listTasks: listTasks,
            getChain: getChain,
            getProvenance: getProvenance,
            getSwarm: getSwarm,
            computeReputation: computeReputation,
            computeAllReputations: computeAllReputations,
            computeAnalytics: computeAnalytics,
            getQualityAttestation: getQualityAttestation,
            getQualityAttestationOrDefault: getQualityAttestationOrDefault,
            getBriefAttestation: getBriefAttestation,
            getBriefAttestationOrDefault: getBriefAttestationOrDefault,
            getStake: getStake,
            getTaskContentHash: getTaskContentHash,
            isPrivateTask: isPrivateTask,
            publishProfile: publishProfile,
            removeProfile: removeProfile,
            setProfileExtras: setProfileExtras,
            renewProfile: renewProfile,
            createTask: createTask,
            delegateTask: delegateTask,
            delegateTaskPrivate: delegateTaskPrivate,
            acceptDelegation: acceptDelegation,
            acceptDelegationStaked: acceptDelegationStaked,
            rejectDelegation: rejectDelegation,
            completeTask: completeTask,
            cancelTask: cancelTask,
            attestQuality: attestQuality,
            attestBrief: attestBrief,
        };
    }

    return {
        ABI: ESTAFAGEN_ABI,
        STATUS: STATUS,
        STATUS_LABEL_ID: STATUS_LABEL_ID,
        AVAILABILITY: AVAILABILITY,
        AVAILABILITY_LABEL: AVAILABILITY_LABEL,
        reputationLevel: reputationLevel,
        contentHashFor: contentHashFor,
        agentCardMessage: agentCardMessage,
        verifyAgentCardSignature: verifyAgentCardSignature,
        verifyAgentCardShape: verifyAgentCardShape,
        fetchAgentCard: fetchAgentCard,
        shortAddress: shortAddress,
        isAddress: isAddress,
        explainError: explainError,
        revertName: revertName,
        flattenErrorText: flattenErrorText,
        createClient: createClient,
    };
});
