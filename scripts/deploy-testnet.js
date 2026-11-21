/**
 * EstafAgen — deploy to BSC Testnet (chain 97) + write deployments/bsc-testnet.json.
 *
 * Run (key read from the testnet wallet file, never echoed, never committed):
 *   TESTNET_PRIVATE_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME + '/workspace/goals/binance-agent-id-hackathon/hidden_files/testnet-wallet-bsc.json', 'utf8')).privateKey)") \
 *     npx hardhat run scripts/deploy-testnet.js --network bscTestnet
 *
 * What it does:
 *   1. Asserts the connected chain is 97 and a deployer key is configured.
 *   2. Resolves the registry by chainId: 97 -> freshly deployed mock
 *      registry, 56 -> official Agent ID registry
 *      (0x60b9262456de011f7d15a54cdd8c48baaa8b022f), anything else -> revert.
 *      The mock registry address is NEVER submitted as a mainnet address.
 *   3. Deploys MockAgentIdRegistry, then EstafAgen with the mock address.
 *   4. Prints both addresses + deployment tx hashes + gas used + the
 *      deployer's remaining tBNB balance, and writes the same record to
 *      deployments/bsc-testnet.json (local-only, gitignored).
 *
 * It does NOT grant holder status and does NOT publish any profile: the
 * testnet mock starts empty on purpose. Testnet only — never run this
 * against mainnet (there is no mainnet config in this repo).
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const OFFICIAL_REGISTRY = '0x60b9262456de011f7d15a54cdd8c48baaa8b022f';

function resolveRegistry(chainId, mockAddress) {
    if (chainId === 97) {
        return mockAddress;
    }
    if (chainId === 56) {
        return OFFICIAL_REGISTRY;
    }
    throw new Error(
        `Unsupported chainId ${chainId}: only 97 (mock registry) and 56 ` +
        `(official registry) are allowed. Refusing to deploy.`
    );
}

async function main() {
    const hre = require('hardhat');

    if (!process.env.TESTNET_PRIVATE_KEY) {
        throw new Error(
            'TESTNET_PRIVATE_KEY is not set. Refusing to deploy with no ' +
            'deployer key — read it from the testnet wallet file (see the ' +
            'header comment) and retry. The key is never printed or stored.'
        );
    }

    const network = await hre.ethers.provider.getNetwork();
    const chainId = Number(network.chainId);
    if (chainId !== 97) {
        throw new Error(
            `Expected BSC Testnet (chainId 97), got ${chainId}. ` +
            `Refusing to deploy.`
        );
    }

    const [deployer] = await hre.ethers.getSigners();
    const deployerAddr = await deployer.getAddress();
    const balanceBefore = await hre.ethers.provider.getBalance(deployerAddr);
    console.log(`Network:   BSC Testnet (chainId 97)`);
    console.log(`Deployer:  ${deployerAddr}`);
    console.log(`Balance:   ${hre.ethers.formatEther(balanceBefore)} tBNB`);

    const MockFactory = await hre.ethers.getContractFactory('MockAgentIdRegistry');
    const mock = await MockFactory.deploy();
    await mock.waitForDeployment();
    const mockAddr = await mock.getAddress();
    const mockTx = mock.deploymentTransaction();
    const mockReceipt = await mockTx.wait();
    console.log(`MockAgentIdRegistry deployed: ${mockAddr}`);
    console.log(`  tx:       ${mockTx.hash}`);
    console.log(`  block:    ${mockReceipt.blockNumber}`);
    console.log(`  gas used: ${mockReceipt.gasUsed.toString()}`);

    const registry = resolveRegistry(chainId, mockAddr);
    const EstafagenFactory = await hre.ethers.getContractFactory('EstafAgen');
    const estafagen = await EstafagenFactory.deploy(registry);
    await estafagen.waitForDeployment();
    const estafagenAddr = await estafagen.getAddress();
    const estafagenTx = estafagen.deploymentTransaction();
    const estafagenReceipt = await estafagenTx.wait();
    console.log(`EstafAgen deployed:           ${estafagenAddr}`);
    console.log(`  registry: ${registry}`);
    console.log(`  tx:       ${estafagenTx.hash}`);
    console.log(`  block:    ${estafagenReceipt.blockNumber}`);
    console.log(`  gas used: ${estafagenReceipt.gasUsed.toString()}`);

    const totalGas = mockReceipt.gasUsed + estafagenReceipt.gasUsed;
    const balanceAfter = await hre.ethers.provider.getBalance(deployerAddr);
    console.log(`Total gas used: ${totalGas.toString()}`);
    console.log(`Remaining balance: ${hre.ethers.formatEther(balanceAfter)} tBNB`);

    const record = {
        network: 'bscTestnet',
        chainId: 97,
        deployer: deployerAddr,
        deployedAt: new Date().toISOString(),
        registry: {
            address: mockAddr,
            kind: 'MockAgentIdRegistry (TEST ONLY — never submit as mainnet)',
            txHash: mockTx.hash,
            blockNumber: mockReceipt.blockNumber,
            gasUsed: mockReceipt.gasUsed.toString(),
        },
        estafagen: {
            address: estafagenAddr,
            constructorArgs: [registry],
            txHash: estafagenTx.hash,
            blockNumber: estafagenReceipt.blockNumber,
            gasUsed: estafagenReceipt.gasUsed.toString(),
        },
        totalGasUsed: totalGas.toString(),
        deployerBalanceAfterTbnb: hre.ethers.formatEther(balanceAfter),
    };
    const dir = path.join(__dirname, '..', 'deployments');
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, 'bsc-testnet.json');
    fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n');
    console.log(`Wrote ${outPath} (local only — do not commit)`);
}

main().catch((err) => {
    console.error('deploy-testnet failed:', err && err.message ? err.message : err);
    process.exitCode = 1;
});
