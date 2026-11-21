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

- **Round 1 (this commit):** Hardhat scaffold + mock Agent ID registry + tests.
- **Round 2 (planned):** EstafAgen contract (profiles + tasks) + unit tests.
- **Round 3 (planned):** static frontend + integration (directory, my profile, tasks, chain).
- **Round 4 (planned):** testnet deploy + BscScan verification + 7-part audit + in-app browser test.
- **Round 5 (planned):** mainnet — needs a separate explicit confirmation (deploy, funds, submission).

Nothing is deployed, submitted, or posted yet.

## Structure

```
contracts/
  MockAgentIdRegistry.sol   TEST-ONLY mock of the Agent ID registry (see warning below)
test/
  MockAgentIdRegistry.test.js
hardhat.config.js           Solidity 0.8.20
```

## Quickstart

```bash
npm install
npx hardhat compile
npx hardhat test
```

## Versions

- Node v24.22.1, npm 10.9.4
- Hardhat 2.29.2, @nomicfoundation/hardhat-toolbox 5.0.0
- Solidity 0.8.20 (pinned in `hardhat.config.js`; same version must be used for BscScan verification)

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
