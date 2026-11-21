/**
 * EstafAgen — chain + contract configuration.
 *
 * The frontend is a static page: it reads this file, then (when served
 * locally) overlays `local-config.json` if present — that file is written
 * by `scripts/deploy-local.js` after a local deploy and only carries the
 * local (chain 31337) addresses.
 *
 * Addresses for BSC Testnet (97) are filled in Round 4 after the testnet
 * deploy + BscScan verification; mainnet (56) only in Round 5, which needs
 * a separate explicit confirmation.
 */
window.ESTAFAGEN_CONFIG = {
    // Official Agent ID registry on BNB Chain mainnet (SPACE ID, ERC-721).
    // There is NO official registry on BSC Testnet — the mock stands in.
    officialRegistry: '0x60b9262456de011f7d15a54cdd8c48baaa8b022f',

    // Official tBNB faucet (used in the "saldo tidak cukup" error message).
    faucetUrl: 'https://testnet.bnbchain.org/faucet-smart',

    chains: {
        // Local Hardhat network (npx hardhat node). Addresses come from
        // local-config.json, written by scripts/deploy-local.js.
        31337: {
            label: 'Hardhat lokal',
            estafagen: null,
            registry: null,
            explorerTx: null, // no explorer for a local node; show the hash
        },
        // BSC Testnet — filled in Round 4.
        97: {
            label: 'BSC Testnet',
            estafagen: null,
            registry: null, // mock registry address, filled in Round 4
            explorerTx: 'https://testnet.bscscan.com/tx/',
            explorerAddress: 'https://testnet.bscscan.com/address/',
        },
        // BNB Chain mainnet — filled in Round 5 (needs explicit confirmation).
        56: {
            label: 'BNB Chain',
            estafagen: null,
            registry: '0x60b9262456de011f7d15a54cdd8c48baaa8b022f',
            explorerTx: 'https://bscscan.com/tx/',
            explorerAddress: 'https://bscscan.com/address/',
        },
    },
};
