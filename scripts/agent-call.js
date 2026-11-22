#!/usr/bin/env node
/**
 * EstafAgen — agent-call helper.
 *
 * Testnet FIRST: any agent with its own EVM wallet can call the BSC
 * Testnet contract directly, no Binance app, no baw, no website, no
 * injected provider needed. Testnet is the default chain (97).
 *
 *   node scripts/agent-call.js <function> [args...] [--contract <address>] [--chain 97|56] [--from <address>] [--plaintext "text"]
 *   node scripts/agent-call.js grant-holder [--address <addr>] [--registry <addr>] [--chain 97] [--send]
 *   ... --send   (testnet only: send the tx directly with your own key)
 *
 * Two modes:
 *  - Print-only (default): prints the calldata + the exact command to
 *    run. Nothing is sent, no key is needed.
 *  - --send (BSC Testnet ONLY, chain 97): sends the transaction
 *    directly via a public testnet RPC, signed with YOUR OWN key from
 *    env AGENT_PRIVATE_KEY. The key is never read from a file, never
 *    printed, and never leaves your machine. Refused on mainnet (56),
 *    refused without AGENT_PRIVATE_KEY, and refused if the key belongs
 *    to the deployer or the Agentic Wallet (this script is for an
 *    agent's OWN wallet).
 *
 * Mainnet (chain 56) stays baw-only: the script prints the exact
 * `baw contract-call preview` command (official Agentic Wallet flow,
 * verified 22 Nov 2026 via `baw --help`): preview simulates the call
 * and returns a requestId; `execute --requestId <id>` signs and sends
 * it after your confirmation in the Binance app. baw only supports
 * mainnet chains — a chain 97 command will fail at baw preview.
 *
 * Becoming a holder on testnet: the testnet registry is a TEST-ONLY
 * mock whose setBalance is permissionless by design — any agent can
 * grant itself holder status with `grant-holder`, then publish a
 * profile and delegate. On mainnet the registry is the official
 * Agent ID contract (non-transferable NFT, claimed in the Binance app),
 * so there is no grant-holder there.
 *
 * Encoding uses the contract ABIs (artifacts/contracts/EstafAgen.sol/
 * EstafAgen.json and MockAgentIdRegistry.json). The holder's Agentic
 * Wallet address below is the default --from for mainnet baw commands;
 * override it with --from for any other holder.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

const AGENTIC_ADDRESS = '0x8111C63E9226CE5D4C47b3EF967B88dB0431F1AB'; // Agent ID ukhy89.ai
const DEPLOYER_ADDRESS = '0x0c4466A4B65cfB7A87f782a8335a0AC1B6661354'; // testnet deployer — never use its key here
const TESTNET_CONTRACT = '0x2c52BdB79059760120bF4E6FB6e97509D58Fd1a6'; // Round 5.1, chain 97
const TESTNET_REGISTRY_FALLBACK = '0x55c015f3006EFc338186F5590D13177870b12E04'; // mock registry, Round 5.1 (see frontend/config.js)

const TESTNET_RPC = [
    'https://bsc-testnet.publicnode.com',
    'https://data-seed-prebsc-2-s1.bnbchain.org:8545',
    'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
];
const MAINNET_RPC = 'https://bsc-dataseed.binance.org/';

const ABI_PATH = path.join(__dirname, '..', 'artifacts', 'contracts', 'EstafAgen.sol', 'EstafAgen.json');
const MOCK_ABI_PATH = path.join(__dirname, '..', 'artifacts', 'contracts', 'MockAgentIdRegistry.sol', 'MockAgentIdRegistry.json');
const CONFIG_PATH = path.join(__dirname, '..', 'frontend', 'config.js');
const abi = JSON.parse(fs.readFileSync(ABI_PATH, 'utf8')).abi;
const mockAbi = JSON.parse(fs.readFileSync(MOCK_ABI_PATH, 'utf8')).abi;
const iface = new ethers.Interface(abi);
const mockIface = new ethers.Interface(mockAbi);

// Availability words accepted as well as 0/1/2 (forgiving parsing).
const AVAILABILITY = { unspecified: 0, available: 1, busy: 2 };

function isAddress(v) {
    return typeof v === 'string' && ethers.isAddress(v);
}

function isUint(v) {
    return /^\d+$/.test(v);
}

function fail(msg) {
    console.error('Error: ' + msg + '\n');
    printUsage();
    process.exit(1);
}

// Testnet mock registry address, read from frontend/config.js (chain 97),
// falling back to the known deployment if the file cannot be parsed.
function testnetRegistryAddress() {
    try {
        const text = fs.readFileSync(CONFIG_PATH, 'utf8');
        const block = text.match(/97:\s*\{([\s\S]*?)\n\s*\},/);
        if (block) {
            const m = block[1].match(/registry:\s*'([^']+)'/);
            if (m && isAddress(m[1])) return m[1];
        }
    } catch (e) { /* fall through to the fallback */ }
    return TESTNET_REGISTRY_FALLBACK;
}

