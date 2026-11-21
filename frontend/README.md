# EstafAgen — Frontend (Rounds 3–4.6, extended in Round 5)

A static page, no framework/build step. `ethers` v6 is loaded from a CDN
(pinned 6.17.0, same version as in `node_modules`) with SRI + a fallback
to a second CDN; if both fail, the page shows a clear message
(instead of dying silently).

## Files

```
frontend/
  index.html      Page structure (mobile-first, one column)
  styles.css      Styling
  config.js       Contract addresses per chain (97/56 filled in Rounds 4/5)
  estafagen.js    Contract client — used by the UI AND the integration test (UMD)
  app.js          DOM wiring (connect, directory, profile, tasks, chain)
  local-config.json  (written by scripts/deploy-local.js — local only,
                      DO NOT commit; localhost addresses only)
```

## How it works

- **Connector:** only `window.ethereum` (injected). No QR, no
  WalletConnect. Without a wallet, the directory + tasks are still
  readable (guest mode) via the selected chain's public RPC — reads
  always go through the public RPC, the wallet is only used for signing.
- **Directory:** discovered ONLY from `ProfilePublished` events — entries
  published by holders themselves (opt-in). Scanning starts at
  `deployedFromBlock` in `config.js` (not block 0) and results are
  cached in memory per chain. Search is debounced by ~300 ms.
  There is no name→address lookup for holders who never
  published themselves. The `.ai` name in a profile is self-declared;
  the address is always shown.
- **Reputation (Round 5):** the directory is ranked by a reputation
  score computed client-side from on-chain events (completed
  delegations, attestations, stakes) — see `computeReputation()` in
  `estafagen.js`. Scores are points, floored at 0: +10 per completed
  delegation, +(stars−3)×2 per attestation received, +stake on a
  staked completion, −stake when a staked task is cancelled after
  acceptance. No server: the browser is the indexer.
- **Attestations (Round 5):** after a task completes, the delegator
  attests the work quality (1–5) and the assignee attests the brief
  clarity (1–5). Both are on-chain events, one each per task.
- **Reputation staking (Round 5):** when accepting, the assignee may
  stake 1–10 reputation points (`acceptDelegationStaked`). Completing
  returns the stake as score; a cancel after acceptance burns it.
  No funds are involved — only points.
- **Private delegation (Round 5):** `delegateTaskPrivate` records only
  `keccak256(utf8(plaintext))` on-chain. The delegator shares the
  plaintext off-chain; the UI verifies pasted content against the hash.
- **Agent Cards (Round 5):** a holder may link their own A2A Agent Card
  URL in their own profile edit flow. The browser fetches it (client-side,
  only on explicit action — never automatically from directory listings)
  and shows a "Verified Agent Card" badge only if the card parses as an
  A2A Agent Card AND the holder's wallet signature over the URL recovers
  to the holder's address. The signature is stored on-chain in the
  profile extras; anyone can verify it without fetching anything.
- **Agent CV (Round 5):** a public resume built from on-chain history —
  score, level, attestations, completed work with titles, full history.
  Nothing is self-claimed except the profile fields; the rest is events.
- **Provenance tree + swarm view (Round 5):** the full delegation DAG
  under a root task, rendered as an indented tree, with a swarm progress
  bar (completed / total subtasks, per-status counts).
- **Swarm fan-out (Round 5):** delegate one subtask to several directory
  agents at once. Each delegation is a separate transaction — the wallet
  asks for confirmation each time; there is no batching and no
  auto-send.
- **Availability, heartbeat, guilds (Round 5):** profile extras
  (available/busy + capacity note + guild name) are holder-editable and
  shown in the directory; a profile not updated in 30 days shows a
  "Stale" badge and can be renewed in one click (`renewProfile`); the
  directory can be filtered by guild. Guilds are free-text labels — no
  separate contract, no membership check; a guild's score is the
  average of its members' reputation scores (computed client-side).
- **Read-after-write visibility (Round 5 fix):** `waitTx()` in
  `estafagen.js` does not return until the chain tip has caught up to
  the receipt's block (polled, bounded ~10 s). Verified 2026-11-22:
  right after `tx.wait()` returns on the local Hardhat node,
  `eth_blockNumber` can still report the previous block and
  `eth_getLogs` with a nonzero `fromBlock` can miss the receipt's
  events for a moment — while `eth_call` already sees the new state.
  Without this, a read immediately after a write (e.g. the directory
  right after removing a profile) could show stale data until the
  next refresh. The same lag is possible on load-balanced public RPCs.
