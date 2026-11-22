/**
 * EstafAgen — deploy to BNB Chain mainnet (chain 56) + write
 * deployments/bsc-mainnet.json.
 *
 * PREPARATION ONLY until funding + the user's explicit confirmation:
 * this file deploys a real mainnet contract that costs real BNB. Do NOT
 * run it with --network bscMainnet until (a) the deployer wallet holds
 * mainnet BNB (it currently holds 0 — funding is a separate step the
 * user does himself) and (b) the user has confirmed this deploy step
 * explicitly. The real deploy command (after funding + confirmation):
 *   MAINNET_PRIVATE_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME + '/workspace/goals/binance-agent-id-hackathon/hidden_files/testnet-wallet-bsc.json', 'utf8')).privateKey)") \
 *     npx hardhat run scripts/deploy-mainnet.js --network bscMainnet
 * (Same wallet file as testnet — keys are chain-agnostic. The key is
 * never echoed, never committed, never printed by this script.)
 *
 * What it does:
 *   1. Asserts MAINNET_PRIVATE_KEY is set and the connected chain is 56
 *      (chainId check runs BEFORE any transaction).
 *   2. Asserts the deployer is the expected wallet
 *      0x0c4466A4B65cfB7A87f782a8335a0AC1B6661354 and that its mainnet
 *      balance is at least 0.0005 BNB (testnet deploy used 4,430,897 gas;
 *      at ~0.05 gwei that is ~0.00022 BNB — the 0.0005 floor leaves room
 *      for gas spikes).
 *   3. Resolves the registry to the OFFICIAL Agent ID registry only,
 *      and cross-checks it against frontend/config.js officialRegistry
 *      (a mismatch refuses to deploy). The mock registry is NEVER
 *      deployed on mainnet.
 *   4. Deploys ONLY EstafAgen with the official registry address.
 *   5. Prints the address + deployment tx hash + gas used + deploy cost
 *      (balance delta) + the deployer's remaining BNB balance, and writes
 *      the same record to deployments/bsc-mainnet.json (local-only,
 *      gitignored).
 *
 * It does NOT update frontend/config.js (chain 56 addresses are filled
 * only after the real deploy is verified), does NOT grant holder status,
 * and does NOT publish any profile.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const OFFICIAL_REGISTRY = '0x60b9262456de011f7d15a54cdd8c48baaa8b022f';
const EXPECTED_DEPLOYER = '0x0c4466A4B65cfB7A87f782a8335a0AC1B6661354';
const MIN_BALANCE_BNB = '0.0005';

// Read frontend/config.js officialRegistry (single source of truth for
// the UI) and require it to equal the literal above. A mismatch means
// someone changed one side and not the other — refuse, do not guess.
function registryFromFrontendConfig() {
    const configPath = path.join(__dirname, '..', 'frontend', 'config.js');
    const text = fs.readFileSync(configPath, 'utf8');
    const match = text.match(/officialRegistry:\s*'(0x[0-9a-fA-F]{40})'/);
    if (!match) {
        throw new Error(
            'Could not find officialRegistry in frontend/config.js. ' +
            'Refusing to deploy.'
        );
    }
    return match[1];
}

async function main() {
    const hre = require('hardhat');

    if (!process.env.MAINNET_PRIVATE_KEY) {
        throw new Error(
            'MAINNET_PRIVATE_KEY is not set. Refusing to deploy with no ' +
            'deployer key — read it from the wallet file (see the header ' +
            'comment) and retry. The key is never printed or stored.'
        );
    }

    // Chain guard FIRST: no transaction may be sent unless we are on
    // BNB Chain mainnet (chainId 56). Anything else refuses here.
    const network = await hre.ethers.provider.getNetwork();
    const chainId = Number(network.chainId);
    if (chainId !== 56) {
        throw new Error(
            `Expected BNB Chain mainnet (chainId 56), got ${chainId}. ` +
            `Refusing to deploy.`
        );
    }

    const registry = OFFICIAL_REGISTRY;
    const registryInConfig = registryFromFrontendConfig();
    if (registryInConfig.toLowerCase() !== registry.toLowerCase()) {
        throw new Error(
            `Official registry mismatch: script has ${registry} but ` +
            `frontend/config.js has ${registryInConfig}. Refusing to deploy.`
        );
    }

    const [deployer] = await hre.ethers.getSigners();
    const deployerAddr = await deployer.getAddress();
    if (deployerAddr.toLowerCase() !== EXPECTED_DEPLOYER.toLowerCase()) {
        throw new Error(
            `Unexpected deployer ${deployerAddr} (expected ` +
            `${EXPECTED_DEPLOYER}). Refusing to deploy with the wrong key.`
        );
    }
    const balanceBefore = await hre.ethers.provider.getBalance(deployerAddr);
    const minBalance = hre.ethers.parseEther(MIN_BALANCE_BNB);
    if (balanceBefore < minBalance) {
        throw new Error(
            `Deployer balance ${hre.ethers.formatEther(balanceBefore)} BNB ` +
            `is below the ${MIN_BALANCE_BNB} BNB floor. Fund the deployer ` +
            `first, then retry. Refusing to deploy.`
        );
    }
    console.log(`Network:   BNB Chain mainnet (chainId 56)`);
    console.log(`Deployer:  ${deployerAddr}`);
    console.log(`Balance:   ${hre.ethers.formatEther(balanceBefore)} BNB`);
    console.log(`Registry:  ${registry} (official Agent ID, cross-checked against frontend/config.js)`);

    const EstafagenFactory = await hre.ethers.getContractFactory('EstafAgen');
    const estafagen = await EstafagenFactory.deploy(registry);
    await estafagen.waitForDeployment();
    const estafagenAddr = await estafagen.getAddress();
    const estafagenTx = estafagen.deploymentTransaction();
    const estafagenReceipt = await estafagenTx.wait();
    console.log(`EstafAgen deployed:           ${estafagenAddr}`);
    console.log(`  tx:       ${estafagenTx.hash}`);
    console.log(`  block:    ${estafagenReceipt.blockNumber}`);
    console.log(`  gas used: ${estafagenReceipt.gasUsed.toString()}`);

    const balanceAfter = await hre.ethers.provider.getBalance(deployerAddr);
    const deployCost = balanceBefore - balanceAfter;
    console.log(`Deploy cost: ${hre.ethers.formatEther(deployCost)} BNB`);
    console.log(`Remaining balance: ${hre.ethers.formatEther(balanceAfter)} BNB`);

    const record = {
        network: 'bscMainnet',
        chainId: 56,
        deployer: deployerAddr,
        deployedAt: new Date().toISOString(),
        registry: {
            address: registry,
            kind: 'Official Agent ID registry (SPACE ID, ERC-721)',
        },
        estafagen: {
            address: estafagenAddr,
            constructorArgs: [registry],
            txHash: estafagenTx.hash,
            blockNumber: estafagenReceipt.blockNumber,
            gasUsed: estafagenReceipt.gasUsed.toString(),
        },
        totalGasUsed: estafagenReceipt.gasUsed.toString(),
        deployCostBnb: hre.ethers.formatEther(deployCost),
        deployerBalanceAfterBnb: hre.ethers.formatEther(balanceAfter),
    };
    const dir = path.join(__dirname, '..', 'deployments');
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, 'bsc-mainnet.json');
    fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n');
    console.log(`Wrote ${outPath} (local only — do not commit)`);
}

main().catch((err) => {
    console.error('deploy-mainnet failed:', err && err.message ? err.message : err);
    process.exitCode = 1;
});
