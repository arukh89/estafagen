# EstafAgen

Agent-to-agent task delegation + agent directory, gated by Agent ID on BNB Chain.
Built for the Binance Agent ID Hackathon (submissions close 9 Dec 2026 15:00 WIB).

**The idea in one sentence:** an Agent ID holder publishes what their agent can do in a
directory; another holder finds an agent by capability and delegates a subtask to it;
every step is recorded on-chain, so the delegation chain is visible to anyone.

## Why Agent ID matters

Each agent in the chain has a proven identity: one ID per person, non-transferable.
Without Agent ID, anyone could pretend to be anyone and the chain could not be trusted.
The directory is the A2A-style Agent Card equivalent: discovery first, delegation second.

## Status

- **Round 1 (done):** Hardhat scaffold + mock Agent ID registry + tests.
- **Round 2 (done):** EstafAgen contract (profiles + tasks) + unit tests (36/36).
- **Round 3 (done):** static frontend + local integration test (17/17).
- **Round 4 (done):** testnet deploy + Sourcify verification + 7-part audit.
  Contract live on BSC Testnet (see addresses below).
- **Round 4.5 (done):** sticky nav menu + light visual polish (frontend only).
- **Round 4.6 (done):** audit-finding fixes (frontend + tooling; contract
  unchanged).
- **Round 5 (done):** all features (reputation,
  attestations, Agent CV, staking, proof-of-work receipts, Agent Card
  verification, private delegation, provenance tree, playbooks, swarm
  fan-out, availability, heartbeat, analytics, guilds, recurring
  delegations) + full English conversion. The Round 5 contract is not
  yet redeployed to testnet — the new on-chain features need the new
  deployment; the UI degrades gracefully against the Round 4 deployment.
  Mainnet deploy + project submission still need a separate explicit
  confirmation each. Nothing has been submitted or posted.

## Testnet (live, BSC Testnet chain 97)

| Contract | Address | Deploy tx |
|---|---|---|
| EstafAgen | `0x0d3D7d28c3f553a8328F0B7e0AFd9F9D4E84D667` | `0x05ca4eb471ec106ba2375c8ab39c1c83cdd348c12fd508efb9184fbd99dc9ab5` |
| MockAgentIdRegistry (TEST ONLY) | `0x98b7f94587473f7290dAff8c1781f6C7aA3C2Ef0` | `0x7e6ba897a1198bc58c6566fb10fd0d9b23fb1e32d7d10dd893b8a669ff80c6d5` |

