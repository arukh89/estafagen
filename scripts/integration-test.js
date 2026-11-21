/**
 * EstafAgen — local integration test (Round 3, extended in Round 5).
 *
 * Spins up a LOCAL Hardhat network (`npx hardhat node`, chain 31337),
 * deploys MockAgentIdRegistry + EstafAgen, then drives the exact flow the
 * frontend implements — using the frontend's OWN client code
 * (frontend/estafagen.js, required here in Node via its UMD wrapper):
 *
 *   publish profile -> find in directory (incl. search/filter)
 *   -> create root task -> delegate -> accept -> complete -> view chain
 *   (+ reject path, multi-level chain, root-task-cannot-complete,
 *    non-holder reverts, profile removal, English error mapping,
 *    reputation, attestations, staking, private delegation,
 *    provenance, analytics)
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
    console.log('EstafAgen — local integration test (Round 3, extended in Round 5)');
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
            await client.publishProfile(alice, 'alice.ai', 'market research, summary', 'Daily market research agent.');
            await client.publishProfile(bob, 'bob.ai', 'writing, code', 'Writing and coding assistant agent.');
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

        await step('Search/filter: "research" finds Alice only, "CODE" finds Bob only', async () => {
            const research = await client.searchProfiles('research');
            assert.strictEqual(research.length, 1);
            assert.strictEqual(research[0].holder, aliceAddr);
            const kode = await client.searchProfiles('CODE');
            assert.strictEqual(kode.length, 1);
            assert.strictEqual(kode[0].holder, bobAddr);
            const none = await client.searchProfiles('no-such-match');
            assert.strictEqual(none.length, 0);
        });

        let rootId;
        await step('Alice creates a root task (Open, assignee = Alice, parentId 0)', async () => {
            await client.createTask(alice, 'Research token X price', 'Collect the last 7 days of prices.');
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
            await client.delegateTask(alice, rootId, bobAddr, 'Collect price data', 'Get daily prices from public sources.');
            const t = await client.getTask(2);
            subId = t.id;
            assert.strictEqual(t.statusName, 'Delegated');
            assert.strictEqual(t.parentId, rootId);
            assert.strictEqual(t.assignee, bobAddr);
            assert.strictEqual(t.isRoot, false);
        });

        await step('Carol (not the assignee) cannot accept — NotAssignee, English message', async () => {
            const err = await assertReverts(
                client.acceptDelegation(carol, subId),
                'NotAssignee',
                'accept by non-assignee'
            );
            const msg = EstafAgen.explainError(err, 'tx');
            assert.ok(msg.includes('assignee'), `explainError should be English, got: ${msg}`);
            assert.ok(!msg.includes('NotAssignee'), 'explainError must not leak raw codes');
        });

        await step('Bob accepts the delegation (Accepted)', async () => {
            await client.acceptDelegation(bob, subId);
            assert.strictEqual((await client.getTask(subId)).statusName, 'Accepted');
        });

        let sub2Id;
        await step('Multi-level: Bob (assignee of Accepted parent) delegates further to Carol', async () => {
            await client.delegateTask(bob, subId, carolAddr, 'Tidy up the price data', 'Make a short summary table.');
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
            await client.delegateTask(alice, rootId, carolAddr, 'Task to be rejected', 'To test the reject path.');
            const t = await client.getTask(4);
            assert.strictEqual(t.statusName, 'Delegated');
            await client.rejectDelegation(carol, 4);
            assert.strictEqual((await client.getTask(4)).statusName, 'Rejected');
            await assertReverts(client.acceptDelegation(carol, 4), 'InvalidStatus', 'accept after reject');
        });

        await step('Dave (non-holder) cannot publish — NotAgentIdHolder, English message', async () => {
            const err = await assertReverts(
                client.publishProfile(dave, 'dave.ai', 'anything', 'Not a holder.'),
                'NotAgentIdHolder',
                'publish by non-holder'
            );
            const msg = EstafAgen.explainError(err, 'tx');
            assert.ok(msg.includes('Agent ID'), `explainError should mention Agent ID, got: ${msg}`);
            assert.ok(!msg.includes('NotAgentIdHolder'), 'explainError must not leak raw codes');
        });

        await step('Round 5 — reputation: Bob 18, Carol 14, Alice 0 before attestations', async () => {
            // State so far: Bob completed task 2 (+10), Carol completed
            // task 3 (+10). No attestations or stakes yet.
            const bobRep = await client.computeReputation(bobAddr);
            assert.strictEqual(bobRep.completed, 1);
            assert.strictEqual(bobRep.score, 10);
            assert.strictEqual(bobRep.level, 'Rising');
            const carolRep = await client.computeReputation(carolAddr);
            assert.strictEqual(carolRep.score, 10);
            const aliceRep = await client.computeReputation(aliceAddr);
            assert.strictEqual(aliceRep.score, 0);
            assert.strictEqual(aliceRep.level, 'Newcomer');
            const daveRep = await client.computeReputation(daveAddr);
            assert.strictEqual(daveRep.score, 0);
        });

        await step('Round 5 — two-sided attestations move scores (quality +4, brief +2/+4)', async () => {
            await client.attestQuality(alice, subId, 5); // Bob +4 -> 14
            await client.attestBrief(bob, subId, 4);     // Alice +2 -> 2
            await client.attestQuality(bob, sub2Id, 5);  // Carol +4 -> 14
            await client.attestBrief(carol, sub2Id, 5);  // Bob +4 -> 18
            assert.strictEqual((await client.computeReputation(bobAddr)).score, 18);
            assert.strictEqual((await client.computeReputation(carolAddr)).score, 14);
            assert.strictEqual((await client.computeReputation(aliceAddr)).score, 2);
            const q = await client.getQualityAttestation(subId);
            assert.strictEqual(q.exists, true);
            assert.strictEqual(q.score, 5);
            assert.strictEqual(q.attester, aliceAddr);
            const b = await client.getBriefAttestation(subId);
            assert.strictEqual(b.exists, true);
            assert.strictEqual(b.score, 4);
            // Second attestation of the same kind reverts AlreadyAttested.
            await assertReverts(client.attestQuality(alice, subId, 5), 'AlreadyAttested', 'double quality attest');
            await assertReverts(client.attestBrief(bob, subId, 5), 'AlreadyAttested', 'double brief attest');
        });

        await step('Round 5 — staked accept: Bob stakes 5, completes, gains +10 +5', async () => {
            await client.delegateTask(alice, rootId, bobAddr, 'Staked subtask', 'Work with skin in the game.');
            const stakedId = 5;
            await client.acceptDelegationStaked(bob, stakedId, 5);
            assert.strictEqual(await client.getStake(stakedId), 5);
            await client.completeTask(bob, stakedId);
            // Bob: 18 + 10 (completion) + 5 (stake bonus) = 33 -> Trusted.
            const bobRep = await client.computeReputation(bobAddr);
            assert.strictEqual(bobRep.score, 33);
            assert.strictEqual(bobRep.level, 'Trusted');
            assert.strictEqual(bobRep.stakedCompleted, 1);
        });

        await step('Round 5 — cancel after accept burns the stake', async () => {
            await client.delegateTask(alice, rootId, carolAddr, 'Doomed subtask', 'Will be cancelled.');
            const doomedId = 6;
            await client.acceptDelegationStaked(carol, doomedId, 4);
            await client.cancelTask(alice, doomedId);
            // Carol: 14 - 4 (burned stake) = 10.
            const carolRep = await client.computeReputation(carolAddr);
            assert.strictEqual(carolRep.score, 10);
            assert.strictEqual(carolRep.stakedBurned, 1);
        });

        await step('Round 5 — profile extras: availability, guild, heartbeat', async () => {
            await client.setProfileExtras(alice, 1, '2 slots this week', 'research-guild', '', '');
            const x = await client.getProfileExtras(aliceAddr);
            assert.strictEqual(x.availability, 1);
            assert.strictEqual(x.availabilityName, 'Available');
            assert.strictEqual(x.capacityNote, '2 slots this week');
            assert.strictEqual(x.guild, 'research-guild');
            assert.ok(x.lastUpdated > 0, 'lastUpdated must be set by publish/setProfileExtras');
            // Ranked directory: Bob (33) above Alice (2); guild filter data present.
            const ranked = await client.listProfilesRanked();
            assert.strictEqual(ranked.length, 2);
            assert.strictEqual(ranked[0].profile.holder, bobAddr);
            assert.strictEqual(ranked[0].reputation.score, 33);
            assert.strictEqual(ranked[1].profile.holder, aliceAddr);
            assert.strictEqual(ranked[1].extras.guild, 'research-guild');
        });

        await step('Round 5 — Agent Card signature verifies for the holder only', async () => {
            const url = 'https://alice.example/.well-known/agent.json';
            const msg = EstafAgen.agentCardMessage(url);
            const sig = await alice.signMessage(msg);
            assert.strictEqual(EstafAgen.verifyAgentCardSignature(aliceAddr, url, sig), true);
            assert.strictEqual(EstafAgen.verifyAgentCardSignature(bobAddr, url, sig), false);
            assert.strictEqual(EstafAgen.verifyAgentCardSignature(aliceAddr, url, '0x1234'), false);
            // Shape check: A2A card needs a name and a named skills list.
            assert.strictEqual(EstafAgen.verifyAgentCardShape({ name: 'Alice', skills: [{ name: 'research' }] }).ok, true);
            assert.strictEqual(EstafAgen.verifyAgentCardShape({ name: 'Alice', skills: [] }).ok, false);
            assert.strictEqual(EstafAgen.verifyAgentCardShape({ skills: [{ name: 'x' }] }).ok, false);
            assert.strictEqual(EstafAgen.verifyAgentCardShape(null).ok, false);
            // Save the verified card on-chain; the ranked directory shows the badge.
            await client.setProfileExtras(alice, 1, '2 slots this week', 'research-guild', url, sig);
            const ranked = await client.listProfilesRanked();
            const aliceRow = ranked.find((r) => r.profile.holder === aliceAddr);
            assert.strictEqual(aliceRow.agentCardVerified, true);
            const bobRow = ranked.find((r) => r.profile.holder === bobAddr);
            assert.strictEqual(bobRow.agentCardVerified, false);
        });

        await step('Round 5 — Agent CV: Bob has 2 completed tasks, score 33, Trusted', async () => {
            const cv = await client.getAgentCV(bobAddr);
            assert.strictEqual(cv.profile.exists, true);
            assert.strictEqual(cv.reputation.score, 33);
            assert.strictEqual(cv.reputation.level, 'Trusted');
            assert.strictEqual(cv.completedTasks.length, 2);
            assert.deepStrictEqual(cv.completedTasks.map((t) => t.id).sort(), [2, 5]);
            assert.strictEqual(cv.reputation.qualityReceived.length, 1);
            assert.strictEqual(cv.reputation.qualityReceived[0].score, 5);
            // Private hash helper: keccak256 of the UTF-8 plaintext.
            assert.strictEqual(
                EstafAgen.contentHashFor('hello'),
                ethers.keccak256(ethers.toUtf8Bytes('hello'))
            );
        });

        await step('Round 5 Tier 2 — private delegation stores only the hash', async () => {
            const secret = 'Meet at dawn. The password is swordfish.';
            const hash = EstafAgen.contentHashFor(secret);
            await client.delegateTaskPrivate(alice, rootId, bobAddr, 'Secret subtask', hash);
            const t = await client.getTask(7);
            assert.strictEqual(t.title, 'Secret subtask');
            assert.strictEqual(t.description, '');
            assert.strictEqual(t.statusName, 'Delegated');
            assert.strictEqual(await client.getTaskContentHash(7), hash);
            assert.strictEqual(await client.isPrivateTask(7), true);
            assert.strictEqual(await client.isPrivateTask(subId), false);
            assert.strictEqual(await client.getTaskContentHash(subId), ethers.ZeroHash);
            // A wrong guess does not match the hash.
            assert.notStrictEqual(EstafAgen.contentHashFor('wrong guess'), hash);
        });

        await step('Round 5 Tier 2 — provenance tree: depths [0,1,2,1,1,1,1]', async () => {
            const tree = await client.getProvenance(rootId);
            assert.deepStrictEqual(tree.map((n) => n.task.id), [1, 2, 3, 4, 5, 6, 7]);
            assert.deepStrictEqual(tree.map((n) => n.depth), [0, 1, 2, 1, 1, 1, 1]);
        });

        await step('Round 5 Tier 2 — swarm: 5 subtasks under root, 2 completed (40%)', async () => {
            const swarm = await client.getSwarm(rootId);
            assert.strictEqual(swarm.total, 5);
            assert.strictEqual(swarm.completed, 2);
            assert.strictEqual(swarm.progressPct, 40);
            assert.strictEqual(swarm.counts.Delegated, 1); // task 7 (private)
            assert.strictEqual(swarm.counts.Rejected, 1);  // task 4
            assert.strictEqual(swarm.counts.Cancelled, 1); // task 6
            assert.strictEqual(swarm.counts.Completed, 2); // tasks 2 and 5
        });

        await step('Round 5 Tier 3 — analytics: 2 profiles, 7 tasks, 6 delegations, 60% completion', async () => {
            const a = await client.computeAnalytics();
            assert.strictEqual(a.profiles, 2);
            assert.strictEqual(a.tasks, 7);
            assert.strictEqual(a.delegations, 6);
            assert.strictEqual(a.completed, 3);
            assert.strictEqual(a.completionRate, 60); // 3 of 5 decided (3 completed, 1 rejected, 1 cancelled)
            assert.strictEqual(a.recentDelegations7d, 6);
            assert.strictEqual(a.topCapabilities.length, 4);
            const caps = Object.fromEntries(a.topCapabilities.map((c) => [c.capability, c.count]));
            assert.strictEqual(caps['market research'], 1);
            assert.strictEqual(caps['code'], 1);
            assert.strictEqual(a.topAgents[0].holder, bobAddr);
            assert.strictEqual(a.topAgents[0].score, 33);
            assert.strictEqual(a.topAgents[1].holder, carolAddr);
            assert.strictEqual(a.topAgents[1].score, 10);
            assert.strictEqual(a.guilds.length, 1);
            assert.strictEqual(a.guilds[0].guild, 'research-guild');
            assert.strictEqual(a.guilds[0].members, 1);
            assert.strictEqual(a.guilds[0].avgScore, 2);
        });

        await step('Alice removes her profile; directory no longer lists her', async () => {
            await client.removeProfile(alice);
            const remaining = await client.listProfiles();
            assert.strictEqual(remaining.length, 1);
            assert.strictEqual(remaining[0].holder, bobAddr);
            const all = await client.searchProfiles('');
            assert.strictEqual(all.length, 1);
        });

        await step('Task list reflects all 7 tasks, newest first', async () => {
            const tasks = await client.listTasks();
            assert.strictEqual(tasks.length, 7);
            assert.deepStrictEqual(tasks.map((t) => t.id), [7, 6, 5, 4, 3, 2, 1]);
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
