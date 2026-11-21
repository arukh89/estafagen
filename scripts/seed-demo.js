/**
 * EstafAgen — seed demo data on BSC Testnet (chain 97) against the Round 5
 * contract, so the reputation / CV / analytics / guild features show real
 * on-chain data instead of empty states.
 *
 * Run (deployer key from the testnet wallet file, never echoed, never
 * committed):
 *   TESTNET_PRIVATE_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME + '/workspace/goals/binance-agent-id-hackathon/hidden_files/testnet-wallet-bsc.json', 'utf8')).privateKey)") \
 *     npx hardhat run scripts/seed-demo.js --network bscTestnet
 *
 * What it does:
 *   1. Generates 3 fresh ephemeral demo wallets. Their keys are saved ONLY
 *      to deployments/seed-wallets-testnet.json (deployments/ is gitignored
 *      — never commit it) and are NEVER printed.
 *   2. Funds each demo wallet with 0.002 tBNB from the deployer (gas money).
 *   3. Grants each demo wallet mock holder status via the mock registry's
 *      TEST-ONLY setBalance (testnet demo data only).
 *   4. Each demo wallet publishes a profile clearly labeled "(seed)"/demo,
 *      with availability + capacity note + guild on two of them.
 *   5. Creates 4 root tasks and delegates one subtask from each (one
 *      staked acceptance via acceptDelegationStaked, one private delegation
 *      via delegateTaskPrivate with a content hash), accepts, completes,
 *      and attests both sides (quality by delegator, brief by assignee).
 *   6. Verifies the seeded state on-chain via the publicnode RPC (the
 *      data-seed RPC refuses eth_getLogs) and recomputes each demo agent's
 *      reputation with the documented formula.
 *
 * Testnet only. No real holder data is involved.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const PUBLIC_RPC = 'https://bsc-testnet.publicnode.com';
const FUND_TBNB = '0.002';
const STAKE = 5;

// Reputation formula (mirrors frontend/estafagen.js replayReputation):
// +10 per completed delegation (assignee); +stake on staked completion;
// +(stars-3)*2 per QualityAttested received (assignee) and per BriefAttested
// received (creator); -stake on cancel-after-accept with stake, -2 without.
// Score floored at 0. Levels: 0-9 Newcomer, 10-29 Rising, 30-99 Trusted, 100+ Elite.
const POINTS_PER_COMPLETION = 10;
const CANCEL_NO_STAKE_PENALTY = 2;

function reputationLevel(score) {
    if (score >= 100) return 'Elite';
    if (score >= 30) return 'Trusted';
    if (score >= 10) return 'Rising';
    return 'Newcomer';
}

async function main() {
    const hre = require('hardhat');
    const { ethers } = hre;

    if (!process.env.TESTNET_PRIVATE_KEY) {
        throw new Error('TESTNET_PRIVATE_KEY is not set. Refusing to seed.');
    }

    const deployment = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'deployments', 'bsc-testnet.json'), 'utf8')
    );
    const ESTAFAGEN = deployment.estafagen.address;
    const MOCK = deployment.registry.address;
    const DEPLOYED_FROM_BLOCK = deployment.registry.blockNumber;
    console.log(`EstafAgen: ${ESTAFAGEN}`);
    console.log(`Mock:      ${MOCK}`);

    // ALL reads + writes go through the publicnode RPC, NOT the hardhat
    // data-seed provider. Lesson from the resume run (22 Nov 2026):
    // data-seed is a multi-node cluster with inconsistent reads — after
    // createTask mined, taskCount() still returned the OLD value on the
    // node that answered, so newId() computed parentId 0 and delegateTask
    // reverted NotDelegatable. publicnode is a single consistent endpoint
    // (verified for eth_call + eth_getLogs + sends).
    const provider = new ethers.JsonRpcProvider(PUBLIC_RPC);
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== 97) {
        throw new Error(`Expected BSC Testnet (chainId 97), got ${net.chainId}. Refusing to seed.`);
    }

    const deployer = new ethers.Wallet(process.env.TESTNET_PRIVATE_KEY, provider);
    const deployerAddr = await deployer.getAddress();
    const balBefore = await provider.getBalance(deployerAddr);
    console.log(`Deployer: ${deployerAddr} (${ethers.formatEther(balBefore)} tBNB)`);

    const estafagenAbi = require('../artifacts/contracts/EstafAgen.sol/EstafAgen.json').abi;
    const mockAbi = require('../artifacts/contracts/MockAgentIdRegistry.sol/MockAgentIdRegistry.json').abi;
    const estafagen = new ethers.Contract(ESTAFAGEN, estafagenAbi, deployer);
    const mock = new ethers.Contract(MOCK, mockAbi, deployer);

    // --- Demo wallets (ephemeral; keys saved gitignored, never printed) ---
    const demos = [
        {
            role: 'Scout',
            name: 'Demo Scout (seed)',
            capabilities: 'web research, data gathering',
            description: 'Demo agent seeded on testnet — not a real holder.',
            availability: 1, // available
            capacityNote: 'Takes up to 3 research tasks (demo)',
            guild: 'Seed Guild (demo)',
        },
        {
            role: 'Writer',
            name: 'Demo Writer (seed)',
            capabilities: 'technical writing, editing',
            description: 'Demo agent seeded on testnet — not a real holder.',
            availability: 1, // available
            capacityNote: 'Takes up to 2 writing tasks (demo)',
            guild: 'Seed Guild (demo)',
        },
        {
            role: 'Analyst',
            name: 'Demo Analyst (seed)',
            capabilities: 'data analysis, reporting',
            description: 'Demo agent seeded on testnet — not a real holder.',
            availability: 2, // busy
            capacityNote: 'Busy until next week (demo)',
            guild: '',
        },
    ];
    for (const d of demos) {
        d.contract = null; // set below once the wallet is attached
    }
    // Wallets: reuse the saved record on a re-run (resumable), otherwise
    // generate fresh wallets and save their keys IMMEDIATELY (before any tx)
    // so an interrupted run never loses them.
    const seedPath = path.join(__dirname, '..', 'deployments', 'seed-wallets-testnet.json');
    if (fs.existsSync(seedPath)) {
        const existing = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
        console.log(`Reusing existing seed record ${seedPath} (resuming)`);
        for (const d of demos) {
            const saved = existing.wallets.find((w) => w.role === d.role);
            if (!saved) throw new Error(`Seed record has no wallet for role ${d.role} — delete the record for a fresh seed.`);
            d.wallet = new ethers.Wallet(saved.privateKey, provider);
            d.address = saved.address;
            d.privateKey = saved.privateKey;
            d.contract = new ethers.Contract(ESTAFAGEN, estafagenAbi, d.wallet);
        }
    } else {
        for (const d of demos) {
            const w = ethers.Wallet.createRandom();
            d.wallet = new ethers.Wallet(w.privateKey, provider);
            d.address = await d.wallet.getAddress();
            d.privateKey = w.privateKey; // saved to the gitignored file only, never printed
            d.contract = new ethers.Contract(ESTAFAGEN, estafagenAbi, d.wallet);
        }
        fs.writeFileSync(seedPath, JSON.stringify({
            network: 'bscTestnet',
            chainId: 97,
            estafagen: ESTAFAGEN,
            mock: MOCK,
            seededAt: new Date().toISOString(),
            note: 'TESTNET DEMO WALLETS ONLY — ephemeral seed data, never use on mainnet, never commit.',
            wallets: demos.map((d) => ({
                role: d.role,
                address: d.address,
                privateKey: d.privateKey,
                name: d.name,
            })),
            tasks: {},
        }, null, 2) + '\n');
        console.log(`Saved demo wallet keys to ${seedPath} (local only — do not commit, keys inside)`);
    }

    let totalGas = 0n;
    let txCount = 0;

    // Wait for a sent tx's receipt, tolerating transient RPC hiccups.
    // A mined-but-reverted tx (status 0) is a hard failure — never retried.
    async function waitReceipt(tx, label) {
        let receipt = null;
        try {
            receipt = await tx.wait();
        } catch (waitErr) {
            // Transient RPC hiccup while waiting: the tx may still have
            // mined. Poll for its receipt directly instead of failing.
            console.log(`  ${label} — wait() threw (${waitErr.message}); polling receipt for ${tx.hash}...`);
            for (let i = 0; i < 60; i++) {
                await new Promise((r) => setTimeout(r, 1000));
                try {
                    receipt = await provider.getTransactionReceipt(tx.hash);
                } catch (_) { /* keep polling through RPC blips */ }
                if (receipt) break;
            }
            if (!receipt) throw new Error(`${label}: no receipt after 60s for ${tx.hash} (wait error was: ${waitErr.message})`);
        }
        if (receipt.status !== 1) {
            throw new Error(`${label}: tx ${tx.hash} mined but REVERTED (status 0) — not retrying`);
        }
        // Round 5 waitTx lesson: after tx.wait() the tip can still lag the
        // receipt block — poll until the tip catches up before reading.
        // A failing poll must not kill the script; it is only a settle-wait.
        const target = receipt.blockNumber;
        for (let i = 0; i < 30; i++) {
            try {
                const tip = await provider.getBlockNumber();
                if (tip >= target) break;
            } catch (_) { /* RPC blip: sleep and retry */ }
            await new Promise((r) => setTimeout(r, 500));
        }
        totalGas += receipt.gasUsed;
        txCount++;
        console.log(`  [tx ${txCount}] ${label} — ${tx.hash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
        return receipt;
    }

    // Plain value transfer (funding): fixed 21000 gas, no estimation needed.
    async function sendRaw(promise, label) {
        return waitReceipt(await promise, label);
    }

    // New task ids come from the tx receipt's own events (TaskCreated /
    // TaskDelegated), never from a follow-up taskCount() read — the latter
    // can return a stale value on a load-balanced RPC cluster (see the
    // publicnode note above) and produced parentId 0 in the resume run.
    function taskIdFromReceipt(receipt, eventName) {
        for (const log of receipt.logs) {
            try {
                const parsed = estafagen.interface.parseLog(log);
                if (parsed && parsed.name === eventName) return Number(parsed.args.taskId);
            } catch (_) { /* log is not one of our events */ }
        }
        throw new Error(`No ${eventName} event in receipt ${receipt.hash}`);
    }

    // Contract call with a gas buffer. Lesson from the first seed run
    // (22 Nov 2026): ethers sends with gasLimit = estimate exactly, and the
    // BSC data-seed estimate for setProfileExtras came in ~2.5% LOW
    // (158,653 vs 162,684 actually needed), so the tx ran out of gas and
    // reverted on-chain even though staticCall succeeded. A 30% buffer +
    // 10,000 gas covers that estimation variance.
    async function sendCall(label, contract, method, args) {
        const est = await contract[method].estimateGas(...args);
        const gasLimit = (est * 13n) / 10n + 10000n;
        console.log(`  ${label} — estimate ${est}, sending with gasLimit ${gasLimit}`);
        const tx = await contract[method](...args, { gasLimit });
        return waitReceipt(tx, label);
    }

    // --- 1. Fund demo wallets (skip when already funded — resumable) ---
    console.log('\nFunding demo wallets...');
    for (const d of demos) {
        const bal = await provider.getBalance(d.address);
        if (bal >= ethers.parseEther('0.0015')) {
            console.log(`  ${d.role} already funded (${ethers.formatEther(bal)} tBNB) — skipping`);
            continue;
        }
        await sendRaw(
            deployer.sendTransaction({ to: d.address, value: ethers.parseEther(FUND_TBNB) }),
            `fund ${d.role} ${FUND_TBNB} tBNB`
        );
    }

    // --- 2. Grant mock holder status (TEST-ONLY setBalance; skip if holder) ---
    console.log('Granting mock holder status...');
    for (const d of demos) {
        if (await estafagen.isHolder(d.address)) {
            console.log(`  ${d.role} already a holder — skipping`);
            continue;
        }
        await sendCall(`setBalance(${d.role}, 1)`, mock, 'setBalance', [d.address, 1]);
        console.log(`  isHolder(${d.role}): ${await estafagen.isHolder(d.address)}`);
    }

    // --- 3. Publish profiles + extras (skip steps already done — resumable) ---
    console.log('Publishing profiles...');
    for (const d of demos) {
        if (await d.contract.hasProfile(d.address)) {
            console.log(`  ${d.role} profile already published — skipping publish`);
        } else {
            await sendCall(
                `${d.role} publishProfile`,
                d.contract, 'publishProfile', [d.name, d.capabilities, d.description]
            );
        }
        const ex = await d.contract.getProfileExtras(d.address);
        if (ex[1] === d.capacityNote && ex[2] === d.guild) {
            console.log(`  ${d.role} extras already set — skipping`);
        } else {
            await sendCall(
                `${d.role} setProfileExtras (availability=${d.availability}, guild=${d.guild || '(none)'})`,
                d.contract, 'setProfileExtras', [d.availability, d.capacityNote, d.guild, '', '']
            );
        }
    }

    // --- 4. Tasks: 4 roots, 4 subtasks (one staked, one private) ---
    // Fully resumable: every step first checks on-chain state and reuses
    // what a previous (interrupted) run already created, so re-running
    // never duplicates demo data.
    const [scout, writer, analyst] = demos;
    const tasks = {}; // label -> subtask id
    let r1, r2, r3, r4, contentHash; // filled by the task section below
    console.log('Creating + delegating tasks...');

    async function findRoot(title, creatorAddr) {
        const evs = await estafagen.queryFilter(estafagen.filters.TaskCreated, DEPLOYED_FROM_BLOCK);
        for (const ev of evs) {
            const id = Number(ev.args.taskId);
            if (ev.args.creator.toLowerCase() !== creatorAddr.toLowerCase()) continue;
            const t = await estafagen.getTask(id);
            if (t.title === title && Number(t.parentId) === 0 && (Number(t.status) === 0 || Number(t.status) === 2)) return id;
        }
        return null;
    }
    async function findSubtask(parentId, assigneeAddr) {
        const evs = await estafagen.queryFilter(estafagen.filters.TaskDelegated, DEPLOYED_FROM_BLOCK);
        for (const ev of evs) {
            if (Number(ev.args.parentId) === parentId && ev.args.assignee.toLowerCase() === assigneeAddr.toLowerCase()) return Number(ev.args.taskId);
        }
        return null;
    }
    async function taskStatus(id) {
        return Number((await estafagen.getTask(id)).status);
    }
    async function ensureRoot(title, description, creator) {
        const existing = await findRoot(title, creator.address);
        if (existing !== null) {
            console.log(`  root "${title}" already exists (id ${existing}) — reusing`);
            return existing;
        }
        return taskIdFromReceipt(
            await sendCall(`create root "${title}"`, creator.contract, 'createTask', [title, description]),
            'TaskCreated'
        );
    }
    async function ensureSubtask(parentId, assignee, delegator, title, description, isPrivate, hash) {
        const existing = await findSubtask(parentId, assignee.address);
        if (existing !== null) {
            console.log(`  subtask "${title}" already exists (id ${existing}) — reusing`);
            return existing;
        }
        const method = isPrivate ? 'delegateTaskPrivate' : 'delegateTask';
        const args = isPrivate
            ? [parentId, assignee.address, title, hash]
            : [parentId, assignee.address, title, description];
        return taskIdFromReceipt(
            await sendCall(`delegate "${title}" -> ${assignee.role}`, delegator.contract, method, args),
            'TaskDelegated'
        );
    }
    async function ensureAccepted(id, assignee, stake) {
        const st = await taskStatus(id);
        if (st === 2 || st === 3) {
            console.log(`  task ${id} already accepted/completed (status ${st}) — skipping accept`);
            return;
        }
        if (stake) {
            await sendCall(`accept task ${id} staked (${stake})`, assignee.contract, 'acceptDelegationStaked', [id, stake]);
        } else {
            await sendCall(`accept task ${id}`, assignee.contract, 'acceptDelegation', [id]);
        }
    }
    async function ensureCompleted(id, assignee) {
        const st = await taskStatus(id);
        if (st === 3) {
            console.log(`  task ${id} already completed — skipping complete`);
            return;
        }
        await sendCall(`complete task ${id}`, assignee.contract, 'completeTask', [id]);
    }
    async function ensureAttested(id, delegator, assignee, qScore, bScore) {
        const q = await estafagen.getQualityAttestation(id);
        if (!q.exists) {
            await sendCall(`attestQuality task ${id} = ${qScore}`, delegator.contract, 'attestQuality', [id, qScore]);
        } else {
            console.log(`  task ${id} quality already attested (${q.score}) — skipping`);
        }
        const b = await estafagen.getBriefAttestation(id);
        if (!b.exists) {
            await sendCall(`attestBrief task ${id} = ${bScore}`, assignee.contract, 'attestBrief', [id, bScore]);
        } else {
            console.log(`  task ${id} brief already attested (${b.score}) — skipping`);
        }
    }

    // T1: Scout creates, delegates to Writer (plain accept).
    r1 = await ensureRoot('Research BSC testnet RPCs (demo)', 'Compare public BSC Testnet RPC endpoints for reliability (demo).', scout);
    tasks.t1 = await ensureSubtask(r1, writer, scout, 'Research BSC testnet RPCs (demo)', 'Compare public BSC Testnet RPC endpoints for reliability (demo).', false, null);
    await ensureAccepted(tasks.t1, writer, 0);
    await ensureCompleted(tasks.t1, writer);
    await ensureAttested(tasks.t1, scout, writer, 5, 4);

    // T2: Writer creates, delegates to Analyst (STAKED accept, stake 5).
    r2 = await ensureRoot('Draft EstafAgen demo report (demo)', 'Write a short report on the seeded demo data (demo).', writer);
    tasks.t2 = await ensureSubtask(r2, analyst, writer, 'Draft EstafAgen demo report (demo)', 'Write a short report on the seeded demo data (demo).', false, null);
    await ensureAccepted(tasks.t2, analyst, STAKE);
    await ensureCompleted(tasks.t2, analyst);
    await ensureAttested(tasks.t2, writer, analyst, 4, 5);

    // T3: Analyst creates, delegates to Scout (plain accept).
    r3 = await ensureRoot('Summarize delegation data (demo)', 'Summarize the completed delegations into a table (demo).', analyst);
    tasks.t3 = await ensureSubtask(r3, scout, analyst, 'Summarize delegation data (demo)', 'Summarize the completed delegations into a table (demo).', false, null);
    await ensureAccepted(tasks.t3, scout, 0);
    await ensureCompleted(tasks.t3, scout);
    await ensureAttested(tasks.t3, analyst, scout, 5, 5);

    // T4: Scout creates, delegates PRIVATELY to Analyst (content hash only on-chain).
    const privatePlaintext = 'demo secret brief: review the seed report by Friday (demo)';
    contentHash = ethers.keccak256(ethers.toUtf8Bytes(privatePlaintext));
    r4 = await ensureRoot('Confidential handoff (demo)', '', scout);
    tasks.t4 = await ensureSubtask(r4, analyst, scout, 'Confidential handoff (demo)', '', true, contentHash);
    await ensureAccepted(tasks.t4, analyst, 0);
    await ensureCompleted(tasks.t4, analyst);
    await ensureAttested(tasks.t4, scout, analyst, 4, 4);
    console.log(`  private content hash: ${contentHash}`);
    console.log(`  private plaintext (demo only, verify in UI by re-hashing): "${privatePlaintext}"`);

    // --- 5. Update the seed record with the task mapping. ---
    {
        const seedRecord = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
        seedRecord.tasks = {
            t1: { root: r1, subtask: tasks.t1, delegator: scout.address, assignee: writer.address },
            t2: { root: r2, subtask: tasks.t2, delegator: writer.address, assignee: analyst.address, stake: STAKE },
            t3: { root: r3, subtask: tasks.t3, delegator: analyst.address, assignee: scout.address },
            t4: { root: r4, subtask: tasks.t4, delegator: scout.address, assignee: analyst.address, private: true, contentHash },
        };
        fs.writeFileSync(seedPath, JSON.stringify(seedRecord, null, 2) + '\n');
        console.log(`\nUpdated ${seedPath} with the task mapping (local only — do not commit, keys inside)`);
    }

    // --- 6. Verify seeded state on-chain via publicnode (data-seed refuses eth_getLogs) ---
    console.log('\nVerifying seeded state via publicnode...');
    const readProvider = new ethers.JsonRpcProvider(PUBLIC_RPC);
    const readContract = new ethers.Contract(ESTAFAGEN, estafagenAbi, readProvider);
    const taskCount = Number(await readContract.taskCount());
    console.log(`taskCount: ${taskCount}`);

    const fromBlock = DEPLOYED_FROM_BLOCK;
    const [profiles, delegated, accepted, completed, quality, brief, staked] = await Promise.all([
        readContract.queryFilter(readContract.filters.ProfilePublished, fromBlock),
        readContract.queryFilter(readContract.filters.TaskDelegated, fromBlock),
        readContract.queryFilter(readContract.filters.DelegationAccepted, fromBlock),
        readContract.queryFilter(readContract.filters.TaskCompleted, fromBlock),
        readContract.queryFilter(readContract.filters.QualityAttested, fromBlock),
        readContract.queryFilter(readContract.filters.BriefAttested, fromBlock),
        readContract.queryFilter(readContract.filters.ReputationStaked, fromBlock),
    ]);
    console.log(`events: ProfilePublished=${profiles.length} TaskDelegated=${delegated.length} DelegationAccepted=${accepted.length} TaskCompleted=${completed.length} QualityAttested=${quality.length} BriefAttested=${brief.length} ReputationStaked=${staked.length}`);

    // Reputation replay (same formula as frontend/estafagen.js).
    const reps = {};
    function rep(addr) {
        const k = addr.toLowerCase();
        if (!reps[k]) reps[k] = { address: addr, score: 0, completed: 0, stakedCompleted: 0 };
        return reps[k];
    }
    const subtasks = {};
    for (const ev of delegated) {
        subtasks[Number(ev.args.taskId)] = { creator: ev.args.delegator, assignee: ev.args.assignee, stake: 0, status: 'Delegated' };
    }
    for (const ev of staked) {
        const t = subtasks[Number(ev.args.taskId)];
        if (t) t.stake = Number(ev.args.stake);
    }
    for (const ev of completed) {
        const t = subtasks[Number(ev.args.taskId)];
        if (t) {
            t.status = 'Completed';
            const r = rep(ev.args.assignee);
            r.completed++;
            r.score += POINTS_PER_COMPLETION;
            if (t.stake > 0) { r.score += t.stake; r.stakedCompleted++; }
        }
    }
    for (const ev of quality) rep(ev.args.assignee).score += (Number(ev.args.score) - 3) * 2;
    for (const ev of brief) rep(ev.args.creator).score += (Number(ev.args.score) - 3) * 2;

    console.log('\nReputation (from on-chain events):');
    for (const d of demos) {
        const r = reps[d.address.toLowerCase()] || { score: 0, completed: 0, stakedCompleted: 0 };
        const score = Math.max(0, r.score);
        console.log(`  ${d.role} ${d.address}: score=${score} level=${reputationLevel(score)} completed=${r.completed} stakedCompleted=${r.stakedCompleted}`);
    }

    const balAfter = await provider.getBalance(deployerAddr);
    console.log(`\nSeed txs: ${txCount}, total gas used: ${totalGas}`);
    console.log(`Deployer balance: ${ethers.formatEther(balBefore)} -> ${ethers.formatEther(balAfter)} tBNB`);
}

main().catch((err) => {
    console.error('seed-demo failed:', err && err.message ? err.message : err);
    process.exitCode = 1;
});
