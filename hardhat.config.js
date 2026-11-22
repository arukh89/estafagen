require("@nomicfoundation/hardhat-toolbox");

// BSC Testnet deployer key. Read from the testnet wallet file at deploy
// time (TESTNET_PRIVATE_KEY), never committed, never printed. When unset,
// the bscTestnet network has no accounts and the deploy script refuses
// with a clear error.
//
// Mainnet config exists here for PREPARATION ONLY (Round 5.1): the
// bscMainnet network + scripts/deploy-mainnet.js let the deploy be
// rehearsed and its guards proven without sending anything. The real
// mainnet deploy needs funding first (the deployer holds 0 mainnet BNB)
// plus the user's explicit confirmation per step — nothing in this file
// deploys on its own.
const TESTNET_PRIVATE_KEY = process.env.TESTNET_PRIVATE_KEY;

// Mainnet deployer key. Same wallet as testnet (keys are chain-agnostic);
// read from the same hidden wallet file at deploy time via
// MAINNET_PRIVATE_KEY, never committed, never printed. When unset, the
// bscMainnet network has no accounts and scripts/deploy-mainnet.js
// refuses with a clear error.
const MAINNET_PRIVATE_KEY = process.env.MAINNET_PRIVATE_KEY;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.20",
  networks: {
    hardhat: {},
    // BSC Testnet (chain 97). Public RPC; deploy script asserts chainId 97
    // and uses the mock registry. Deploy scripts MUST assert chainId:
    // 97 -> mock registry, 56 -> official Agent ID registry
    // (0x60b9262456de011f7d15a54cdd8c48baaa8b022f), else revert.
    bscTestnet: {
      url: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
      chainId: 97,
      accounts: TESTNET_PRIVATE_KEY ? [TESTNET_PRIVATE_KEY] : [],
    },
    // BNB Chain mainnet (chain 56). PREPARATION ONLY — see the header
    // comment. Deploy script asserts chainId 56 and uses the official
    // Agent ID registry; the mock is NEVER deployed here.
    bscMainnet: {
      url: "https://bsc-dataseed.binance.org/",
      chainId: 56,
      accounts: MAINNET_PRIVATE_KEY ? [MAINNET_PRIVATE_KEY] : [],
    },
  },
  // Source verification (Round 4).
  // - Sourcify is keyless and enabled below; it is tried first.
  // - BscScan uses the Etherscan API V2 (the testnet V1 endpoint is
  //   deprecated). It needs ETHERSCAN_API_KEY (BSCSCAN_API_KEY accepted
  //   as a fallback). When neither is set, the BscScan leg fails with a
  //   clear error and must be reported as blocked — never invent a key.
  //   The key is per-chain so mainnet verification (bsc) is explicit.
  etherscan: {
    apiKey: {
      bsc: process.env.ETHERSCAN_API_KEY || process.env.BSCSCAN_API_KEY || "",
      bscTestnet:
        process.env.ETHERSCAN_API_KEY || process.env.BSCSCAN_API_KEY || "",
    },
  },
  sourcify: {
    enabled: true,
  },
};
