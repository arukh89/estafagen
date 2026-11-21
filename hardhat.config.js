require("@nomicfoundation/hardhat-toolbox");

// BSC Testnet deployer key. Read from the testnet wallet file at deploy
// time (TESTNET_PRIVATE_KEY), never committed, never printed. When unset,
// the bscTestnet network has no accounts and the deploy script refuses
// with a clear error. There is NO mainnet config in this repo — mainnet
// arrives only in Round 5, with a separate explicit confirmation.
const TESTNET_PRIVATE_KEY = process.env.TESTNET_PRIVATE_KEY;

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
  },
  // Source verification (Round 4).
  // - Sourcify is keyless and enabled below; it is tried first.
  // - BscScan uses the Etherscan API V2 (the testnet V1 endpoint is
  //   deprecated). It needs BSCSCAN_API_KEY or ETHERSCAN_API_KEY. When
  //   neither is set, the BscScan leg fails with a clear error and must be
  //   reported as blocked — never invent a key.
  etherscan: {
    apiKey:
      process.env.BSCSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "",
  },
  sourcify: {
    enabled: true,
  },
};
