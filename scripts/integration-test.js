/**
 * EstafAgen — local integration test (Round 3).
 *
 * Spins up a LOCAL Hardhat network (`npx hardhat node`, chain 31337),
 * deploys MockAgentIdRegistry + EstafAgen, then drives the exact flow the
 * frontend implements — using the frontend's OWN client code
 * (frontend/estafagen.js, required here in Node via its UMD wrapper):
 *
 *   publish profile -> find in directory (incl. search/filter)
 *   -> create root task -> delegate -> accept -> complete -> view chain
 *   (+ reject path, multi-level chain, root-task-cannot-complete,
 *    non-holder reverts, profile removal, Indonesian error mapping)
 *
 * Local network only. No testnet, no tBNB, no real funds, nothing deployed
 * anywhere public. The Hardhat node is killed at the end.
 *
 * Usage:
 *   node scripts/integration-test.js
 *   (from the repo root; run `npx hardhat compile` first)
 */
'use strict';

const { spawn } = require('node:child_process');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { ethers } = require('ethers');

const ROOT = path.join(__dirname, '..');
const PORT = 8545;
const RPC_URL = `http://127.0.0.1:${PORT}`;

const EstafAgen = require('../frontend/estafagen.js');

let passed = 0;
let failed = 0;

async function step(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (err) {
        failed++;
        console.error(`  FAIL  ${name}`);
        console.error(`        ${err && err.message ? String(err.message).split('\n')[0] : err}`);
        throw err;
    }
}

async function assertReverts(promise, expectedName, label) {
    try {
        await promise;
    } catch (err) {
        const name = EstafAgen.revertName(err);
        assert.strictEqual(
            name,
            expectedName,
            `${label}: expected revert ${expectedName}, got ${name || 'unknown'} (${EstafAgen.flattenErrorText(err).slice(0, 200)})`
        );
        return err;
    }
    assert.fail(`${label}: expected revert ${expectedName}, but the call succeeded`);
}

function loadArtifact(contractFile) {
    const p = path.join(ROOT, 'artifacts', 'contracts', contractFile);
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { abi: json.abi, bytecode: json.bytecode };
}

