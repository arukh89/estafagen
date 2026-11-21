/**
 * EstafAgen — deploy to a LOCAL Hardhat node + write frontend/local-config.json.
 *
 * Manual dev flow (Round 3):
 *   1. Terminal A: npx hardhat node            (chain 31337, localhost:8545)
 *   2. Terminal B: node scripts/deploy-local.js
 *   3. Serve the frontend: cd frontend && python3 -m http.server 8000
 *   4. Open http://localhost:8000 — the page reads local-config.json and
 *      talks to the local contracts. Pick "Hardhat lokal" in the chain
 *      selector. Accounts 0-2 are granted holder status so you can click
 *      through publish / delegate / accept / complete in the UI.
 *
 * Local network only. Never run this against testnet/mainnet.
 * local-config.json is MACHINE-LOCAL — do not commit it (it only holds
 * throwaway localhost addresses). The deployer is Hardhat account 0.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { ethers } = require('ethers');

const ROOT = path.join(__dirname, '..');
const RPC_URL = 'http://127.0.0.1:8545';

function loadArtifact(contractFile) {
    const p = path.join(ROOT, 'artifacts', 'contracts', contractFile);
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { abi: json.abi, bytecode: json.bytecode };
}

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const net = await provider.getNetwork().catch(() => {
        throw new Error(`No Hardhat node at ${RPC_URL} — start it first: npx hardhat node`);
    });
    if (Number(net.chainId) !== 31337) {
        throw new Error(`Expected local chain 31337, got ${net.chainId}. Refusing to deploy.`);
    }

    const deployer = await provider.getSigner(0);
    const mockArt = loadArtifact('MockAgentIdRegistry.sol/MockAgentIdRegistry.json');
    const estafagenArt = loadArtifact('EstafAgen.sol/EstafAgen.json');

    const mockFactory = new ethers.ContractFactory(mockArt.abi, mockArt.bytecode, deployer);
    const mock = await mockFactory.deploy();
    await mock.waitForDeployment();
    const mockAddr = await mock.getAddress();

    const estafagenFactory = new ethers.ContractFactory(estafagenArt.abi, estafagenArt.bytecode, deployer);
    const estafagen = await estafagenFactory.deploy(mockAddr);
    await estafagen.waitForDeployment();
    const estafagenAddr = await estafagen.getAddress();

    // Grant holder status to the first 3 local accounts for manual UI testing.
    for (let i = 0; i < 3; i++) {
        const signer = await provider.getSigner(i);
        const addr = await signer.getAddress();
        await (await mock.setBalance(addr, 1)).wait();
        console.log(`Holder granted: ${addr}`);
    }

    const config = { chainId: 31337, estafagen: estafagenAddr, registry: mockAddr };
    const outPath = path.join(ROOT, 'frontend', 'local-config.json');
    fs.writeFileSync(outPath, JSON.stringify(config, null, 2) + '\n');
    console.log(`MockAgentIdRegistry: ${mockAddr}`);
    console.log(`EstafAgen:          ${estafagenAddr}`);
    console.log(`Wrote ${outPath} (local only — do not commit)`);
}

main().catch((err) => {
    console.error('deploy-local failed:', err && err.message ? err.message : err);
    process.exitCode = 1;
});
