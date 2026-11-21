/**
 * EstafAgen — chain + contract configuration.
 *
 * The frontend is a static page: it reads this file, then (when served
 * locally) overlays `local-config.json` if present — that file is written
 * by `scripts/deploy-local.js` after a local deploy and only carries the
 * local (chain 31337) addresses.
 *
 * Round 5 (22 Nov 2026) redeployed to BSC Testnet (97) and verified both
 * contracts exact_match on Sourcify; mainnet (56) only in Round 5, which
 * needs a separate explicit confirmation.
 *
 * `deployedFromBlock` is where the directory's event scan starts (F5):
 * scanning ProfilePublished from block 0 would span ~144M blocks on
 * testnet and time out on public RPCs. Chain 56 stays null until R5.
 */
window.ESTAFAGEN_CONFIG = {
    // Official Agent ID registry on BNB Chain mainnet (SPACE ID, ERC-721).
    // There is NO official registry on BSC Testnet — the mock stands in.
    officialRegistry: '0x60b9262456de011f7d15a54cdd8c48baaa8b022f',

    // Official tBNB faucet (used in the "insufficient balance" error message).
    faucetUrl: 'https://testnet.bnbchain.org/faucet-smart',

    chains: {
        // Local Hardhat network (npx hardhat node). Addresses come from
        // local-config.json, written by scripts/deploy-local.js.
        31337: {
            label: 'Local Hardhat',
            estafagen: null,
            registry: null,
            explorerTx: null, // no explorer for a local node; show the hash
            explorer: null,
            deployedFromBlock: 0, // local chain starts at genesis; tiny range
        },
        // BSC Testnet — redeployed Round 5 (22 Nov 2026) and verified exact_match
        // on Sourcify (both contracts, creation + runtime). Sourcify also
        // forwards verified contracts to BscScan (Etherscan V2); the BscScan-side
        // result could not be confirmed from this VM (no API key, BscScan web 403)
        // — see the Round 4 report for the key needed to finish it.
        // Mock registry 0x55c015f3006EFc338186F5590D13177870b12E04,
        // EstafAgen 0x2c52BdB79059760120bF4E6FB6e97509D58Fd1a6.
        97: {
            label: 'BSC Testnet',
            estafagen: '0x2c52BdB79059760120bF4E6FB6e97509D58Fd1a6',
            registry: '0x55c015f3006EFc338186F5590D13177870b12E04', // mock registry, Round 5
            explorerTx: 'https://testnet.bscscan.com/tx/',
            explorerAddress: 'https://testnet.bscscan.com/address/',
            explorer: 'https://testnet.bscscan.com',
            // Block 144110035 = MockAgentIdRegistry deployment (EstafAgen
            // followed at 144110039); the directory scan starts here.
            deployedFromBlock: 144110035,
        },
        // BNB Chain mainnet — filled in Round 5 (needs explicit confirmation).
        56: {
            label: 'BNB Chain',
            estafagen: null,
            registry: '0x60b9262456de011f7d15a54cdd8c48baaa8b022f',
            explorerTx: 'https://bscscan.com/tx/',
            explorerAddress: 'https://bscscan.com/address/',
            explorer: 'https://bscscan.com',
            deployedFromBlock: null, // set to the mainnet deploy block in R5
        },
    },
};

// Chain 56 uses the official registry — single source of truth (F21),
// instead of repeating the address literal above.
window.ESTAFAGEN_CONFIG.chains[56].registry = window.ESTAFAGEN_CONFIG.officialRegistry;
