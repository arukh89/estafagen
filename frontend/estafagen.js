/**
 * EstafAgen — shared contract client (frontend logic, no DOM).
 *
 * Used by BOTH:
 *  - the browser UI (frontend/app.js), loaded after the ethers v6 UMD build
 *    from the CDN, where `window.ethers` is the global;
 *  - the local integration test (scripts/integration-test.js), loaded via
 *    require() in Node, where ethers comes from node_modules.
 *
 * UMD wrapper: in Node, `module.exports = factory(require('ethers'))`;
 * in the browser, `window.EstafAgen = factory(window.ethers)`.
 *
 * The client never touches the DOM and never asks the user to sign anything
 * except through an explicit write call made by the UI. Reads use a provider;
 * writes take an ethers Signer.
 *
 * Compliance note: the directory is discovered ONLY from ProfilePublished
 * events (self-published, opt-in entries). There is no name->address lookup
 * for holders who never published a profile. The `.ai` name shown for a
 * profile is self-declared by its publisher, not read from the registry;
 * the holder address is always shown next to it.
 */

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('ethers'));
    } else {
        root.EstafAgen = factory(root.ethers);
    }
})(typeof self !== 'undefined' ? self : this, function (ethers) {
    'use strict';

    // ------------------------------------------------------------------
    // ABI (human-readable, copied from contracts/EstafAgen.sol)
    // ------------------------------------------------------------------
    var ESTAFAGEN_ABI = [
        // Custom errors (declared so ethers decodes reverts by name —
        // explainError() matches on these names; without them a revert
        // would surface only as an opaque hex blob).
        'error NotAgentIdHolder()',
        'error NotAssignee()',
        'error NotCreator()',
        'error InvalidStatus()',
        'error NotDelegatable()',
        'error InvalidRegistryAddress()',
        // Views
        'function isHolder(address account) view returns (bool)',
        'function taskCount() view returns (uint256)',
        'function getProfile(address holder) view returns (tuple(bool exists, string name, string capabilities, string description))',
        'function hasProfile(address holder) view returns (bool)',
        'function getTask(uint256 taskId) view returns (tuple(uint256 id, string title, string description, address creator, address assignee, uint256 parentId, uint8 status, uint256 createdAt))',
        'function paused() view returns (bool)',
        // Writes
        'function publishProfile(string name, string capabilities, string description)',
        'function removeProfile()',
        'function createTask(string title, string description) returns (uint256)',
        'function delegateTask(uint256 parentId, address to, string title, string description) returns (uint256)',
        'function acceptDelegation(uint256 taskId)',
        'function rejectDelegation(uint256 taskId)',
        'function completeTask(uint256 taskId)',
        'function cancelTask(uint256 taskId)',
        // Events
        'event ProfilePublished(address indexed holder, string name)',
        'event ProfileRemoved(address indexed holder)',
        'event TaskCreated(uint256 indexed taskId, address indexed creator)',
        'event TaskDelegated(uint256 indexed taskId, uint256 indexed parentId, address indexed delegator, address assignee)',
        'event DelegationAccepted(uint256 indexed taskId, address indexed assignee)',
        'event DelegationRejected(uint256 indexed taskId, address indexed assignee)',
        'event TaskCompleted(uint256 indexed taskId, address indexed assignee)',
        'event TaskCancelled(uint256 indexed taskId, address indexed creator)',
    ];

    // Task statuses, in contract enum order (EstafAgen.Status).
    // NOTE (Round 2 design): a root task can NEVER become Completed — roots
    // start Open and completeTask() only accepts Accepted subtasks. The UI
    // must therefore never offer "complete" on a root task; roots are
    // ongoing containers whose subtasks get completed.
    var STATUS = ['Open', 'Delegated', 'Accepted', 'Completed', 'Rejected', 'Cancelled'];
    var STATUS_LABEL_ID = {
        Open: 'Terbuka',
        Delegated: 'Didelegasikan',
        Accepted: 'Diterima',
        Completed: 'Selesai',
        Rejected: 'Ditolak',
        Cancelled: 'Dibatalkan',
    };

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function shortAddress(addr) {
        if (!addr || typeof addr !== 'string' || addr.length < 10) return addr || '';
        return addr.slice(0, 6) + '…' + addr.slice(-4);
    }

    function isAddress(value) {
        try {
            return ethers.isAddress(value);
        } catch (e) {
            return false;
        }
    }

    function normalizeTask(raw) {
        return {
            id: Number(raw.id),
            title: raw.title,
            description: raw.description,
            creator: raw.creator,
            assignee: raw.assignee,
            parentId: Number(raw.parentId),
            status: Number(raw.status),
            statusName: STATUS[Number(raw.status)],
            statusLabel: STATUS_LABEL_ID[STATUS[Number(raw.status)]],
            createdAt: Number(raw.createdAt),
            isRoot: Number(raw.parentId) === 0,
        };
    }

    function normalizeProfile(holder, raw) {
        return {
            holder: holder,
            exists: !!raw.exists,
            name: raw.name,
            capabilities: raw.capabilities,
            description: raw.description,
        };
    }

    // ------------------------------------------------------------------
    // Indonesian error explanations (never raw codes).
    // `err` is the error object thrown by ethers; `context` is one of
    // 'tx' (a sent transaction failed) or 'call' (a read / preflight failed).
    // Raw details are only written to the console by the caller, never shown.
    //
    // Decoding note (verified 22 Nov 2026, Round 3 integration test):
    // ethers v6 does NOT decode a custom error when the revert surfaces
    // from gas estimation — the error only carries the 4-byte selector
    // (e.g. data "0x09c7d30b" for NotAssignee()). So revertName() below
    // maps selectors to names itself (ethers.id(name + '()').slice(0, 10))
    // and also accepts a name ethers already decoded into reason/message.
    // ------------------------------------------------------------------
    var CUSTOM_ERRORS = [
        'NotAgentIdHolder',
        'NotAssignee',
        'NotCreator',
        'InvalidStatus',
        'NotDelegatable',
        'InvalidRegistryAddress',
    ];
    var ERROR_SELECTORS = {};
    CUSTOM_ERRORS.forEach(function (name) {
        ERROR_SELECTORS[ethers.id(name + '()').slice(0, 10).toLowerCase()] = name;
    });

    // Returns the contract custom-error name for a revert, or null.
    function revertName(err) {
        if (err && err.errorName) return err.errorName;
        var text = '';
        try {
            if (err) {
                if (err.reason) text += ' ' + String(err.reason);
                if (err.message) text += ' ' + String(err.message);
                if (err.data) text += ' ' + String(err.data);
                if (err.error) {
                    if (err.error.data) text += ' ' + String(err.error.data);
                    if (err.error.message) text += ' ' + String(err.error.message);
                }
            }
        } catch (e) {
            text = '';
        }
        var i, j;
        for (i = 0; i < CUSTOM_ERRORS.length; i++) {
            if (text.indexOf(CUSTOM_ERRORS[i]) !== -1) return CUSTOM_ERRORS[i];
        }
        var m = text.match(/0x[0-9a-fA-F]{8}\b/g);
        if (m) {
            for (j = 0; j < m.length; j++) {
                var name = ERROR_SELECTORS[m[j].toLowerCase()];
                if (name) return name;
            }
        }
        return null;
    }

    function explainError(err, context) {
        var text = '';
        try {
            text = String((err && (err.reason || err.message || err.code)) || err || '');
            if (err && err.data) text += ' ' + String(err.data);
            if (err && err.error && err.error.message) text += ' ' + String(err.error.message);
        } catch (e) {
            text = '';
        }

        // 1. User rejected the signature in their wallet.
        if (
            (err && (err.code === 4001 || err.code === 'ACTION_REJECTED')) ||
            /user rejected|user denied|ACTION_REJECTED/i.test(text)
        ) {
            return 'Dibatalkan. Tidak ada dana yang bergerak.';
        }

        // 2. Contract custom errors (matched by name, decoded from the
        //    revert selector when ethers did not decode it itself).
        var name = revertName(err);
        if (name === 'NotAgentIdHolder') {
            return 'Alamat ini belum memegang Agent ID. Klaim Agent ID dulu di aplikasi Binance (Wallet > banner Agent ID), lalu coba lagi.';
        }
        if (name === 'NotAssignee') {
            return 'Hanya penerima tugas ini yang bisa melakukan langkah itu.';
        }
        if (name === 'NotCreator') {
            return 'Hanya pembuat tugas ini yang bisa melakukan langkah itu.';
        }
        if (name === 'NotDelegatable') {
            return 'Tugas ini sudah tidak bisa didelegasikan lagi (sudah selesai, dibatalkan, ditolak, atau belum diterima).';
        }
        if (name === 'InvalidStatus') {
            return 'Tugas ini sedang tidak dalam status yang memungkinkan langkah itu.';
        }
        if (/EnforcedPause/i.test(text)) {
            return 'Kontrak sedang dijeda oleh pemilik. Coba lagi nanti.';
        }
        if (/OwnableUnauthorizedAccount/i.test(text)) {
            return 'Alamat ini tidak punya izin untuk langkah itu.';
        }

        // 3. Out of gas money (testnet tBNB / mainnet BNB).
        if (/insufficient funds|INSUFFICIENT_FUNDS/i.test(text)) {
            return 'Saldo tidak cukup untuk biaya gas. Klaim tBNB gratis dari faucet resmi, lalu coba lagi.';
        }

        // 4. Network / provider problems.
        if (
            (err && (err.code === 'NETWORK_ERROR' || err.code === 'TIMEOUT' || err.code === 'SERVER_ERROR')) ||
            /could not detect network|network error|timeout|timed out|failed to fetch|ECONNREFUSED|getaddrinfo/i.test(text)
        ) {
            return 'Gagal terhubung ke jaringan. Periksa koneksi, lalu coba lagi.';
        }

        // 5. Wrong network usually surfaces as a call failure on an address
        // with no code; keep the message generic but actionable.
        if (context === 'call') {
            return 'Tidak bisa membaca data kontrak. Pastikan jaringan yang dipilih sudah benar, lalu coba lagi.';
        }
        return 'Transaksi gagal. Tidak ada dana yang bergerak. Coba lagi.';
    }

    // ------------------------------------------------------------------
    // Client factory
    // ------------------------------------------------------------------
    function createClient(provider, addresses) {
        if (!provider) throw new Error('provider is required');
        if (!addresses || !addresses.estafagen) {
            throw new Error('estafagen contract address is required');
        }
        var readContract = new ethers.Contract(addresses.estafagen, ESTAFAGEN_ABI, provider);
        var registryAddress = addresses.registry || null;

        function withSigner(signer) {
            return readContract.connect(signer);
        }

        // -- reads ------------------------------------------------------
        async function isHolder(account) {
            return await readContract.isHolder(account);
        }

        async function isPaused() {
            return await readContract.paused();
        }

        async function getProfile(holder) {
            var raw = await readContract.getProfile(holder);
            return normalizeProfile(holder, raw);
        }

        async function hasProfile(holder) {
            return await readContract.hasProfile(holder);
        }

        async function getTask(taskId) {
            var raw = await readContract.getTask(taskId);
            return normalizeTask(raw);
        }

        async function getTaskCount() {
            return Number(await readContract.taskCount());
        }

        async function listTasks() {
            var count = await getTaskCount();
            var tasks = [];
            for (var i = 1; i <= count; i++) {
                tasks.push(await getTask(i));
            }
            // Newest first.
            tasks.sort(function (a, b) { return b.id - a.id; });
            return tasks;
        }

        // Directory discovery: ONLY from self-published ProfilePublished
        // events. Holders who never published are invisible by design.
        async function listProfiles() {
            var events = await readContract.queryFilter(
                readContract.filters.ProfilePublished(),
                0,
                'latest'
            );
            var seen = {};
            var holders = [];
            events.forEach(function (ev) {
                var h = ev.args.holder;
                if (!seen[h]) {
                    seen[h] = true;
                    holders.push(h);
                }
            });
            var profiles = [];
            for (var i = 0; i < holders.length; i++) {
                var p = await getProfile(holders[i]);
                if (p.exists) profiles.push(p);
            }
            return profiles;
        }

        // Case-insensitive substring match over name + capabilities +
        // description. Empty query returns everything.
        async function searchProfiles(query) {
            var all = await listProfiles();
            var q = (query || '').trim().toLowerCase();
            if (!q) return all;
            return all.filter(function (p) {
                return (
                    (p.name || '').toLowerCase().indexOf(q) !== -1 ||
                    (p.capabilities || '').toLowerCase().indexOf(q) !== -1 ||
                    (p.description || '').toLowerCase().indexOf(q) !== -1
                );
            });
        }

        // Walk parentId from `taskId` up to the root. Returns leaf-first:
        // [task, parent, grandparent, ..., root].
        async function getChain(taskId) {
            var chain = [];
            var current = Number(taskId);
            var guard = 0;
            while (current !== 0 && guard < 50) {
                var task = await getTask(current);
                chain.push(task);
                current = task.parentId;
                guard++;
            }
            return chain;
        }

        // -- writes (each returns the mined receipt) --------------------
        // `onStage` is an optional progress callback used by the UI:
        //   2 = waiting for the user to confirm in their wallet,
        //   3 = waiting for the network (tx hash known),
        //   4 = mined (receipt known).
        async function waitTx(txPromise, onStage) {
            if (onStage) onStage(2);
            var tx = await txPromise;
            if (onStage) onStage(3, tx.hash);
            var receipt = await tx.wait();
            if (onStage) onStage(4, receipt);
            return receipt;
        }

        async function publishProfile(signer, name, capabilities, description, onStage) {
            return await waitTx(withSigner(signer).publishProfile(name, capabilities, description), onStage);
        }

        async function removeProfile(signer, onStage) {
            return await waitTx(withSigner(signer).removeProfile(), onStage);
        }

        async function createTask(signer, title, description, onStage) {
            return await waitTx(withSigner(signer).createTask(title, description), onStage);
        }

        async function delegateTask(signer, parentId, to, title, description, onStage) {
            return await waitTx(withSigner(signer).delegateTask(parentId, to, title, description), onStage);
        }

        async function acceptDelegation(signer, taskId, onStage) {
            return await waitTx(withSigner(signer).acceptDelegation(taskId), onStage);
        }

        async function rejectDelegation(signer, taskId, onStage) {
            return await waitTx(withSigner(signer).rejectDelegation(taskId), onStage);
        }

        async function completeTask(signer, taskId, onStage) {
            return await waitTx(withSigner(signer).completeTask(taskId), onStage);
        }

        async function cancelTask(signer, taskId, onStage) {
            return await waitTx(withSigner(signer).cancelTask(taskId), onStage);
        }

        return {
            addresses: { estafagen: addresses.estafagen, registry: registryAddress },
            contract: readContract,
            isHolder: isHolder,
            isPaused: isPaused,
            getProfile: getProfile,
            hasProfile: hasProfile,
            listProfiles: listProfiles,
            searchProfiles: searchProfiles,
            getTask: getTask,
            getTaskCount: getTaskCount,
            listTasks: listTasks,
            getChain: getChain,
            publishProfile: publishProfile,
            removeProfile: removeProfile,
            createTask: createTask,
            delegateTask: delegateTask,
            acceptDelegation: acceptDelegation,
            rejectDelegation: rejectDelegation,
            completeTask: completeTask,
            cancelTask: cancelTask,
        };
    }

    return {
        ABI: ESTAFAGEN_ABI,
        STATUS: STATUS,
        STATUS_LABEL_ID: STATUS_LABEL_ID,
        shortAddress: shortAddress,
        isAddress: isAddress,
        explainError: explainError,
        revertName: revertName,
        createClient: createClient,
    };
});