async function waitForNode(provider, timeoutMs = 30000) {
    const start = Date.now();
    for (;;) {
        try {
            const net = await provider.getNetwork();
            if (Number(net.chainId) === 31337) return;
        } catch (e) { /* not up yet */ }
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Hardhat node did not come up on ${RPC_URL} within ${timeoutMs}ms`);
        }
        await new Promise((r) => setTimeout(r, 250));
    }
}

async function main() {
    console.log('EstafAgen — local integration test (Round 3)');
    console.log(`Spawning: npx hardhat node --port ${PORT}`);

    const node = spawn('npx', ['hardhat', 'node', '--port', String(PORT)], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Keep node output out of the way, but surface it if the node dies early.
    let nodeOutput = '';
    node.stdout.on('data', (d) => { nodeOutput += d; });
    node.stderr.on('data', (d) => { nodeOutput += d; });

    const provider = new ethers.JsonRpcProvider(RPC_URL);

    try {
        await waitForNode(provider);
        console.log('Hardhat node up (chain 31337).');

        const alice = await provider.getSigner(0);
        const bob = await provider.getSigner(1);
        const carol = await provider.getSigner(2);
        const dave = await provider.getSigner(3);
        const aliceAddr = await alice.getAddress();
        const bobAddr = await bob.getAddress();
        const carolAddr = await carol.getAddress();
        const daveAddr = await dave.getAddress();

        // --- Deploy (same artifacts the frontend will talk to) ----------
        const mockArt = loadArtifact('MockAgentIdRegistry.sol/MockAgentIdRegistry.json');
        const estafagenArt = loadArtifact('EstafAgen.sol/EstafAgen.json');

        const mockFactory = new ethers.ContractFactory(mockArt.abi, mockArt.bytecode, alice);
        const mock = await mockFactory.deploy();
        await mock.waitForDeployment();
        const mockAddr = await mock.getAddress();

        const estafagenFactory = new ethers.ContractFactory(estafagenArt.abi, estafagenArt.bytecode, alice);
        const estafagen = await estafagenFactory.deploy(mockAddr);
        await estafagen.waitForDeployment();
        const estafagenAddr = await estafagen.getAddress();
        console.log(`Deployed MockAgentIdRegistry at ${mockAddr}`);
        console.log(`Deployed EstafAgen at ${estafagenAddr}`);

        // Grant holder status to Alice, Bob, Carol. Dave stays a non-holder.
        for (const addr of [aliceAddr, bobAddr, carolAddr]) {
            await (await mock.setBalance(addr, 1)).wait();
        }

        // --- The FRONTEND client, driven end to end ----------------------
        const client = EstafAgen.createClient(provider, {
            estafagen: estafagenAddr,
            registry: mockAddr,
        });

        console.log('Flow: publish profile -> directory -> delegate -> accept -> complete -> chain');

        await step('isHolder: Alice/Bob/Carol true, Dave false', async () => {
            assert.strictEqual(await client.isHolder(aliceAddr), true);
            assert.strictEqual(await client.isHolder(bobAddr), true);
            assert.strictEqual(await client.isHolder(carolAddr), true);
            assert.strictEqual(await client.isHolder(daveAddr), false);
        });

        await step('Alice + Bob publish profiles', async () => {
            await client.publishProfile(alice, 'alice.ai', 'riset pasar, ringkasan', 'Agen riset pasar harian.');
            await client.publishProfile(bob, 'bob.ai', 'penulisan, kode', 'Agen penulis dan pembantu kode.');
            const a = await client.getProfile(aliceAddr);
            assert.strictEqual(a.exists, true);
            assert.strictEqual(a.name, 'alice.ai');
        });

        await step('Directory lists both profiles (event discovery)', async () => {
            const all = await client.listProfiles();
            assert.strictEqual(all.length, 2);
            const holders = all.map((p) => p.holder).sort();
            assert.deepStrictEqual(holders, [aliceAddr, bobAddr].sort());
        });

        await step('Search/filter: "riset" finds Alice only, "KODE" finds Bob only', async () => {
            const riset = await client.searchProfiles('riset');
            assert.strictEqual(riset.length, 1);
            assert.strictEqual(riset[0].holder, aliceAddr);
            const kode = await client.searchProfiles('KODE');
            assert.strictEqual(kode.length, 1);
            assert.strictEqual(kode[0].holder, bobAddr);
            const none = await client.searchProfiles('tidak-ada-yang-cocok');
            assert.strictEqual(none.length, 0);
        });

        let rootId;
        await step('Alice creates a root task (Open, assignee = Alice, parentId 0)', async () => {
            await client.createTask(alice, 'Riset harga token X', 'Kumpulkan harga 7 hari terakhir.');
            const count = await client.getTaskCount();
            assert.strictEqual(count, 1);
            const t = await client.getTask(1);
            rootId = t.id;
            assert.strictEqual(t.statusName, 'Open');
            assert.strictEqual(t.assignee, aliceAddr);
            assert.strictEqual(t.parentId, 0);
            assert.strictEqual(t.isRoot, true);
        });

        let subId;
        await step('Alice delegates a subtask to Bob (Delegated, parentId = root)', async () => {
            await client.delegateTask(alice, rootId, bobAddr, 'Kumpulkan data harga', 'Ambil harga harian dari sumber publik.');
            const t = await client.getTask(2);
            subId = t.id;
            assert.strictEqual(t.statusName, 'Delegated');
            assert.strictEqual(t.parentId, rootId);
            assert.strictEqual(t.assignee, bobAddr);
            assert.strictEqual(t.isRoot, false);
        });

        await step('Carol (not the assignee) cannot accept — NotAssignee, Indonesian message', async () => {
            const err = await assertReverts(
                client.acceptDelegation(carol, subId),
                'NotAssignee',
                'accept by non-assignee'
            );
            const msg = EstafAgen.explainError(err, 'tx');
            assert.ok(msg.includes('penerima'), `explainError should be Indonesian, got: ${msg}`);
            assert.ok(!msg.includes('NotAssignee'), 'explainError must not leak raw codes');
        });

        await step('Bob accepts the delegation (Accepted)', async () => {
            await client.acceptDelegation(bob, subId);
            assert.strictEqual((await client.getTask(subId)).statusName, 'Accepted');
        });

        let sub2Id;
        await step('Multi-level: Bob (assignee of Accepted parent) delegates further to Carol', async () => {
            await client.delegateTask(bob, subId, carolAddr, 'Rapikan data harga', 'Buat tabel ringkas.');
            const t = await client.getTask(3);
            sub2Id = t.id;
            assert.strictEqual(t.statusName, 'Delegated');
            assert.strictEqual(t.parentId, subId);
            assert.strictEqual(t.assignee, carolAddr);
        });

        await step('Carol accepts and completes her subtask; parents stay unchanged (v1 limit)', async () => {
            await client.acceptDelegation(carol, sub2Id);
            await client.completeTask(carol, sub2Id);
            assert.strictEqual((await client.getTask(sub2Id)).statusName, 'Completed');
            assert.strictEqual((await client.getTask(subId)).statusName, 'Accepted');
            assert.strictEqual((await client.getTask(rootId)).statusName, 'Open');
        });

        await step('Bob completes his subtask; root task stays Open', async () => {
            await client.completeTask(bob, subId);
            assert.strictEqual((await client.getTask(subId)).statusName, 'Completed');
            assert.strictEqual((await client.getTask(rootId)).statusName, 'Open');
        });

        await step('Chain view: [sub2, sub, root] leaf-first, length 3', async () => {
            const chain = await client.getChain(sub2Id);
            assert.deepStrictEqual(chain.map((t) => t.id), [sub2Id, subId, rootId]);
            const rootChain = await client.getChain(rootId);
            assert.deepStrictEqual(rootChain.map((t) => t.id), [rootId]);
        });

        await step('Root task can NEVER be completed (InvalidStatus), per Round 2 design', async () => {
            const err = await assertReverts(
                client.completeTask(alice, rootId),
                'InvalidStatus',
                'complete root task'
            );
            const msg = EstafAgen.explainError(err, 'tx');
            assert.ok(!msg.includes('InvalidStatus'), 'explainError must not leak raw codes');
        });

        await step('Reject path: delegate to Carol, she rejects, accept after reject reverts', async () => {
            await client.delegateTask(alice, rootId, carolAddr, 'Tugas yang ditolak', 'Untuk menguji jalur tolak.');
            const t = await client.getTask(4);
            assert.strictEqual(t.statusName, 'Delegated');
            await client.rejectDelegation(carol, 4);
            assert.strictEqual((await client.getTask(4)).statusName, 'Rejected');
            await assertReverts(client.acceptDelegation(carol, 4), 'InvalidStatus', 'accept after reject');
        });

        await step('Dave (non-holder) cannot publish — NotAgentIdHolder, Indonesian message', async () => {
            const err = await assertReverts(
                client.publishProfile(dave, 'dave.ai', 'apa saja', 'Bukan holder.'),
                'NotAgentIdHolder',
                'publish by non-holder'
            );
            const msg = EstafAgen.explainError(err, 'tx');
            assert.ok(msg.includes('Agent ID'), `explainError should mention Agent ID, got: ${msg}`);
            assert.ok(!msg.includes('NotAgentIdHolder'), 'explainError must not leak raw codes');
        });

        await step('Alice removes her profile; directory no longer lists her', async () => {
            await client.removeProfile(alice);
            const remaining = await client.listProfiles();
            assert.strictEqual(remaining.length, 1);
            assert.strictEqual(remaining[0].holder, bobAddr);
            const all = await client.searchProfiles('');
            assert.strictEqual(all.length, 1);
        });

        await step('Task list reflects all 4 tasks, newest first', async () => {
            const tasks = await client.listTasks();
            assert.strictEqual(tasks.length, 4);
            assert.deepStrictEqual(tasks.map((t) => t.id), [4, 3, 2, 1]);
        });

        console.log(`\nIntegration test: ${passed} passed, ${failed} failed.`);
        if (failed > 0) process.exitCode = 1;
    } finally {
        node.kill('SIGTERM');
    }
}

main().catch((err) => {
    console.error('Integration test crashed:', err && err.message ? err.message : err);
    process.exitCode = 1;
});
