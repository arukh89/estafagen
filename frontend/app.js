/**
 * EstafAgen — browser UI wiring (DOM only; all contract logic lives in
 * estafagen.js, which scripts/integration-test.js also exercises).
 *
 * - Injected connector only (window.ethereum). No QR, no WalletConnect.
 * - Guest mode: directory + tasks + chains are readable without a wallet,
 *   through a public read-only RPC for the selected chain.
 * - Only the CONNECTED account's own `.ai` name is ever shown as "mine";
 *   directory entries show the name their publisher declared themselves.
 * - Every write goes through a 4-stage status display and needs the user's
 *   own confirmation in their wallet. Nothing moves automatically.
 */
(function () {
    'use strict';

    var CONFIG = window.ESTAFAGEN_CONFIG;
    var EA = window.EstafAgen;

    // Public read-only RPCs for guest mode (no wallet needed to read).
    // Hostname matches hardhat.config.js (bnbchain.org) — one source of
    // truth for the testnet RPC (F17).
    var PUBLIC_RPC = {
        97: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
        56: 'https://bsc-dataseed.binance.org/',
        31337: 'http://127.0.0.1:8545/',
    };

    var DEFAULT_CHAIN = 97; // BSC Testnet (until Round 4 fills in addresses)

    var state = {
        provider: null,      // ethers provider used for reads
        walletProvider: null, // BrowserProvider when a wallet is connected
        signer: null,
        account: null,
        chainId: DEFAULT_CHAIN,
        client: null,
        holder: false,
        myProfile: null,
        paused: false,
        profiles: [],
        tasks: [],
    };

    // ------------------------------------------------------------------
    // Small DOM helpers
    // ------------------------------------------------------------------
    function $(id) { return document.getElementById(id); }
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = text;
        return n;
    }
    function esc(s) { return String(s == null ? '' : s); }

    function chainConfig(chainId) {
        return (CONFIG.chains && CONFIG.chains[chainId]) || null;
    }
    function hasContract(chainId) {
        var c = chainConfig(chainId);
        return !!(c && c.estafagen);
    }
    function explorerTxUrl(chainId, hash) {
        var c = chainConfig(chainId);
        return c && c.explorerTx ? c.explorerTx + hash : null;
    }
    function explorerAddressUrl(chainId, addr) {
        var c = chainConfig(chainId);
        return c && c.explorerAddress ? c.explorerAddress + addr : null;
    }

    // ------------------------------------------------------------------
    // Transaction status (4 stages)
    // ------------------------------------------------------------------
    var txBox = $('txStatus');
    var txMsg = $('txStatusMsg');
    var txLinkWrap = $('txLinkWrap');
    var txLink = $('txLink');
    var txStage4Text = $('txStage4Text');

    // Highest tx stage actually reached (1 = preparing, 2 = waiting for
    // wallet confirmation, 3 = waiting for network, 4 = mined). txFail()
    // only marks stages up to this one — stages never reached stay
    // neutral instead of showing a misleading checkmark (F13).
    var txReached = 0;

    function setStage(n, status) {
        // status: 'active' | 'done' | 'failed' | '' (reset)
        var items = txBox.querySelectorAll('.stages li');
        items.forEach(function (li) {
            var s = Number(li.getAttribute('data-stage'));
            li.classList.remove('active', 'done', 'failed');
            if (status && s === n) li.classList.add(status);
            if (status === 'done' && s < n) li.classList.add('done');
        });
    }

    function txStart(label) {
        txReached = 1;
        txBox.hidden = false;
        txLinkWrap.hidden = true;
        txMsg.textContent = label || '';
        txMsg.className = 'tx-msg';
        txStage4Text.textContent = 'Selesai';
        setStage(1, 'active');
    }

    function txOnStage(stage, arg) {
        txReached = stage;
        if (stage === 2) {
            setStage(1, 'done'); setStage(2, 'active');
            txMsg.textContent = 'Silakan konfirmasi di wallet-mu. Tidak ada dana yang bergerak sampai kamu menyetujuinya.';
        } else if (stage === 3) {
            setStage(2, 'done'); setStage(3, 'active');
            txMsg.textContent = 'Transaksi terkirim, menunggu jaringan…';
            if (arg) {
                var url = explorerTxUrl(state.chainId, arg);
                if (url) {
                    txLink.href = url;
                    txLinkWrap.hidden = false;
                }
            }
        } else if (stage === 4) {
            setStage(3, 'done'); setStage(4, 'done');
        }
    }

    function txSuccess(msg, receipt) {
        txStage4Text.textContent = 'Berhasil';
        txMsg.textContent = msg;
        txMsg.className = 'tx-msg ok';
        if (receipt && receipt.hash) {
            var url = explorerTxUrl(state.chainId, receipt.hash);
            if (url) {
                txLink.href = url;
                txLinkWrap.hidden = false;
            } else {
                txLinkWrap.hidden = true;
            }
        }
    }

    function txFail(err, context) {
        // Only stages actually reached get a mark: earlier ones 'done',
        // the stage where it failed 'failed', later ones stay neutral.
        var items = txBox.querySelectorAll('.stages li');
        items.forEach(function (li) {
            var s = Number(li.getAttribute('data-stage'));
            li.classList.remove('active', 'done', 'failed');
            if (s < txReached) li.classList.add('done');
            else if (s === txReached) li.classList.add('failed');
        });
        txStage4Text.textContent = 'Gagal';
        txMsg.textContent = explain(err, context || 'tx');
        txMsg.className = 'tx-msg error';
        try { console.error('[EstafAgen] tx failed', err); } catch (e) { /* ignore */ }
    }

    // Runs a write through the 4-stage display and refreshes the lists.
    async function runWrite(label, fn, successMsg) {
        txStart(label);
        try {
            var receipt = await fn(function (stage, arg) { txOnStage(stage, arg); });
            txSuccess(successMsg, receipt);
            await refreshAll();
            return receipt;
        } catch (err) {
            txFail(err, 'tx');
            throw err;
        }
    }

    function formMsg(node, msg, ok) {
        node.textContent = msg || '';
        node.className = 'form-msg' + (ok ? ' ok' : msg ? ' error' : '');
    }

    // Single place that turns an error into an Indonesian message (F21):
    // passes the faucet URL from config so the "saldo tidak cukup"
    // message can point at it instead of naming it nowhere.
    function explain(err, context) {
        return EA.explainError(err, context, CONFIG.faucetUrl);
    }

    // ------------------------------------------------------------------
    // Providers / chain handling
    // ------------------------------------------------------------------
    async function loadLocalConfig() {
        // Only used when the page is served locally (Round 3 dev flow).
        try {
            var res = await fetch('local-config.json');
            if (!res.ok) return;
            var local = await res.json();
            if (local && local.chainId === 31337 && local.estafagen) {
                CONFIG.chains[31337].estafagen = local.estafagen;
                CONFIG.chains[31337].registry = local.registry || null;
            }
        } catch (e) {
            // Not served locally, or file absent — normal for the deployed page.
        }
    }

    // Reads ALWAYS go through the public RPC for the selected chain (F7).
    // The wallet provider is only used for signing writes, never for
    // reads — so guest mode works exactly the same with or without a
    // wallet installed, and the dropdown choice is never overwritten by
    // the wallet's chain (the old code returned a BrowserProvider here
    // whenever window.ethereum existed).
    function makeReadProvider(chainId) {
        var url = PUBLIC_RPC[chainId];
        if (!url) return null;
        return new ethers.JsonRpcProvider(url);
    }

    function buildClient() {
        var cfg = chainConfig(state.chainId);
        if (!cfg || !cfg.estafagen) {
            state.client = null;
            return false;
        }
        state.client = EA.createClient(state.provider, {
            estafagen: cfg.estafagen,
            registry: cfg.registry,
            deployedFromBlock: cfg.deployedFromBlock, // F5: directory scan start
        });
        return true;
    }

    function updateNetworkUI() {
        var cfg = chainConfig(state.chainId);
        var label = cfg ? cfg.label : ('Chain ' + state.chainId);
        var badge = $('networkBadge');
        if (state.account) {
            badge.textContent = label + ' · terhubung';
        } else {
            badge.textContent = 'Mode tamu · ' + label;
        }
        $('chainSelect').value = String(state.chainId);

        var warn = $('wrongNetworkMsg');
        if (!hasContract(state.chainId)) {
            warn.hidden = false;
            warn.textContent = 'Kontrak EstafAgen belum tersedia di jaringan ' + label +
                '. Direktori dan tugas tidak bisa dimuat di sini — pilih jaringan lain, atau tunggu deploy (Ronde 4 untuk BSC Testnet).';
        } else {
            warn.hidden = true;
        }

        var info = $('infoSection');
        if (cfg && cfg.estafagen) {
            $('contractAddr').textContent = cfg.estafagen;
            $('registryAddr').textContent = cfg.registry || '—';
            info.hidden = false;
        } else {
            $('contractAddr').textContent = '—';
            $('registryAddr').textContent = '—';
        }
        $('pausedMsg').hidden = !state.paused;
    }

    async function refreshAccountUI() {
        var line = $('accountLine');
        if (!state.account) {
            line.hidden = true;
            $('myProfileHint').textContent = 'Hubungkan wallet dulu untuk menerbitkan profil agenmu. Hanya holder Agent ID yang bisa menerbitkan profil.';
            $('myProfileCurrent').hidden = true;
            return;
        }
        line.hidden = false;
        var namePart = (state.myProfile && state.myProfile.exists && state.myProfile.name)
            ? ' · ' + state.myProfile.name
            : '';
        line.textContent = 'Akun: ' + EA.shortAddress(state.account) + namePart +
            (state.holder ? ' · holder Agent ID' : ' · bukan holder Agent ID');
    }

    // ------------------------------------------------------------------
    // Directory
    // ------------------------------------------------------------------
    // Generation counter (F6): every refresh bumps it; a response that
    // arrives after a newer refresh started is discarded, so a slow
    // reply to an old query can never overwrite newer results.
    var dirGeneration = 0;

    async function refreshDirectory() {
        var gen = ++dirGeneration;
        var list = $('profileList');
        var status = $('dirStatus');
        list.innerHTML = '';
        if (!state.client) {
            status.textContent = 'Direktori tidak tersedia di jaringan ini.';
            return;
        }
        status.textContent = 'Memuat direktori…';
        try {
            var q = $('searchInput').value;
            var profiles = await state.client.searchProfiles(q);
            if (gen !== dirGeneration) return; // superseded by a newer refresh
            state.profiles = profiles;
            status.textContent = state.profiles.length === 0
                ? 'Belum ada profil di direktori ini.'
                : state.profiles.length + ' agen di direktori.';
            state.profiles.forEach(function (p) {
                var li = el('li');
                li.appendChild(el('h3', null, p.name || '(tanpa nama)'));
                li.appendChild(el('p', null, 'Kemampuan: ' + (p.capabilities || '—')));
                if (p.description) li.appendChild(el('p', null, p.description));
                var addr = el('p', 'addr', p.holder);
                var addrUrl = explorerAddressUrl(state.chainId, p.holder);
                if (addrUrl) {
                    var a = el('a', null, 'Lihat alamat di explorer ↗');
                    a.href = addrUrl;
                    a.target = '_blank';
                    a.rel = 'noopener';
                    li.appendChild(addr);
                    var wrap = el('p'); wrap.appendChild(a);
                    li.appendChild(wrap);
                } else {
                    li.appendChild(addr);
                }
                var btn = el('button', 'btn small', 'Delegasikan ke agen ini');
                btn.type = 'button';
                btn.addEventListener('click', function () {
                    $('delegateTo').value = p.holder;
                    $('delegateSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
                    $('delegateParentId').focus();
                });
                var actions = el('div', 'actions');
                actions.appendChild(btn);
                li.appendChild(actions);
                list.appendChild(li);
            });
        } catch (err) {
            if (gen !== dirGeneration) return; // superseded; don't show stale error
            status.textContent = explain(err, 'call');
            try { console.error('[EstafAgen] directory load failed', err); } catch (e) { /* ignore */ }
        }
    }

    // ------------------------------------------------------------------
    // My profile
    // ------------------------------------------------------------------
    async function refreshMyProfile() {
        var hint = $('myProfileHint');
        if (!state.account || !state.client) {
            $('myProfileCurrent').hidden = true;
            state.myProfile = null;
            await refreshAccountUI();
            return;
        }
        try {
            state.holder = await state.client.isHolder(state.account);
            state.myProfile = await state.client.getProfile(state.account);
        } catch (err) {
            hint.textContent = explain(err, 'call');
            return;
        }
        if (!state.holder) {
            hint.textContent = 'Alamat ini belum memegang Agent ID, jadi belum bisa menerbitkan profil. Klaim Agent ID dulu di aplikasi Binance (Wallet > banner Agent ID).';
            $('myProfileCurrent').hidden = true;
            state.myProfile = null;
            await refreshAccountUI(); // F10: don't leave the previous account's holder info showing
            return;
        }
        hint.textContent = 'Profil diterbitkan atas namamu sendiri. Siapa pun bisa melihatnya di direktori; kamu bisa mengubah atau menghapusnya kapan saja.';
        if (state.myProfile.exists) {
            $('myProfileCurrent').hidden = false;
            $('myProfileName').textContent = state.myProfile.name || '(tanpa nama)';
            $('myProfileCaps').textContent = state.myProfile.capabilities || '—';
            $('myProfileDesc').textContent = state.myProfile.description || '';
            $('profileName').value = state.myProfile.name || '';
            $('profileCaps').value = state.myProfile.capabilities || '';
            $('profileDesc').value = state.myProfile.description || '';
        } else {
            $('myProfileCurrent').hidden = true;
        }
        await refreshAccountUI();
    }

    // ------------------------------------------------------------------
    // Tasks
    // ------------------------------------------------------------------
    function taskActions(task) {
        var wrap = el('div', 'actions');
        var me = state.account;

        var chainBtn = el('button', 'btn small', 'Lihat rantai');
        chainBtn.type = 'button';
        chainBtn.addEventListener('click', function () { showChain(task.id); });
        wrap.appendChild(chainBtn);

        if (!me) return wrap;

        if ((me === task.creator || me === task.assignee) &&
            (task.statusName === 'Open' || task.statusName === 'Accepted')) {
            var delBtn = el('button', 'btn small', 'Delegasikan');
            delBtn.type = 'button';
            delBtn.addEventListener('click', function () {
                $('delegateParentId').value = task.id;
                $('delegateSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
                $('delegateTo').focus();
            });
            wrap.appendChild(delBtn);
        }
        if (me === task.assignee && task.statusName === 'Delegated') {
            var okBtn = el('button', 'btn small primary', 'Terima');
            okBtn.type = 'button';
            okBtn.addEventListener('click', function () {
                runWrite('Menerima delegasi…',
                    function (onStage) { return state.client.acceptDelegation(state.signer, task.id, onStage); },
                    'Delegasi #' + task.id + ' diterima.');
            });
            var noBtn = el('button', 'btn small', 'Tolak');
            noBtn.type = 'button';
            noBtn.addEventListener('click', function () {
                runWrite('Menolak delegasi…',
                    function (onStage) { return state.client.rejectDelegation(state.signer, task.id, onStage); },
                    'Delegasi #' + task.id + ' ditolak.');
            });
            wrap.appendChild(okBtn);
            wrap.appendChild(noBtn);
        }
        // Completion applies to delegated subtasks only — never to a root
        // task (roots start Open and the contract has no path to Completed
        // for them; see estafagen.js STATUS note).
        if (me === task.assignee && task.statusName === 'Accepted' && !task.isRoot) {
            var doneBtn = el('button', 'btn small primary', 'Selesai');
            doneBtn.type = 'button';
            doneBtn.addEventListener('click', function () {
                runWrite('Menandai selesai…',
                    function (onStage) { return state.client.completeTask(state.signer, task.id, onStage); },
                    'Tugas #' + task.id + ' selesai.');
            });
            wrap.appendChild(doneBtn);
        }
        if (me === task.creator && task.statusName !== 'Completed' && task.statusName !== 'Cancelled') {
            var cancelBtn = el('button', 'btn small danger', 'Batalkan');
            cancelBtn.type = 'button';
            cancelBtn.addEventListener('click', function () {
                runWrite('Membatalkan tugas…',
                    function (onStage) { return state.client.cancelTask(state.signer, task.id, onStage); },
                    'Tugas #' + task.id + ' dibatalkan.');
            });
            wrap.appendChild(cancelBtn);
        }
        return wrap;
    }

    async function refreshTasks() {
        var list = $('taskList');
        var status = $('tasksStatus');
        list.innerHTML = '';
        if (!state.client) {
            status.textContent = 'Tugas tidak tersedia di jaringan ini.';
            return;
        }
        status.textContent = 'Memuat tugas…';
        try {
            // Total count first, so the status line can say when the
            // display is capped (F16: listTasks shows at most 100 newest).
            var total = await state.client.getTaskCount();
            state.tasks = await state.client.listTasks(100);
            status.textContent = total === 0
                ? 'Belum ada tugas.'
                : state.tasks.length < total
                    ? 'Menampilkan ' + state.tasks.length + ' tugas terbaru dari ' + total + ' tugas.'
                    : state.tasks.length + ' tugas.';
            state.tasks.forEach(function (t) {
                var li = el('li');
                var h = el('h3', null, '#' + t.id + ' · ' + t.title);
                li.appendChild(h);
                var badge = el('span', 'status-badge ' + t.statusName, t.statusLabel);
                var badgeWrap = el('p'); badgeWrap.appendChild(badge);
                li.appendChild(badgeWrap);
                if (t.description) li.appendChild(el('p', null, t.description));
                li.appendChild(el('p', 'addr',
                    'Pembuat: ' + EA.shortAddress(t.creator) +
                    ' · Penerima: ' + EA.shortAddress(t.assignee) +
                    (t.isRoot ? '' : ' · subtugas dari #' + t.parentId)));
                if (t.createdAt) {
                    li.appendChild(el('p', null, 'Dibuat: ' +
                        new Date(t.createdAt * 1000).toLocaleString('id-ID')));
                }
                if (t.isRoot) {
                    li.appendChild(el('p', 'hint',
                        'Tugas akar: wadah yang terus berjalan — diselesaikan lewat subtugasnya, bukan tombol selesai.'));
                }
                li.appendChild(taskActions(t));
                list.appendChild(li);
            });
        } catch (err) {
            status.textContent = explain(err, 'call');
            try { console.error('[EstafAgen] tasks load failed', err); } catch (e) { /* ignore */ }
        }
    }

    async function showChain(taskId) {
        var list = $('chainList');
        list.innerHTML = '';
        if (!state.client) return;
        try {
            var chain = await state.client.getChain(taskId);
            chain.forEach(function (t) {
                var li = el('li', null,
                    '#' + t.id + ' · ' + t.title + ' — ' + t.statusLabel +
                    ' (penerima ' + EA.shortAddress(t.assignee) + ')');
                list.appendChild(li);
            });
            if (chain.length === 0) list.appendChild(el('li', null, 'Tugas tidak ditemukan.'));
        } catch (err) {
            list.appendChild(el('li', null, explain(err, 'call')));
        }
        $('chainSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function refreshAll() {
        if (!hasContract(state.chainId)) {
            $('dirStatus').textContent = 'Direktori tidak tersedia di jaringan ini.';
            $('tasksStatus').textContent = 'Tugas tidak tersedia di jaringan ini.';
            // F9: don't leave the previous chain's lists on screen.
            $('profileList').innerHTML = '';
            $('taskList').innerHTML = '';
            state.profiles = [];
            state.tasks = [];
            updateNetworkUI();
            return;
        }
        try { state.paused = await state.client.isPaused(); } catch (e) { state.paused = false; }
        updateNetworkUI(); // called once, after the pause state is known (F18)
        // The three refreshes are independent reads — run them in
        // parallel instead of one after another (F16).
        await Promise.all([refreshDirectory(), refreshTasks(), refreshMyProfile()]);
    }

    // Reads always use the public-RPC provider for the selected chain
    // (F7). The wallet is never consulted here, so the dropdown choice
    // is the chain that gets read — even with a wallet installed on a
    // different chain. (The dead `opts.keepAccount` branch is gone, F22.)
    async function setChain(chainId) {
        state.chainId = Number(chainId);
        state.provider = makeReadProvider(state.chainId);
        if (!state.provider) {
            $('wrongNetworkMsg').hidden = false;
            $('wrongNetworkMsg').textContent = 'Tidak ada penyedia untuk jaringan ini.';
            return;
        }
        buildClient();
        await refreshAll();
    }

    // ------------------------------------------------------------------
    // Connect
    // ------------------------------------------------------------------
    async function connect() {
        if (!window.ethereum) {
            $('noWalletMsg').hidden = false;
            return;
        }
        $('noWalletMsg').hidden = true;
        try {
            state.walletProvider = new ethers.BrowserProvider(window.ethereum);
            var accounts = await state.walletProvider.send('eth_requestAccounts', []);
            if (!accounts || accounts.length === 0) return;
            state.signer = await state.walletProvider.getSigner();
            state.account = accounts[0];
            var net = await state.walletProvider.getNetwork();
            state.chainId = Number(net.chainId);
            // Reads stay on the public RPC for the wallet's chain (F7);
            // the wallet provider is only kept for signing.
            state.provider = makeReadProvider(state.chainId);
            buildClient();
            $('connectBtn').textContent = EA.shortAddress(state.account);
            $('connectMsg').hidden = true;
            formMsg($('connectMsg'), '');
            await refreshAll();
        } catch (err) {
            // F14: a connect failure belongs next to the connect button,
            // not down in the profile form.
            var cm = $('connectMsg');
            cm.hidden = false;
            formMsg(cm, explain(err, 'tx'));
            try { console.error('[EstafAgen] connect failed', err); } catch (e) { /* ignore */ }
        }
    }

    function wireWalletEvents() {
        if (!window.ethereum || !window.ethereum.on) return;
        window.ethereum.on('accountsChanged', async function (accounts) {
            if (!accounts || accounts.length === 0) {
                state.account = null;
                state.signer = null;
                $('connectBtn').textContent = 'Hubungkan wallet';
                refreshAll();
            } else {
                // F12: the new address comes with the event — use it
                // directly instead of asking eth_requestAccounts again
                // (which could pop another wallet prompt).
                if (!state.walletProvider) {
                    state.walletProvider = new ethers.BrowserProvider(window.ethereum);
                }
                state.account = accounts[0];
                try {
                    state.signer = await state.walletProvider.getSigner();
                } catch (e) { state.signer = null; }
                $('connectBtn').textContent = EA.shortAddress(state.account);
                await refreshAll();
            }
        });
        window.ethereum.on('chainChanged', function () {
            // The wallet changed chain: fresh provider + fresh signer
            // (F11 — the old code kept a signer bound to the old
            // provider), reads back on the public RPC (F7).
            if (state.walletProvider) {
                state.walletProvider = new ethers.BrowserProvider(window.ethereum);
                state.walletProvider.getNetwork().then(async function (net) {
                    state.chainId = Number(net.chainId);
                    try {
                        state.signer = await state.walletProvider.getSigner();
                    } catch (e) { state.signer = null; }
                    state.provider = makeReadProvider(state.chainId);
                    buildClient();
                    refreshAll();
                });
            }
        });
    }

    // ------------------------------------------------------------------
    // Sticky nav: mark the link of the section currently in view.
    // No-op if the nav or IntersectionObserver is unavailable.
    // ------------------------------------------------------------------
    function initNavSpy() {
        var nav = document.querySelector('.mainnav');
        if (!nav || !('IntersectionObserver' in window)) return;
        var links = Array.prototype.slice.call(nav.querySelectorAll('[data-nav]'));
        if (!links.length) return;
        function setActive(id) {
            links.forEach(function (a) {
                a.classList.toggle('active', a.getAttribute('data-nav') === id);
            });
        }
        var obs = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) setActive(entry.target.id);
            });
        }, { rootMargin: '-64px 0px -60% 0px' });
        links.forEach(function (a) {
            var sec = document.getElementById(a.getAttribute('data-nav'));
            if (sec) obs.observe(sec);
        });
    }

    // ------------------------------------------------------------------
    // Forms
    // ------------------------------------------------------------------
    function requireClientAndAccount() {
        if (!state.client) return 'Kontrak belum tersedia di jaringan ini.';
        if (!state.account) return 'Hubungkan wallet dulu.';
        if (!state.holder) return 'Alamat ini belum memegang Agent ID.';
        return null;
    }

    // Ask the wallet to add a chain it doesn't know yet (F8), using
    // the chain parameters from config.js / PUBLIC_RPC.
    var NATIVE_CURRENCY = {
        97: { name: 'BNB', symbol: 'BNB', decimals: 18 },
        56: { name: 'BNB', symbol: 'BNB', decimals: 18 },
        31337: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    };
    async function addChainToWallet(chainId) {
        var cfg = chainConfig(chainId);
        var params = {
            chainId: '0x' + Number(chainId).toString(16),
            chainName: cfg ? cfg.label : ('Chain ' + chainId),
            nativeCurrency: NATIVE_CURRENCY[chainId] || { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [PUBLIC_RPC[chainId]],
        };
        if (cfg && cfg.explorer) params.blockExplorerUrls = [cfg.explorer];
        return await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [params],
        });
    }

    function init() {
        // F15: if ethers never loaded (both CDNs unreachable), don't
        // leave a silently dead page — say so plainly and stop here.
        if (typeof window.ethers === 'undefined' || !window.EstafAgen) {
            var loadMsg = $('ethersLoadMsg');
            loadMsg.hidden = false;
            loadMsg.textContent = 'Gagal memuat pustaka ethers dari CDN (jsDelivr dan unpkg). Periksa koneksi internetmu, lalu muat ulang halaman ini.';
            return;
        }
        // Chain selector.
        var select = $('chainSelect');
        Object.keys(CONFIG.chains).forEach(function (id) {
            var opt = document.createElement('option');
            opt.value = id;
            opt.textContent = CONFIG.chains[id].label;
            select.appendChild(opt);
        });
        select.value = String(DEFAULT_CHAIN);
        select.addEventListener('change', async function () {
            var id = Number(select.value);
            if (state.walletProvider) {
                try {
                    await window.ethereum.request({
                        method: 'wallet_switchEthereumChain',
                        params: [{ chainId: '0x' + id.toString(16) }],
                    });
                    return; // chainChanged event re-inits
                } catch (err) {
                    // F8: chain not added in this wallet (error 4902 —
                    // common for BSC Testnet in a fresh wallet / in the
                    // Binance in-app browser): add it, then retry.
                    if (err && (err.code === 4902 || /4902/.test(String(err.message || '')))) {
                        try {
                            await addChainToWallet(id);
                            await window.ethereum.request({
                                method: 'wallet_switchEthereumChain',
                                params: [{ chainId: '0x' + id.toString(16) }],
                            });
                            return; // chainChanged event re-inits
                        } catch (addErr) {
                            formMsg($('profileMsg'), explain(addErr, 'tx'));
                            select.value = String(state.chainId);
                            return;
                        }
                    }
                    formMsg($('profileMsg'), explain(err, 'tx'));
                    select.value = String(state.chainId);
                    return;
                }
            }
            await setChain(id);
        });

        $('connectBtn').addEventListener('click', connect);
        $('refreshDirBtn').addEventListener('click', refreshDirectory);
        $('refreshTasksBtn').addEventListener('click', refreshTasks);
        // Debounced search (F6): wait ~300 ms after the last keystroke
        // before re-querying; the generation counter in
        // refreshDirectory() drops any reply that is already stale.
        var searchTimer = null;
        $('searchInput').addEventListener('input', function () {
            if (searchTimer) clearTimeout(searchTimer);
            searchTimer = setTimeout(refreshDirectory, 300);
        });
        $('showChainBtn').addEventListener('click', function () {
            var id = Number($('chainTaskId').value);
            if (id > 0) showChain(id);
        });

        $('profileForm').addEventListener('submit', async function (ev) {
            ev.preventDefault();
            var blocked = requireClientAndAccount();
            if (blocked) { formMsg($('profileMsg'), blocked); return; }
            var name = $('profileName').value.trim();
            var caps = $('profileCaps').value.trim();
            var desc = $('profileDesc').value.trim();
            if (!name || !caps) { formMsg($('profileMsg'), 'Nama dan kemampuan wajib diisi.'); return; }
            formMsg($('profileMsg'), '');
            try {
                await runWrite('Menerbitkan profil…',
                    function (onStage) {
                        return state.client.publishProfile(state.signer, name, caps, desc, onStage);
                    },
                    'Profil diterbitkan. Sekarang terlihat di direktori.');
                formMsg($('profileMsg'), 'Profil diterbitkan.', true);
            } catch (e) { /* message already shown by txFail */ }
        });

        $('removeProfileBtn').addEventListener('click', async function () {
            var blocked = requireClientAndAccount();
            if (blocked) { formMsg($('profileMsg'), blocked); return; }
            if (!window.confirm('Hapus profilmu? Entri direktori akan hilang.')) return;
            try {
                await runWrite('Menghapus profil…',
                    function (onStage) { return state.client.removeProfile(state.signer, onStage); },
                    'Profil dihapus.');
                formMsg($('profileMsg'), 'Profil dihapus.', true);
            } catch (e) { /* message already shown by txFail */ }
        });

        $('createTaskForm').addEventListener('submit', async function (ev) {
            ev.preventDefault();
            var blocked = requireClientAndAccount();
            if (blocked) { formMsg($('taskMsg'), blocked); return; }
            var title = $('taskTitle').value.trim();
            var desc = $('taskDesc').value.trim();
            if (!title) { formMsg($('taskMsg'), 'Judul tugas wajib diisi.'); return; }
            formMsg($('taskMsg'), '');
            try {
                await runWrite('Membuat tugas…',
                    function (onStage) {
                        return state.client.createTask(state.signer, title, desc, onStage);
                    },
                    'Tugas dibuat.');
                formMsg($('taskMsg'), 'Tugas dibuat.', true);
                $('taskTitle').value = '';
                $('taskDesc').value = '';
            } catch (e) { /* message already shown by txFail */ }
        });

        $('delegateForm').addEventListener('submit', async function (ev) {
            ev.preventDefault();
            var blocked = requireClientAndAccount();
            if (blocked) { formMsg($('delegateMsg'), blocked); return; }
            var parentId = Number($('delegateParentId').value);
            var to = $('delegateTo').value.trim();
            var title = $('delegateTitle').value.trim();
            var desc = $('delegateDesc').value.trim();
            if (!parentId || parentId < 1) { formMsg($('delegateMsg'), 'ID tugas induk tidak valid.'); return; }
            if (!EA.isAddress(to)) { formMsg($('delegateMsg'), 'Alamat penerima tidak valid.'); return; }
            if (!title) { formMsg($('delegateMsg'), 'Judul subtugas wajib diisi.'); return; }
            formMsg($('delegateMsg'), '');
            try {
                await runWrite('Mendelegasikan…',
                    function (onStage) {
                        return state.client.delegateTask(state.signer, parentId, to, title, desc, onStage);
                    },
                    'Subtugas didelegasikan ke ' + EA.shortAddress(to) + '.');
                formMsg($('delegateMsg'), 'Subtugas didelegasikan.', true);
                $('delegateTitle').value = '';
                $('delegateDesc').value = '';
            } catch (e) { /* message already shown by txFail */ }
        });

        wireWalletEvents();
        initNavSpy();

        loadLocalConfig().then(function () {
            state.provider = makeReadProvider(state.chainId);
            buildClient();
            return refreshAll();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