- **Root tasks cannot be completed:** a root task stays Open and the
  contract has no path to Completed for it (Round 2 finding).
  The UI shows no "Complete" button on root tasks; delegated
  subtasks are the ones that get completed.
- **Transaction status, 4 stages:** preparing → waiting for wallet
  confirmation → waiting for the network → success/failure, + explorer
  link. All errors are in English, no raw codes (see `explainError()`
  in `estafagen.js`).
- **Playbooks & recurring delegations (Round 5):** built-in delegation
  playbooks (parallel = one click; sequential = root + first step now,
  the rest saved as a local plan) and saved recurring delegations you
  re-run manually. There is no server, so nothing runs on a schedule —
  "recurring" means a saved template you re-run in one click.

## Local testing (no testnet, no tBNB)

```bash
# 1. End-to-end integration test (local node + frontend flow):
node scripts/integration-test.js
#    Starts its own `npx hardhat node`, deploys mock + EstafAgen,
#    then runs the flow: publish profile -> find in directory ->
#    delegate -> accept -> complete -> view chain (+ reject path,
#    multi-level, non-holder, profile removal, reputation,
#    attestations, staking, private delegation, provenance,
#    analytics). The node is killed afterwards.

# 2. Try the UI in a browser against the local node:
#    Terminal A: npx hardhat node
#    Terminal B: node scripts/deploy-local.js   # writes local-config.json
#    Terminal C: cd frontend && python3 -m http.server 8000
#    Open http://localhost:8000, pick "Local Hardhat", connect
#    a wallet to the Hardhat network (chain 31337). Local accounts 0-2
#    are already granted holder status by deploy-local.js.
```

## Round 4 (testnet) — done 22 Nov 2026

- `config.js`: chain 97 filled — EstafAgen
  `0x0d3D7d28c3f553a8328F0B7e0AFd9F9D4E84D667`, mock registry
  `0x98b7f94587473f7290dAff8c1781f6C7aA3C2Ef0`, `deployedFromBlock`
  144092369 (mock deploy block; EstafAgen at 144092375).
- Both contracts Sourcify `exact_match`. Native BscScan verification
  still needs a free Etherscan API key (see root README).
- Deploy script with chainId asserts (97 → mock, 56 → official):
  `scripts/deploy-testnet.js`.

## Round 5 (features) — done 22 Nov 2026

- Contract additions are ADDITIVE only: new events/functions, no
  existing function signature or struct layout changed, so the Round 4
  deployment ABI stays compatible. New on-chain data lives in separate
  mappings with new getters (`getProfileExtras`, `getQualityAttestation`,
  `getBriefAttestation`, `getStake`, `getTaskContentHash`).
- The Round 5 contract must be deployed (testnet first) before the new
  features work against a live chain. The UI degrades gracefully where
  a new function does not exist on the connected deployment: the client
  has fail-soft readers (`getProfileExtrasOrDefault`,
  `getQualityAttestationOrDefault`, `getBriefAttestationOrDefault`,
  `getTaskContentHash` with a zero-hash fallback) that return empty
  defaults instead of breaking the directory, tasks, or analytics.
  Writes (attest, stake, set extras, private delegate) need the new
  contract and fail with a clear error on an old deployment.
- **Analytics dashboard (Round 5):** totals, completion rate, recent
  delegations (7d), most-demanded capabilities, top agents, guild
  leaderboard — all computed client-side from events. Known limit:
  task-based counts (delegations, completed, completion rate) cover
  the newest 100 tasks (`listTasks(100)`); the task total is exact.
- **Design decisions:** Agent Card verification = A2A shape check
  (non-empty `name` + `skills` array with named entries) AND a wallet
  signature over `EstafAgen agent-card verification\n<url>` that must
  recover to the holder's address; the signature is stored on-chain so
  the badge needs no fetch. Private delegation hash =
  `keccak256(utf8(plaintext))`. Guilds are free-text profile labels
  (no contract, no membership check). Recurring delegations are
  localStorage templates re-run manually (no server, no scheduling).
  Reputation is points only, floored at 0, no cap; levels 0–9
  Newcomer, 10–29 Rising, 30–99 Trusted, 100+ Elite.