- Deployer: `0x0c4466A4B65cfB7A87f782a8335a0AC1B6661354` (remaining balance 0.0997211466 tBNB).
- **Sourcify: both `exact_match`** (creation + runtime) — see
  [EstafAgen on Sourcify](https://sourcify.dev/server/v2/contract/97/0x0d3D7d28c3f553a8328F0B7e0AFd9F9D4E84D667)
  and [Mock on Sourcify](https://sourcify.dev/server/v2/contract/97/0x98b7f94587473f7290dAff8c1781f6C7aA3C2Ef0).
- Native BscScan verification still needs a free Etherscan API key (see below).
- Frontend live at https://estafagen.vercel.app/ (Vercel, manual deploy from the `frontend/` folder; GitHub auto-deploy not connected yet — Vercel asks for a GitHub Login Connection).
  Run locally: `cd frontend && python3 -m http.server 8000`, open
  `http://localhost:8000`, pick "BSC Testnet" — guest mode can read the
  directory + tasks without a wallet.

## Structure

```
contracts/
  EstafAgen.sol             Profiles + tasks + delegation chain (gated by Agent ID)
  MockAgentIdRegistry.sol   TEST-ONLY mock of the Agent ID registry (see warning below)
test/
  EstafAgen.test.js         36 unit tests (Rounds 1–4)
  EstafAgenRound5.test.js   23 unit tests (Round 5 features)
  MockAgentIdRegistry.test.js
frontend/
  index.html                Static page (mobile-first, sticky nav)
  styles.css                Styling (no framework)
  config.js                 Chain + contract addresses (97 live, 56 in Round 5)
  estafagen.js              Shared contract client (UMD: UI + integration test)
  app.js                    DOM wiring (connect, directory, tasks, chain)
scripts/
  deploy-local.js           Deploy to a local Hardhat node (+ local-config.json)
  deploy-testnet.js         Deploy to BSC Testnet (asserts chainId 97)
  integration-test.js       End-to-end flow test (17 steps, own Hardhat node)
deployments/
  bsc-testnet.json          Deploy record (local only, gitignored) — see note below
hardhat.config.js           Solidity 0.8.20
```

**Deploy address source (F32):** `deployments/bsc-testnet.json` is the source
of truth for deploy addresses; `frontend/config.js` is filled from that file
manually. After the next deploy, compare the two before committing —
no script does it automatically.

## Quickstart

```bash
npm install
npx hardhat compile
npx hardhat test          # 59 unit tests (36 + 23 Round 5)
node scripts/integration-test.js   # 28 end-to-end steps (own Hardhat node)
```

## Versions

- Node v24.22.1, npm 10.9.4 (`.nvmrc` contains `24`; `engines` in
  `package.json` requires Node >= 20)
- Hardhat 2.29.2, @nomicfoundation/hardhat-toolbox 5.0.0
- Solidity 0.8.20 (pinned in `hardhat.config.js`; same version must be used for BscScan verification)
- ethers 6.17.0 — declared in `devDependencies` (used by `estafagen.js` +
  scripts) and pinned in the frontend CDN with SRI (see `frontend/index.html`)

## Sourcify verification (manual, API v2) — F36

`@nomicfoundation/hardhat-verify` 2.1.4 has a broken Sourcify leg: it
calls the Sourcify v1 endpoint `/server/check-all-by-addresses`, which
has been removed (404, "API v1 is removed. Use API v2"). Do not remove
the `sourcify: { enabled: true }` block from `hardhat.config.js` — the
plugin's BscScan leg is still used (Etherscan API V2, needs a key) — but
do not rely on the plugin for Sourcify. Sourcify verification is done
manually via API v2 (keyless), as in Round 4:

```bash
# 1. Take the standard-JSON input from the Hardhat build info
#    (artifacts/build-info/*.json, field "input"; solc
#    0.8.20+commit.a1b79de6, optimizer off, evm paris — same as at
#    compile time). That is the verification payload.
# 2. Submit to Sourcify v2 (keyless), endpoint:
#      POST https://sourcify.dev/server/v2/verify/<chainId>/<address>
#    with that standard JSON as the verification body (see the
#    Sourcify v2 API docs for the current body format).
# 3. Check the result:
curl "https://sourcify.dev/server/v2/contract/97/0x0d3D7d28c3f553a8328F0B7e0AFd9F9D4E84D667"
#    -> "match": "exact_match" (creation + runtime).
```

Native BscScan verification (not Sourcify) uses the plugin and needs one
free key from https://etherscan.io/apis, then:

```bash
BSCSCAN_API_KEY=<key> npx hardhat verify --network bscTestnet <address> [constructor args...]
# EstafAgen takes the mock registry address as its constructor arg.
```

## Mock registry — read this before testnet

The official Agent ID contract (`0x60b9262456de011f7d15a54cdd8c48baaa8b022f`)
does **not** exist on BSC Testnet (`eth_getCode` returns `0x`, verified 20 Nov 2026).
`MockAgentIdRegistry` implements only `balanceOf(address)` with the exact ERC-721
signature, plus a test-only `setBalance` so test wallets can simulate holding an
Agent ID.

- Testnet proves the **mechanism** (gate works, double actions rejected, chain recorded),
  not Sybil resistance. Sybil resistance on mainnet comes from the real Agent ID
  (1 per user, non-transferable, claimed in-app).
- Deploy scripts MUST assert chainId: 97 → mock, 56 → official registry, else revert.
- **NEVER deploy this mock to mainnet and NEVER submit its address.** Only the
  mainnet EstafAgen contract address (+ the well-known official registry address)
  is submitted.

## Red lines (hackathon rules — violation = disqualification)

- No web QR-code login, no storing user login sessions server-side.
- No prompts that bypass the user's transaction confirmation; no automatic or
  unauthorized asset transfers; no unlimited approvals.
- No collecting seed phrases, private keys, API secrets, or pairing codes.
- No using "Binance"/"BNB" in the project, token, or domain name.
- No promising returns ("passive income", "automatic money-making").
- Agent ID is never packaged as a tool for looking up other people's wallets by name.
  The directory only lists entries holders publish themselves (opt-in, for receiving
  delegations), and anyone can remove their own profile.
- No fake volume or mass account registration. The Innovation Award needs 30 real
  Agent ID holders interacting — that has to be earned with honest outreach.

## License

MIT — see `LICENSE`.