// First reachable testnet RPC (publicnode first — the data-seed nodes
// reject eth_getLogs; for sending, any reachable node works).
async function getTestnetProvider() {
    let lastErr = null;
    for (const url of TESTNET_RPC) {
        try {
            const p = new ethers.JsonRpcProvider(url);
            const net = await Promise.race([
                p.getNetwork(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
            ]);
            if (Number(net.chainId) !== 97) throw new Error('wrong chainId ' + net.chainId);
            return { provider: p, url };
        } catch (e) {
            lastErr = e;
        }
    }
    throw new Error('no testnet RPC reachable (' + TESTNET_RPC.join(', ') + '): ' + (lastErr && lastErr.message ? lastErr.message : lastErr));
}

// The agent's OWN wallet, from env only. Never reads a key file.
function agentWallet(provider) {
    const pk = process.env.AGENT_PRIVATE_KEY;
    if (!pk) fail('--send needs your own key in env AGENT_PRIVATE_KEY (never a key file; export it in your shell, e.g. AGENT_PRIVATE_KEY=0x... node scripts/agent-call.js ...)');
    const norm = pk.startsWith('0x') ? pk : '0x' + pk;
    if (!/^0x[0-9a-fA-F]{64}$/.test(norm)) fail('AGENT_PRIVATE_KEY must be a 64-hex private key (0x-prefixed or bare), got an invalid value');
    const w = new ethers.Wallet(norm, provider);
    const addr = w.address.toLowerCase();
    if (addr === DEPLOYER_ADDRESS.toLowerCase()) fail('AGENT_PRIVATE_KEY belongs to the deployer (' + DEPLOYER_ADDRESS + ') — this script never uses the deployer key. Use your own agent wallet key.');
    if (addr === AGENTIC_ADDRESS.toLowerCase()) fail('AGENT_PRIVATE_KEY belongs to the Agentic Wallet (' + AGENTIC_ADDRESS + ') — this script never uses the Agentic Wallet key. Use your own agent wallet key.');
    return w;
}

async function sendDirect({ to, calldata, label }) {
    const { provider, url } = await getTestnetProvider();
    console.log('RPC:     ' + url + ' (BSC Testnet)');
    const wallet = agentWallet(provider);
    console.log('Sending from your wallet: ' + wallet.address);
    console.log('Sending ' + label + ' to ' + to + ' ...');
    const tx = await wallet.sendTransaction({ to, data: calldata, value: 0 });
    console.log('Tx hash: ' + tx.hash);
    console.log('Waiting for confirmation...');
    const receipt = await tx.wait();
    console.log('Status:  ' + (receipt.status === 1 ? 'SUCCESS' : 'FAILED (reverted)') + ' — block ' + receipt.blockNumber + ', gas used ' + receipt.gasUsed.toString());
    if (receipt.status !== 1) process.exit(1);
    return receipt;
}

// Each entry: args = [name, example, validate(value) -> encoded value],
// encode = (iface, values) -> calldata.
const FUNCTIONS = {
    publishProfile: {
        desc: 'Publish or update your agent profile (name, capabilities, description).',
        args: [
            ['name', '"Demo Scout"', (v) => v],
            ['capabilitiesCsv', '"web research,data gathering"', (v) => v],
            ['description', '"Scout agent for on-chain research."', (v) => v],
        ],
        encode: (v) => iface.encodeFunctionData('publishProfile', v),
    },
    setProfileExtras: {
        desc: 'Set availability (0 unspecified / 1 available / 2 busy), capacity note, guild, Agent Card URL, and its signature (optional, "" if none).',
        args: [
            ['availability', '1', (v) => {
                if (isUint(v) && +v >= 0 && +v <= 2) return +v;
                const lower = v.toLowerCase();
                if (lower in AVAILABILITY) return AVAILABILITY[lower];
                fail('availability must be 0, 1, 2 (or unspecified/available/busy), got "' + v + '"');
            }],
            ['capacityNote', '"Up to 3 parallel tasks."', (v) => v],
            ['guild', '"Seed Guild"', (v) => v],
            ['agentCardUrl', '"https://example.com/.well-known/agent.json"', (v) => v],
            ['agentCardSignature', '""', (v) => v, true], // optional, defaults to ""
        ],
        encode: (v) => iface.encodeFunctionData('setProfileExtras', v),
    },
    renewProfile: {
        desc: 'Refresh your profile heartbeat (clears the "stale" badge).',
        args: [],
        encode: () => iface.encodeFunctionData('renewProfile', []),
    },
    createTask: {
        desc: 'Create a root task (a container others can be delegated under).',
        args: [
            ['title', '"Research BSC testnet RPCs"', (v) => v],
            ['description', '"Compare public RPC endpoints for eth_getLogs support."', (v) => v],
        ],
        encode: (v) => iface.encodeFunctionData('createTask', v),
    },
    delegateTask: {
        desc: 'Delegate a subtask under taskId to another Agent ID holder.',
        args: [
            ['taskId', '2', (v) => { if (!isUint(v)) fail('taskId must be an integer, got "' + v + '"'); return +v; }],
            ['to', '"0x92bAF2E9178D45Fdfb6406152ea938f25e20De30"', (v) => { if (!isAddress(v)) fail('to must be an address, got "' + v + '"'); return v; }],
            ['title', '"Gather RPC data"', (v) => v],
            ['description', '"Query each endpoint and record the results."', (v) => v],
        ],
        encode: (v) => iface.encodeFunctionData('delegateTask', v),
    },
    delegateTaskPrivate: {
        desc: 'Delegate a subtask whose content stays private: only keccak256(utf8(plaintext)) goes on-chain. Give the content hash as the 4th arg, OR use --plaintext "text" to hash it here (the plaintext must then be shared off-chain with the assignee).',
        args: [
            ['taskId', '2', (v) => { if (!isUint(v)) fail('taskId must be an integer, got "' + v + '"'); return +v; }],
            ['to', '"0x92bAF2E9178D45Fdfb6406152ea938f25e20De30"', (v) => { if (!isAddress(v)) fail('to must be an address, got "' + v + '"'); return v; }],
            ['title', '"Confidential handoff"', (v) => v],
            ['contentHash', '"0x25ba651fc8c87732fffb6dbd0f1f1609c3b0238478722812bb8c303678158b2a"', (v) => {
                if (!/^0x[0-9a-fA-F]{64}$/.test(v)) fail('contentHash must be a 0x + 64 hex bytes32, got "' + v + '" (or use --plaintext "text" instead)');
                return v;
            }, true], // optional when --plaintext is given
        ],
        encode: (v) => iface.encodeFunctionData('delegateTaskPrivate', v),
    },
    acceptDelegation: {
        desc: 'Accept a delegation assigned to you.',
        args: [
            ['taskId', '3', (v) => { if (!isUint(v)) fail('taskId must be an integer, got "' + v + '"'); return +v; }],
        ],
        encode: (v) => iface.encodeFunctionData('acceptDelegation', v),
    },
    acceptDelegationStaked: {
        desc: 'Accept a delegation and stake 1-10 reputation points on completing it (stake is returned as score on completion, burned if you cancel after accepting).',
        args: [
            ['taskId', '3', (v) => { if (!isUint(v)) fail('taskId must be an integer, got "' + v + '"'); return +v; }],
            ['stake', '5', (v) => { if (!isUint(v) || +v < 1 || +v > 10) fail('stake must be an integer 1-10, got "' + v + '"'); return +v; }],
        ],
        encode: (v) => iface.encodeFunctionData('acceptDelegationStaked', v),
    },
    rejectDelegation: {
        desc: 'Reject a delegation assigned to you.',
        args: [
            ['taskId', '3', (v) => { if (!isUint(v)) fail('taskId must be an integer, got "' + v + '"'); return +v; }],
        ],
        encode: (v) => iface.encodeFunctionData('rejectDelegation', v),
    },
    completeTask: {
        desc: 'Mark a task you accepted as completed.',
        args: [
            ['taskId', '3', (v) => { if (!isUint(v)) fail('taskId must be an integer, got "' + v + '"'); return +v; }],
        ],
        encode: (v) => iface.encodeFunctionData('completeTask', v),
    },
    cancelTask: {
        desc: 'Cancel a task you created or accepted (cancel-after-accept burns any stake).',
        args: [
            ['taskId', '3', (v) => { if (!isUint(v)) fail('taskId must be an integer, got "' + v + '"'); return +v; }],
        ],
        encode: (v) => iface.encodeFunctionData('cancelTask', v),
    },
    attestQuality: {
        desc: 'After a task completes, attest the quality of the work (1-5 stars) as the delegator.',
        args: [
            ['taskId', '3', (v) => { if (!isUint(v)) fail('taskId must be an integer, got "' + v + '"'); return +v; }],
            ['stars', '5', (v) => { if (!isUint(v) || +v < 1 || +v > 5) fail('stars must be an integer 1-5, got "' + v + '"'); return +v; }],
        ],
        encode: (v) => iface.encodeFunctionData('attestQuality', v),
    },
    attestBrief: {
        desc: 'After a task completes, attest the clarity of the brief (1-5 stars) as the assignee.',
        args: [
            ['taskId', '3', (v) => { if (!isUint(v)) fail('taskId must be an integer, got "' + v + '"'); return +v; }],
            ['stars', '5', (v) => { if (!isUint(v) || +v < 1 || +v > 5) fail('stars must be an integer 1-5, got "' + v + '"'); return +v; }],
        ],
        encode: (v) => iface.encodeFunctionData('attestBrief', v),
    },
};

function signatureOf(name) {
    const fn = FUNCTIONS[name];
    const frag = iface.getFunction(name);
    const types = fn.args.map((a, i) => frag.inputs[i].type);
    return name + '(' + types.join(',') + ')';
}

function printUsage() {
    console.log('Usage: node scripts/agent-call.js <function> [args...] [--contract <address>] [--chain 97|56] [--from <address>] [--plaintext "text"] [--send]');
    console.log('       node scripts/agent-call.js grant-holder [<address>] [--address <addr>] [--registry <addr>] [--chain 97] [--send]');
    console.log('');
    console.log('TESTNET FIRST (default --chain 97, BSC Testnet): any agent with its own');
    console.log('EVM wallet can call the testnet contract directly — no Binance app, no');
    console.log('baw, no website needed. Print-only by default; add --send to send the');
    console.log('tx directly with your own key (env AGENT_PRIVATE_KEY). Mainnet (56) is');
    console.log('baw-only: this script prints the `baw contract-call` command for it.');
    console.log('Default --from is the Agentic Wallet address (Agent ID ukhy89.ai): ' + AGENTIC_ADDRESS);
    console.log('');
    console.log('Testnet setup (chain 97 only — refused on mainnet):');
    console.log('  grant-holder [<address>]');
    console.log('      Grant holder status on the TEST-ONLY mock registry (setBalance 1).');
    console.log('      Address from the positional arg, --address, or your AGENT_PRIVATE_KEY.');
    console.log('      The mock is permissionless by design — that is how an agent becomes');
    console.log('      a holder on testnet. --registry overrides the registry address.');
    console.log('');
    console.log('Functions (one example each):');
    for (const name of Object.keys(FUNCTIONS)) {
        const fn = FUNCTIONS[name];
        const ex = fn.args.map((a) => a[1]).join(' ');
        console.log('  ' + name + ' ' + ex);
        console.log('      ' + fn.desc);
    }
    console.log('');
    console.log('Examples:');
    console.log('  # 1. Become a holder on testnet (prints calldata; add --send to send it):');
    console.log('  node scripts/agent-call.js grant-holder --address 0xYourAgentAddress');
    console.log('  AGENT_PRIVATE_KEY=0x... node scripts/agent-call.js grant-holder --send');
    console.log('  # 2. Publish your profile on testnet (prints, then sends with your key):');
    console.log('  AGENT_PRIVATE_KEY=0x... node scripts/agent-call.js publishProfile "My Agent" "research,writing" "On-chain research agent." --send');
    console.log('  # 3. Same call on mainnet, via the Agentic Wallet (print-only, baw):');
    console.log('  node scripts/agent-call.js publishProfile "My Agent" "research,writing" "On-chain research agent." --contract <mainnet-address> --chain 56');
    console.log('  node scripts/agent-call.js delegateTaskPrivate 8 0x92bAF2E9178D45Fdfb6406152ea938f25e20De30 "Confidential handoff" --plaintext "review the seed report by Friday" --contract ' + TESTNET_CONTRACT + ' --chain 97');
    console.log('  node scripts/agent-call.js attestQuality 3 5 --contract <mainnet-address> --chain 56');
}

// --- argument parsing (simple and forgiving) ---
function parseArgs(argv) {
    const positionals = [];
    const flags = { contract: null, chain: '97', from: AGENTIC_ADDRESS, fromSet: false, plaintext: null, send: false, address: null, registry: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--contract' || a === '--chain' || a === '--from' || a === '--plaintext' || a === '--address' || a === '--registry') {
            if (i + 1 >= argv.length) fail('flag ' + a + ' needs a value');
            const key = a.slice(2);
            flags[key] = argv[++i];
            if (key === 'from') flags.fromSet = true;
        } else if (a === '--send') {
            flags.send = true;
        } else if (a === '--help' || a === '-h') {
            printUsage();
            process.exit(0);
        } else if (a.startsWith('--')) {
            fail('unknown flag "' + a + '"');
        } else {
            positionals.push(a);
        }
    }
    return { positionals, flags };
}

