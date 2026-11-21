require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.20",
  networks: {
    hardhat: {},
    // BSC Testnet (chain 97) and mainnet (chain 56) deploy config arrives in Round 4.
    // Deploy scripts MUST assert chainId: 97 -> mock registry, 56 -> official
    // Agent ID registry (0x60b9262456de011f7d15a54cdd8c48baaa8b022f), else revert.
  },
};