async function main() {
    const { positionals, flags } = parseArgs(process.argv.slice(2));
    if (positionals.length === 0) {
        printUsage();
        process.exit(0);
    }
    const name = positionals[0];
    if (flags.chain !== '56' && flags.chain !== '97') fail('--chain must be 97 (BSC Testnet, default) or 56 (BNB Chain mainnet), got "' + flags.chain + '"');
    if (flags.send && flags.chain !== '97') fail('--send works on BSC Testnet (chain 97) only — it is refused on mainnet (chain 56). On mainnet, use the printed `baw contract-call preview` command instead.');
    if (!isAddress(flags.from)) fail('--from must be an address, got "' + flags.from + '"');

    // --- grant-holder: setBalance(agent, 1) on the testnet mock registry ---
    if (name === 'grant-holder') {
        if (flags.chain !== '97') fail('grant-holder is testnet-only (chain 97) — it is refused on mainnet (chain 56), where the registry is the official Agent ID contract and holder status comes from the NFT claimed in the Binance app.');
        const registry = flags.registry || testnetRegistryAddress();
        if (!isAddress(registry)) fail('--registry must be an address, got "' + registry + '"');
        let agent = null;
        const posAddr = positionals[1];
        if (posAddr) {
            if (!isAddress(posAddr)) fail('grant-holder address must be an address, got "' + posAddr + '"');
            agent = posAddr;
        } else if (flags.address) {
            if (!isAddress(flags.address)) fail('--address must be an address, got "' + flags.address + '"');
            agent = flags.address;
        } else if (process.env.AGENT_PRIVATE_KEY) {
            const pk = process.env.AGENT_PRIVATE_KEY;
            const norm = pk.startsWith('0x') ? pk : '0x' + pk;
            if (!/^0x[0-9a-fA-F]{64}$/.test(norm)) fail('AGENT_PRIVATE_KEY must be a 64-hex private key (0x-prefixed or bare), got an invalid value');
            agent = new ethers.Wallet(norm).address;
        } else {
            fail('grant-holder needs an address: give it as a positional arg, --address <addr>, or set AGENT_PRIVATE_KEY so it can be derived from your key');
        }
        const calldata = mockIface.encodeFunctionData('setBalance', [agent, 1]);
        console.log('Function: setBalance(address,uint256) — grant holder status (TEST-ONLY mock)');
        console.log('Contract: ' + registry + ' (chain 97, BSC Testnet mock registry)');
        console.log('          NOTE: this is the TEST-ONLY mock registry — setBalance is');
        console.log('          permissionless by design. That is how an agent becomes a');
        console.log('          holder on testnet. There is no grant-holder on mainnet.');
        console.log('Agent:    ' + agent);
        console.log('Calldata: ' + calldata);
        console.log('');
        if (flags.send) {
            await sendDirect({ to: registry, calldata, label: 'grant-holder setBalance(' + agent + ', 1)' });
        } else {
            console.log('Direct send (testnet, with your own key):');
            console.log('  AGENT_PRIVATE_KEY=0x... node scripts/agent-call.js grant-holder --address ' + agent + ' --send');
            console.log('');
            console.log('Notes:');
            console.log('  (1) Add --send to send this call directly via a public testnet RPC.');
            console.log('  (2) baw cannot do this: baw has no chain 97, so a baw preview of');
            console.log('      a testnet call will fail. Direct send (--send) is the testnet path.');
        }
        return;
    }

    const fn = FUNCTIONS[name];
    if (!fn) {
        console.error('Error: unknown function "' + name + '".\n');
        printUsage();
        process.exit(1);
    }
    if (!flags.contract) fail('--contract <address> is required (the EstafAgen contract to call)');
    if (!isAddress(flags.contract)) fail('--contract must be an address, got "' + flags.contract + '"');

    const raw = positionals.slice(1);
    const required = fn.args.filter((a) => !a[3]).length;
    let values = [];
    if (name === 'delegateTaskPrivate' && flags.plaintext !== null) {
        // --plaintext replaces the contentHash positional arg.
        if (raw.length !== 3) fail('delegateTaskPrivate with --plaintext needs exactly 3 args: <taskId> <to> <title> (the hash is computed from --plaintext)');
        values = raw.slice(0, 3).map((v, i) => fn.args[i][2](v));
        const hash = ethers.keccak256(ethers.toUtf8Bytes(flags.plaintext));
        values.push(hash);
        console.log('Private delegation: plaintext hashed on your machine, only the hash goes on-chain.');
        console.log('  plaintext: "' + flags.plaintext + '"');
        console.log('  contentHash: ' + hash);
        console.log('  WARNING: share the plaintext with the assignee OFF-CHAIN (chat, DM, Agent Card) —');
        console.log('  the contract stores only the hash, so nobody can recover the text from the chain.');
        console.log('');
    } else {
        if (raw.length < required || raw.length > fn.args.length) {
            const need = fn.args.map((a) => '<' + a[0] + '>').join(' ');
            fail(name + ' needs ' + required + ' argument(s)' + (fn.args.length > required ? ' (last ' + (fn.args.length - required) + ' optional)' : '') + ': ' + need);
        }
        values = fn.args.map((a, i) => {
            if (i >= raw.length) {
                if (a[0] === 'agentCardSignature') return '';
                fail(name + ' is missing <' + a[0] + '> — give the content hash, or use --plaintext "text" to hash it here');
            }
            return a[2](raw[i]);
        });
    }

    const calldata = fn.encode(values);
    const sig = signatureOf(name);
    console.log('Function: ' + sig);
    console.log('Contract: ' + flags.contract + ' (chain ' + flags.chain + (flags.chain === '97' ? ', BSC Testnet' : ', BNB Chain mainnet') + ')');
    if (flags.chain === '97') {
        console.log('RPC:      ' + TESTNET_RPC[0] + ' (primary; fallbacks: ' + TESTNET_RPC.slice(1).join(', ') + ')');
        if (flags.contract.toLowerCase() === TESTNET_CONTRACT.toLowerCase()) {
            console.log('          known testnet deployment (Round 5.1).');
        }
    } else {
        console.log('RPC:      ' + MAINNET_RPC + ' (reference; baw uses its own backend)');
        console.log('          NOTE: mainnet deployment is not live yet — double-check the --contract address before running baw.');
    }
    console.log('From:     ' + flags.from);
    console.log('Calldata: ' + calldata);
    console.log('');
    if (flags.chain === '97') {
        if (flags.send) {
            if (!process.env.AGENT_PRIVATE_KEY) fail('--send needs your own key in env AGENT_PRIVATE_KEY (never a key file; export it in your shell, e.g. AGENT_PRIVATE_KEY=0x... node scripts/agent-call.js ...)');
            const _pk = process.env.AGENT_PRIVATE_KEY;
            const _norm = _pk.startsWith('0x') ? _pk : '0x' + _pk;
            if (!/^0x[0-9a-fA-F]{64}$/.test(_norm)) fail('AGENT_PRIVATE_KEY must be a 64-hex private key (0x-prefixed or bare), got an invalid value');
            if (flags.fromSet && flags.from.toLowerCase() !== new ethers.Wallet(_norm).address.toLowerCase()) {
                fail('--from does not match the wallet derived from AGENT_PRIVATE_KEY — the transaction would be sent from the key address, not --from. Drop --from (it defaults from your key in --send mode) or set it to your own address.');
            }
            await sendDirect({ to: flags.contract, calldata, label: name + ' (chain 97)' });
        } else {
            const invocation = 'node scripts/agent-call.js ' + process.argv.slice(2).join(' ');
            console.log('Direct send on testnet (your own key, no baw):');
            console.log('  AGENT_PRIVATE_KEY=0x... ' + invocation + ' --send');
            console.log('');
            console.log('Notes:');
            console.log('  (1) Add --send to send this call directly via a public testnet RPC.');
            console.log('  (2) Direct send works on testnet via --send with your own key; a baw');
            console.log('      preview will fail on testnet because baw has no chain 97.');
        }
    } else {
        console.log('Run this (preview first — it only simulates):');
        console.log('  baw contract-call preview --binanceChainId ' + flags.chain + ' --from ' + flags.from + ' --to ' + flags.contract + ' --value 0 --inputData ' + calldata);
        console.log('');
        console.log('Then, only if the preview looks right, execute it with the requestId preview returns:');
        console.log('  baw contract-call execute --requestId <id-from-preview>');
        console.log('');
        console.log('Notes:');
        console.log('  (1) Always run preview first and check the simulation before execute.');
        console.log('  (2) baw only works on mainnet chains (no testnet) — a chain 97 command');
        console.log('      is for encoding checks only and will fail at preview.');
    }
}

main().catch((e) => {
    console.error('Error: ' + (e && e.message ? e.message : e));
    process.exit(1);
});
