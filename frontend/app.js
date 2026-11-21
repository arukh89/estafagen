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

    // A profile is "stale" when its heartbeat (lastUpdated) is older
    // than this many days (Round 5). The threshold lives here, not
    // on-chain: the contract only stores the timestamp.
    var STALE_DAYS = 30;

    var state = {
        provider: null,      // ethers provider used for reads
        walletProvider: null, // BrowserProvider when a wallet is connected
        signer: null,
        account: null,
        chainId: DEFAULT_CHAIN,
        client: null,
        holder: false,
        myProfile: null,
        myExtras: null,
        paused: false,
        profiles: [],
        rankedProfiles: [],
        tasks: [],
        lastDelegation: null,
        _agentKey: null,
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
        txStage4Text.textContent = 'Done';
        setStage(1, 'active');
    }

    function txOnStage(stage, arg) {
        txReached = stage;
        if (stage === 2) {
            setStage(1, 'done'); setStage(2, 'active');
            txMsg.textContent = 'Please confirm in your wallet. No funds move until you approve.';
        } else if (stage === 3) {
            setStage(2, 'done'); setStage(3, 'active');
            txMsg.textContent = 'Transaction sent, waiting for the network…';
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
        txStage4Text.textContent = 'Success';
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
        txStage4Text.textContent = 'Failed';
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

    // Single place that turns an error into an English message (F21):
    // passes the faucet URL from config so the "insufficient balance"
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
            badge.textContent = label + ' · connected';
        } else {
            badge.textContent = 'Guest mode · ' + label;
        }
        $('chainSelect').value = String(state.chainId);

        var warn = $('wrongNetworkMsg');
        if (!hasContract(state.chainId)) {
            warn.hidden = false;
            warn.textContent = 'The EstafAgen contract is not deployed on ' + label +
                ' yet. The directory and tasks cannot load here — pick another network, or wait for the deployment (Round 4 for BSC Testnet).';
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
            $('myProfileHint').textContent = 'Connect your wallet first to publish your agent profile. Only Agent ID holders can publish a profile.';
            $('myProfileCurrent').hidden = true;
            return;
        }
        line.hidden = false;
        var namePart = (state.myProfile && state.myProfile.exists && state.myProfile.name)
            ? ' · ' + state.myProfile.name
            : '';
        line.textContent = 'Account: ' + EA.shortAddress(state.account) + namePart +
            (state.holder ? ' · Agent ID holder' : ' · not an Agent ID holder');
    }

    // ------------------------------------------------------------------
    // Directory
    // ------------------------------------------------------------------
    // Generation counter (F6): every refresh bumps it; a response that
    // arrives after a newer refresh started is discarded, so a slow
    // reply to an old query can never overwrite newer results.
    var dirGeneration = 0;

    function isStale(lastUpdated) {
        if (!lastUpdated) return true;
        var ageDays = (Date.now() / 1000 - lastUpdated) / 86400;
        return ageDays > STALE_DAYS;
    }

    function daysAgoText(lastUpdated) {
        if (!lastUpdated) return 'never';
        var days = Math.floor((Date.now() / 1000 - lastUpdated) / 86400);
        if (days <= 0) return 'today';
        if (days === 1) return '1 day ago';
        return days + ' days ago';
    }

    async function refreshDirectory() {
        var gen = ++dirGeneration;
        var list = $('profileList');
        var status = $('dirStatus');
        list.innerHTML = '';
        if (!state.client) {
            status.textContent = 'Directory is not available on this network.';
            return;
        }
        status.textContent = 'Loading directory…';
        try {
            var q = $('searchInput').value;
            var guild = $('guildFilter').value;
            // Ranked by reputation score (Round 5): the client reads
            // profiles + extras + scores and sorts best-first.
            var ranked = await state.client.listProfilesRanked();
            if (gen !== dirGeneration) return; // superseded by a newer refresh
            state.rankedProfiles = ranked;
            var filtered = ranked.filter(function (r) {
                var p = r.profile;
                if (guild && (r.extras.guild || '') !== guild) return false;
                if (!q.trim()) return true;
                var query = q.trim().toLowerCase();
                return (
                    (p.name || '').toLowerCase().indexOf(query) !== -1 ||
                    (p.capabilities || '').toLowerCase().indexOf(query) !== -1 ||
                    (p.description || '').toLowerCase().indexOf(query) !== -1
                );
            });
            // Guild filter options, from the ranked list itself.
            var guildSelect = $('guildFilter');
            var knownGuilds = [];
            ranked.forEach(function (r) {
                var g = (r.extras.guild || '').trim();
                if (g && knownGuilds.indexOf(g) === -1) knownGuilds.push(g);
            });
            var currentGuild = guildSelect.value;
            guildSelect.innerHTML = '';
            var allOpt = document.createElement('option');
            allOpt.value = '';
            allOpt.textContent = 'All guilds';
            guildSelect.appendChild(allOpt);
            knownGuilds.sort().forEach(function (g) {
                var opt = document.createElement('option');
                opt.value = g;
                opt.textContent = g;
                guildSelect.appendChild(opt);
            });
            guildSelect.value = currentGuild;
            // Swarm list + playbooks depend on the ranked agents: only
            // re-render them when the agent set actually changed, so a
            // debounced search never wipes typed input.
            var agentKey = ranked.map(function (r) { return r.profile.holder; }).join(',');
            if (agentKey !== state._agentKey) {
                state._agentKey = agentKey;
                renderSwarmList();
                renderPlaybooks();
            }
            state.profiles = filtered.map(function (r) { return r.profile; });
            status.textContent = filtered.length === 0
                ? 'No profiles in this directory yet.'
                : filtered.length + ' agents in the directory, ranked by reputation.';
            filtered.forEach(function (r) {
                var p = r.profile;
                var rep = r.reputation;
                var li = el('li');
                li.appendChild(el('h3', null, p.name || '(no name)'));
                var badges = el('p');
                badges.appendChild(el('span', 'score-badge', '★ ' + rep.score + ' pts'));
                badges.appendChild(document.createTextNode(' '));
                badges.appendChild(el('span', 'level-badge ' + rep.level, rep.level));
                if (r.extras.availability === 1) {
                    badges.appendChild(document.createTextNode(' '));
                    badges.appendChild(el('span', 'avail-badge', 'Available'));
                } else if (r.extras.availability === 2) {
                    badges.appendChild(document.createTextNode(' '));
                    badges.appendChild(el('span', 'avail-badge Busy', 'Busy'));
                }
                if (isStale(r.extras.lastUpdated)) {
                    badges.appendChild(document.createTextNode(' '));
                    badges.appendChild(el('span', 'badge stale', 'Stale'));
                }
                if (r.agentCardVerified) {
                    badges.appendChild(document.createTextNode(' '));
                    badges.appendChild(el('span', 'verified-badge', '✓ Verified Agent Card'));
                }
                if ((r.extras.guild || '').trim()) {
                    badges.appendChild(document.createTextNode(' '));
                    badges.appendChild(el('span', 'guild-tag', 'Guild: ' + r.extras.guild));
                }
                li.appendChild(badges);
                li.appendChild(el('p', null, 'Capabilities: ' + (p.capabilities || '—')));
                if (p.description) li.appendChild(el('p', null, p.description));
                li.appendChild(el('p', 'hint',
                    'Completed: ' + rep.completed + ' · Delegated to: ' + rep.delegatedTo +
                    ' · Accepted: ' + rep.accepted +
                    (rep.qualityAvg !== null ? ' · Quality ★' + rep.qualityAvg.toFixed(1) : '') +
                    (r.extras.capacityNote ? ' · Capacity: ' + r.extras.capacityNote : '')));
                var addr = el('p', 'addr', p.holder);
                var addrUrl = explorerAddressUrl(state.chainId, p.holder);
                if (addrUrl) {
                    var a = el('a', null, 'View address in explorer ↗');
                    a.href = addrUrl;
                    a.target = '_blank';
                    a.rel = 'noopener';
                    li.appendChild(addr);
                    var wrap = el('p'); wrap.appendChild(a);
                    li.appendChild(wrap);
                } else {
                    li.appendChild(addr);
                }
                var actions = el('div', 'actions');
                var cvBtn = el('button', 'btn small', 'View CV');
                cvBtn.type = 'button';
                cvBtn.addEventListener('click', function () { showCV(p.holder); });
                actions.appendChild(cvBtn);
                var btn = el('button', 'btn small', 'Delegate to this agent');
                btn.type = 'button';
                btn.addEventListener('click', function () {
                    $('delegateTo').value = p.holder;
                    $('delegateSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
                    $('delegateParentId').focus();
                });
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
            hint.textContent = 'This address does not hold an Agent ID yet, so it cannot publish a profile. Claim an Agent ID first in the Binance app (Wallet > Agent ID banner).';
            $('myProfileCurrent').hidden = true;
            state.myProfile = null;
            await refreshAccountUI(); // F10: don't leave the previous account's holder info showing
            return;
        }
        hint.textContent = 'The profile is published under your own name. Anyone can see it in the directory; you can change or remove it at any time.';
        if (state.myProfile.exists) {
            $('myProfileCurrent').hidden = false;
            $('myProfileName').textContent = state.myProfile.name || '(no name)';
            $('myProfileCaps').textContent = state.myProfile.capabilities || '—';
            $('myProfileDesc').textContent = state.myProfile.description || '';
            $('profileName').value = state.myProfile.name || '';
            $('profileCaps').value = state.myProfile.capabilities || '';
            $('profileDesc').value = state.myProfile.description || '';
        } else {
            $('myProfileCurrent').hidden = true;
        }
        await refreshMyExtras();
        await refreshAccountUI();
    }

    // Profile extras (Round 5): availability, capacity, guild, Agent
    // Card URL + signature, heartbeat. Shown under "My profile".
    async function refreshMyExtras() {
        var current = $('myExtrasCurrent');
        if (!state.account || !state.client || !state.myProfile || !state.myProfile.exists) {
            current.hidden = true;
            state.myExtras = null;
            return;
        }
        try {
            state.myExtras = await state.client.getProfileExtras(state.account);
        } catch (err) {
            // The connected deployment may predate the Round 5 contract:
            // extras are unavailable, but the basic profile still works.
            state.myExtras = null;
            current.hidden = true;
            return;
        }
        var x = state.myExtras;
        current.hidden = false;
        $('myExtrasAvailability').textContent = x.availabilityLabel;
        $('myExtrasStale').hidden = !isStale(x.lastUpdated);
        $('myExtrasCapacity').textContent = x.capacityNote || '—';
        $('myExtrasGuild').textContent = x.guild || '—';
        var cardVerified = x.agentCardUrl &&
            EA.verifyAgentCardSignature(state.account, x.agentCardUrl, x.agentCardSignature);
        $('myExtrasCard').textContent = x.agentCardUrl
            ? (cardVerified ? '✓ Verified: ' + x.agentCardUrl : 'Unverified: ' + x.agentCardUrl)
            : '—';
        $('myExtrasUpdated').textContent = daysAgoText(x.lastUpdated);
        $('extrasAvailability').value = String(x.availability);
        $('extrasCapacity').value = x.capacityNote || '';
        $('extrasGuild').value = x.guild || '';
        $('extrasCardUrl').value = x.agentCardUrl || '';
    }

    // ------------------------------------------------------------------
    // Tasks
    // ------------------------------------------------------------------
    function taskActions(task) {
        var wrap = el('div', 'actions');
        var me = state.account;

        var chainBtn = el('button', 'btn small', 'View chain');
        chainBtn.type = 'button';
        chainBtn.addEventListener('click', function () { showChain(task.id); });
        wrap.appendChild(chainBtn);

        if (!me) return wrap;

        if ((me === task.creator || me === task.assignee) &&
            (task.statusName === 'Open' || task.statusName === 'Accepted')) {
            var delBtn = el('button', 'btn small', 'Delegate');
            delBtn.type = 'button';
            delBtn.addEventListener('click', function () {
                $('delegateParentId').value = task.id;
                $('delegateSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
                $('delegateTo').focus();
            });
            wrap.appendChild(delBtn);
        }
        if (me === task.assignee && task.statusName === 'Delegated') {
            // Reputation stake (Round 5): accept plainly, or stake 1-10
            // reputation points. Completing returns the stake as score;
            // a cancel after acceptance burns it. Points only, no funds.
            var stakeSel = document.createElement('select');
            stakeSel.className = 'small';
            stakeSel.setAttribute('aria-label', 'Reputation stake (points)');
            var stake0 = document.createElement('option');
            stake0.value = '0';
            stake0.textContent = 'Accept (no stake)';
            stakeSel.appendChild(stake0);
            for (var s = 1; s <= 10; s++) {
                var sopt = document.createElement('option');
                sopt.value = String(s);
                sopt.textContent = 'Accept & stake ' + s + ' pts';
                stakeSel.appendChild(sopt);
            }
            stakeSel.value = '0';
            wrap.appendChild(stakeSel);
            var okBtn = el('button', 'btn small primary', 'Accept');
            okBtn.type = 'button';
            okBtn.addEventListener('click', function () {
                var stake = Number(stakeSel.value);
                if (stake > 0) {
                    runWrite('Accepting with a ' + stake + '-point stake…',
                        function (onStage) { return state.client.acceptDelegationStaked(state.signer, task.id, stake, onStage); },
                        'Delegation #' + task.id + ' accepted with a ' + stake + '-point stake.');
                } else {
                    runWrite('Accepting delegation…',
                        function (onStage) { return state.client.acceptDelegation(state.signer, task.id, onStage); },
                        'Delegation #' + task.id + ' accepted.');
                }
            });
            var noBtn = el('button', 'btn small', 'Reject');
            noBtn.type = 'button';
            noBtn.addEventListener('click', function () {
                runWrite('Rejecting delegation…',
                    function (onStage) { return state.client.rejectDelegation(state.signer, task.id, onStage); },
                    'Delegation #' + task.id + ' rejected.');
            });
            wrap.appendChild(okBtn);
            wrap.appendChild(noBtn);
        }
        // Completion applies to delegated subtasks only — never to a root
        // task (roots start Open and the contract has no path to Completed
        // for them; see estafagen.js STATUS note).
        if (me === task.assignee && task.statusName === 'Accepted' && !task.isRoot) {
            var doneBtn = el('button', 'btn small primary', 'Complete');
            doneBtn.type = 'button';
            doneBtn.addEventListener('click', function () {
                runWrite('Marking as complete…',
                    function (onStage) { return state.client.completeTask(state.signer, task.id, onStage); },
                    'Task #' + task.id + ' completed.');
            });
            wrap.appendChild(doneBtn);
        }
        if (me === task.creator && task.statusName !== 'Completed' && task.statusName !== 'Cancelled') {
            var cancelBtn = el('button', 'btn small danger', 'Cancel');
            cancelBtn.type = 'button';
            cancelBtn.addEventListener('click', function () {
                runWrite('Cancelling task…',
                    function (onStage) { return state.client.cancelTask(state.signer, task.id, onStage); },
                    'Task #' + task.id + ' cancelled.');
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
            status.textContent = 'Tasks are not available on this network.';
            return;
        }
        status.textContent = 'Loading tasks…';
        try {
            // Total count first, so the status line can say when the
            // display is capped (F16: listTasks shows at most 100 newest).
            var total = await state.client.getTaskCount();
            var rawTasks = await state.client.listTasks(100);
            // Private-task hashes, one call per task (Round 5). Public
            // tasks have a zero hash; only non-zero hashes are private.
            var hashes = await Promise.all(rawTasks.map(function (t) {
                return state.client.getTaskContentHash(t.id).catch(function () { return '0x' + '0'.repeat(64); });
            }));
            state.tasks = rawTasks;
            status.textContent = total === 0
                ? 'No tasks yet.'
                : state.tasks.length < total
                    ? 'Showing ' + state.tasks.length + ' newest tasks of ' + total + ' tasks.'
                    : state.tasks.length + ' tasks.';
            state.tasks.forEach(function (t, idx) {
                var li = el('li');
                var h = el('h3', null, '#' + t.id + ' · ' + t.title);
                li.appendChild(h);
                var badge = el('span', 'status-badge ' + t.statusName, t.statusLabel);
                var badgeWrap = el('p'); badgeWrap.appendChild(badge);
                if (hashes[idx] !== '0x' + '0'.repeat(64)) {
                    badgeWrap.appendChild(document.createTextNode(' '));
                    badgeWrap.appendChild(el('span', 'private-badge', 'Private — content hashed on-chain'));
                }
                li.appendChild(badgeWrap);
                if (t.description) li.appendChild(el('p', null, t.description));
                if (hashes[idx] !== '0x' + '0'.repeat(64)) {
                    // Verify private content: paste the plaintext, the
                    // page hashes it and compares with the on-chain hash.
                    // Nothing is sent anywhere — the check is local.
                    var verifyRow = el('div', 'row');
                    var verifyInput = document.createElement('input');
                    verifyInput.type = 'text';
                    verifyInput.placeholder = 'Paste the private content to verify it';
                    var verifyBtn = el('button', 'btn small', 'Verify content');
                    verifyBtn.type = 'button';
                    var verifyMsg = el('span', 'form-msg');
                    verifyBtn.addEventListener('click', function () {
                        var ok = EA.contentHashFor(verifyInput.value) === hashes[idx];
                        verifyMsg.textContent = ok
                            ? '✓ Content matches the on-chain hash.'
                            : '✗ Content does NOT match the on-chain hash.';
                        verifyMsg.className = 'form-msg' + (ok ? ' ok' : ' error');
                    });
                    verifyRow.appendChild(verifyInput);
                    verifyRow.appendChild(verifyBtn);
                    li.appendChild(verifyRow);
                    li.appendChild(verifyMsg);
                }
                li.appendChild(el('p', 'addr',
                    'Creator: ' + EA.shortAddress(t.creator) +
                    ' · Assignee: ' + EA.shortAddress(t.assignee) +
                    (t.isRoot ? '' : ' · subtask of #' + t.parentId)));
                if (t.createdAt) {
                    li.appendChild(el('p', null, 'Created: ' +
                        new Date(t.createdAt * 1000).toLocaleString('en-US')));
                }
                if (t.isRoot) {
                    li.appendChild(el('p', 'hint',
                        'Root task: an ongoing container — completed through its subtasks, not a complete button.'));
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
                    ' (assignee ' + EA.shortAddress(t.assignee) + ')');
                list.appendChild(li);
            });
            if (chain.length === 0) list.appendChild(el('li', null, 'Task not found.'));
        } catch (err) {
            list.appendChild(el('li', null, explain(err, 'call')));
        }
        $('chainSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // Agent CV (Round 5): public resume from on-chain history.
    async function showCV(holder) {
        var body = $('cvBody');
        var status = $('cvStatus');
        body.hidden = true;
        body.innerHTML = '';
        if (!state.client) {
            status.textContent = 'The contract is not available on this network yet.';
            return;
        }
        if (!EA.isAddress(holder)) {
            status.textContent = 'Enter a valid address to view a CV.';
            return;
        }
        status.textContent = 'Loading CV…';
        try {
            var cv = await state.client.getAgentCV(holder);
            if (!cv.profile.exists) {
                status.textContent = 'This address has no published profile.';
                return;
            }
            status.textContent = '';
            body.hidden = false;
            var rep = cv.reputation;
            var head = el('h3', null, cv.profile.name || '(no name)');
            body.appendChild(head);
            var badges = el('p');
            badges.appendChild(el('span', 'score-badge', '★ ' + rep.score + ' pts'));
            badges.appendChild(document.createTextNode(' '));
            badges.appendChild(el('span', 'level-badge ' + rep.level, rep.level));
            if (cv.agentCardVerified) {
                badges.appendChild(document.createTextNode(' '));
                badges.appendChild(el('span', 'verified-badge', '✓ Verified Agent Card'));
            }
            if ((cv.extras.guild || '').trim()) {
                badges.appendChild(document.createTextNode(' '));
                badges.appendChild(el('span', 'guild-tag', 'Guild: ' + cv.extras.guild));
            }
            body.appendChild(badges);
            var grid = el('dl', 'cv-grid');
            function row(dt, dd) {
                grid.appendChild(el('dt', null, dt));
                grid.appendChild(el('dd', null, dd));
            }
            row('Address', cv.profile.holder);
            row('Capabilities', cv.profile.capabilities || '—');
            row('Description', cv.profile.description || '—');
            row('Availability', cv.extras.availabilityLabel +
                (cv.extras.capacityNote ? ' · ' + cv.extras.capacityNote : ''));
            row('Last updated', daysAgoText(cv.extras.lastUpdated));
            row('Completed', String(rep.completed) + ' tasks');
            row('Delegated to', String(rep.delegatedTo) + ' · Accepted ' + rep.accepted +
                ' · Rejected ' + rep.rejected + ' · Cancelled after accept ' + rep.cancelledAfterAccept);
            row('Quality attestations', rep.qualityAvg !== null
                ? '★' + rep.qualityAvg.toFixed(1) + ' average over ' + rep.qualityReceived.length
                : 'none yet');
            row('Brief attestations', rep.briefAvg !== null
                ? '★' + rep.briefAvg.toFixed(1) + ' average over ' + rep.briefReceived.length
                : 'none yet');
            if (rep.stakedCompleted > 0 || rep.stakedBurned > 0) {
                row('Stakes', rep.stakedCompleted + ' staked completions · ' + rep.stakedBurned + ' stakes burned');
            }
            body.appendChild(grid);
            if (cv.completedTasks.length > 0) {
                body.appendChild(el('h3', null, 'Completed work'));
                var ul = el('ul', 'task-list');
                cv.completedTasks.forEach(function (t) {
                    var li = el('li');
                    li.appendChild(el('h3', null, '#' + t.id + ' · ' + t.title));
                    li.appendChild(el('p', 'addr',
                        'Delegated by ' + EA.shortAddress(t.creator) +
                        ' · Completed ' + new Date(t.createdAt * 1000).toLocaleString('en-US')));
                    ul.appendChild(li);
                });
                body.appendChild(ul);
            } else {
                body.appendChild(el('p', 'hint', 'No completed work on-chain yet.'));
            }
            if (cv.historyTasks.length > 0) {
                body.appendChild(el('h3', null, 'Full history'));
                var hul = el('ul', 'task-list');
                cv.historyTasks.slice(0, 20).forEach(function (t) {
                    var hli = el('li');
                    hli.appendChild(el('h3', null, '#' + t.id + ' · ' + t.title));
                    hli.appendChild(el('p', null, t.statusLabel +
                        ' · creator ' + EA.shortAddress(t.creator) +
                        ' · assignee ' + EA.shortAddress(t.assignee)));
                    hul.appendChild(hli);
                });
                body.appendChild(hul);
            }
        } catch (err) {
            status.textContent = explain(err, 'call');
            try { console.error('[EstafAgen] CV load failed', err); } catch (e) { /* ignore */ }
        }
        $('cvSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // Attestations (Round 5): completed tasks where I am the creator
    // (quality attestation pending) or the assignee (brief attestation
    // pending), and neither side has attested yet.
    async function refreshAttestations() {
        var list = $('attestList');
        var status = $('attestStatus');
        list.innerHTML = '';
        if (!state.client || !state.account) {
            status.textContent = state.client
                ? 'Connect your wallet to see attestations waiting for you.'
                : 'Attestations are not available on this network.';
            return;
        }
        status.textContent = 'Loading attestations…';
        try {
            var tasks = await state.client.listTasks(100);
            var me = state.account.toLowerCase();
            var pending = [];
            // Only my completed tasks need attestation checks (one
            // quality + one brief call each) — not the whole list.
            var mine = tasks.filter(function (t) {
                return t.statusName === 'Completed' &&
                    (t.creator.toLowerCase() === me || t.assignee.toLowerCase() === me);
            });
            for (var i = 0; i < mine.length; i++) {
                var t = mine[i];
                var q = await state.client.getQualityAttestationOrDefault(t.id);
                var b = await state.client.getBriefAttestationOrDefault(t.id);
                if (t.creator.toLowerCase() === me && !q.exists) {
                    pending.push({ task: t, kind: 'quality' });
                }
                if (t.assignee.toLowerCase() === me && !b.exists) {
                    pending.push({ task: t, kind: 'brief' });
                }
            }
            if (pending.length === 0) {
                status.textContent = 'Nothing to attest right now.';
                return;
            }
            status.textContent = pending.length + ' attestation(s) waiting for you.';
            pending.forEach(function (item) {
                var t = item.task;
                var li = el('li');
                li.appendChild(el('h3', null, '#' + t.id + ' · ' + t.title));
                li.appendChild(el('p', null, item.kind === 'quality'
                    ? 'Attest the work quality of ' + EA.shortAddress(t.assignee) + ' (1–5 stars).'
                    : 'Attest the brief clarity of ' + EA.shortAddress(t.creator) + ' (1–5 stars).'));
                var sel = document.createElement('select');
                sel.className = 'small';
                sel.setAttribute('aria-label', 'Stars');
                [5, 4, 3, 2, 1].forEach(function (n) {
                    var opt = document.createElement('option');
                    opt.value = String(n);
                    opt.textContent = n + ' ★';
                    sel.appendChild(opt);
                });
                sel.value = '5';
                var btn = el('button', 'btn small primary', 'Attest');
                btn.type = 'button';
                btn.addEventListener('click', function () {
                    var score = Number(sel.value);
                    if (item.kind === 'quality') {
                        runWrite('Attesting quality…',
                            function (onStage) { return state.client.attestQuality(state.signer, t.id, score, onStage); },
                            'Quality attested for task #' + t.id + '.');
                    } else {
                        runWrite('Attesting brief…',
                            function (onStage) { return state.client.attestBrief(state.signer, t.id, score, onStage); },
                            'Brief attested for task #' + t.id + '.');
                    }
                });
                var row = el('div', 'row');
                row.appendChild(sel);
                row.appendChild(btn);
                li.appendChild(row);
                list.appendChild(li);
            });
        } catch (err) {
            status.textContent = explain(err, 'call');
            try { console.error('[EstafAgen] attestations load failed', err); } catch (e) { /* ignore */ }
        }
    }

    // -- Tier 2: private delegation, swarm, playbooks, recurring ------
    // Local-storage helpers (plans + recurring templates live ONLY in
    // this browser — there is no server). All access is guarded: some
    // embedded browsers disable localStorage.
    function loadLocal(key) {
        try {
            var raw = window.localStorage.getItem(key);
            return raw ? JSON.parse(raw) : [];
        } catch (e) { return []; }
    }
    function saveLocal(key, value) {
        try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    }

    // Built-in delegation playbooks (Round 5). Steps are templates:
    // parallel mode delegates every step from the root (each is a
    // separate transaction); sequential mode creates the root + the
    // first step now and saves the rest as a local plan.
    var PLAYBOOKS = [
        {
            id: 'research-write-review',
            name: 'Research → Write → Review',
            steps: [
                { title: 'Research', description: 'Gather sources and key facts.' },
                { title: 'Write', description: 'Draft from the research.' },
                { title: 'Review', description: 'Check the draft for accuracy and clarity.' },
            ],
        },
        {
            id: 'collect-analyze-report',
            name: 'Collect → Analyze → Report',
            steps: [
                { title: 'Collect', description: 'Collect the raw data.' },
                { title: 'Analyze', description: 'Analyze the collected data.' },
                { title: 'Report', description: 'Write the report from the analysis.' },
            ],
        },
        {
            id: 'draft-review-publish',
            name: 'Draft → Review → Publish',
            steps: [
                { title: 'Draft', description: 'Write the first draft.' },
                { title: 'Review', description: 'Review the draft and list fixes.' },
                { title: 'Publish', description: 'Apply the fixes and publish.' },
            ],
        },
    ];

    function renderPlaybooks() {
        var wrap = $('playbookList');
        wrap.innerHTML = '';
        var agents = state.rankedProfiles.map(function (r) { return r.profile; });
        PLAYBOOKS.forEach(function (pb) {
            var card = el('div', 'card');
            card.style.marginBottom = '10px';
            card.appendChild(el('h3', null, pb.name));
            var rootInput = document.createElement('input');
            rootInput.type = 'text';
            rootInput.placeholder = 'Root task title, e.g. Q3 market report';
            rootInput.maxLength = 120;
            card.appendChild(rootInput);
            var selects = [];
            pb.steps.forEach(function (step, i) {
                var label = document.createElement('label');
                label.textContent = 'Step ' + (i + 1) + ': ' + step.title + ' → agent';
                var sel = document.createElement('select');
                agents.forEach(function (a) {
                    var opt = document.createElement('option');
                    opt.value = a.holder;
                    opt.textContent = (a.name || EA.shortAddress(a.holder)) + ' (' + EA.shortAddress(a.holder) + ')';
                    sel.appendChild(opt);
                });
                if (agents.length === 0) {
                    var none = document.createElement('option');
                    none.value = '';
                    none.textContent = 'No agents in the directory yet';
                    sel.appendChild(none);
                }
                label.appendChild(sel);
                card.appendChild(label);
                selects.push(sel);
            });
            var msg = el('p', 'form-msg');
            card.appendChild(msg);
            var row = el('div', 'row');
            var parBtn = el('button', 'btn small primary', 'Instantiate (parallel)');
            parBtn.type = 'button';
            parBtn.addEventListener('click', async function () {
                await instantiatePlaybook(pb, rootInput.value.trim(), selects.map(function (s) { return s.value; }), 'parallel', msg);
            });
            var seqBtn = el('button', 'btn small', 'Instantiate (sequential)');
            seqBtn.type = 'button';
            seqBtn.addEventListener('click', async function () {
                await instantiatePlaybook(pb, rootInput.value.trim(), selects.map(function (s) { return s.value; }), 'sequential', msg);
            });
            row.appendChild(parBtn);
            row.appendChild(seqBtn);
            card.appendChild(row);
            wrap.appendChild(card);
        });
        renderPlans();
        renderRecurring();
    }

    async function instantiatePlaybook(pb, rootTitle, recipients, mode, msgNode) {
        var blocked = requireClientAndAccount();
        if (blocked) { formMsg(msgNode, blocked); return; }
        if (!rootTitle) { formMsg(msgNode, 'A root task title is required.'); return; }
        if (recipients.some(function (r) { return !EA.isAddress(r); })) {
            formMsg(msgNode, 'Pick an agent for every step first.');
            return;
        }
        formMsg(msgNode, '');
        try {
            await runWrite('Creating root task…',
                function (onStage) { return state.client.createTask(state.signer, rootTitle, 'Playbook: ' + pb.name, onStage); },
                'Root task created.');
            var rootId = await state.client.getTaskCount();
            if (mode === 'parallel') {
                for (var i = 0; i < pb.steps.length; i++) {
                    var step = pb.steps[i];
                    await runWrite('Delegating step ' + (i + 1) + '…',
                        (function (st, to) {
                            return function (onStage) {
                                return state.client.delegateTask(state.signer, rootId, to, st.title, st.description, onStage);
                            };
                        })(step, recipients[i]),
                        'Step "' + step.title + '" delegated.');
                }
                formMsg(msgNode, 'Playbook instantiated: ' + pb.steps.length + ' subtasks under #' + rootId + '.', true);
            } else {
                var first = pb.steps[0];
                await runWrite('Delegating first step…',
                    function (onStage) {
                        return state.client.delegateTask(state.signer, rootId, recipients[0], first.title, first.description, onStage);
                    },
                    'First step delegated.');
                var firstSubId = await state.client.getTaskCount();
                var plans = loadLocal('estafagen-plans-v1');
                plans.push({
                    playbookId: pb.id,
                    playbookName: pb.name,
                    rootId: rootId,
                    nextIndex: 1,
                    lastSubtaskId: firstSubId,
                    steps: pb.steps,
                    recipients: recipients,
                    createdAt: Date.now(),
                });
                saveLocal('estafagen-plans-v1', plans);
                renderPlans();
                formMsg(msgNode, 'Playbook started: first step delegated under #' + rootId + '. The rest is saved as a plan below.', true);
            }
        } catch (e) { /* message already shown by txFail */ }
    }

    function renderPlans() {
        var list = $('planList');
        list.innerHTML = '';
        var plans = loadLocal('estafagen-plans-v1');
        if (plans.length === 0) {
            list.appendChild(el('li', null, 'No saved plans yet.'));
            return;
        }
        plans.forEach(function (plan, idx) {
            var li = el('li');
            li.appendChild(el('h3', null, plan.playbookName + ' (root #' + plan.rootId + ')'));
            li.appendChild(el('p', null,
                'Next step: ' + (plan.nextIndex < plan.steps.length
                    ? plan.steps[plan.nextIndex].title + ' → ' + EA.shortAddress(plan.recipients[plan.nextIndex])
                    : 'done')));
            var row = el('div', 'row');
            if (plan.nextIndex < plan.steps.length) {
                var contBtn = el('button', 'btn small primary', 'Continue: delegate next step');
                contBtn.type = 'button';
                contBtn.addEventListener('click', async function () {
                    await continuePlan(idx);
                });
                row.appendChild(contBtn);
            }
            var delBtn = el('button', 'btn small danger', 'Discard plan');
            delBtn.type = 'button';
            delBtn.addEventListener('click', function () {
                var ps = loadLocal('estafagen-plans-v1');
                ps.splice(idx, 1);
                saveLocal('estafagen-plans-v1', ps);
                renderPlans();
            });
            row.appendChild(delBtn);
            li.appendChild(row);
            list.appendChild(li);
        });
    }

    async function continuePlan(idx) {
        var plans = loadLocal('estafagen-plans-v1');
        var plan = plans[idx];
        if (!plan) return;
        var blocked = requireClientAndAccount();
        if (blocked) { return; }
        var step = plan.steps[plan.nextIndex];
        var to = plan.recipients[plan.nextIndex];
        try {
            await runWrite('Delegating step "' + step.title + '"…',
                function (onStage) {
                    return state.client.delegateTask(state.signer, plan.lastSubtaskId, to, step.title, step.description, onStage);
                },
                'Step "' + step.title + '" delegated.');
            plan.lastSubtaskId = await state.client.getTaskCount();
            plan.nextIndex++;
            plans[idx] = plan;
            saveLocal('estafagen-plans-v1', plans);
            renderPlans();
        } catch (e) { /* message already shown by txFail; the plan stays saved */ }
    }

    // Recurring delegations (Round 5): saved templates, re-run manually.
    function renderRecurring() {
        var list = $('recurringList');
        list.innerHTML = '';
        var items = loadLocal('estafagen-recurring-v1');
        var status = $('recurringStatus');
        if (items.length === 0) {
            status.textContent = 'No recurring delegations saved yet. Delegate something, then press "Save last delegation as recurring".';
            return;
        }
        status.textContent = items.length + ' saved template(s).';
        items.forEach(function (item, idx) {
            var li = el('li');
            li.appendChild(el('h3', null, item.title));
            li.appendChild(el('p', null, 'To ' + EA.shortAddress(item.to) + ' · under "' + item.parentTitle + '"'));
            var row = el('div', 'row');
            var runBtn = el('button', 'btn small primary', 'Run again');
            runBtn.type = 'button';
            runBtn.addEventListener('click', async function () { await runRecurring(idx); });
            var delBtn = el('button', 'btn small danger', 'Delete');
            delBtn.type = 'button';
            delBtn.addEventListener('click', function () {
                var items2 = loadLocal('estafagen-recurring-v1');
                items2.splice(idx, 1);
                saveLocal('estafagen-recurring-v1', items2);
                renderRecurring();
            });
            row.appendChild(runBtn);
            row.appendChild(delBtn);
            li.appendChild(row);
            list.appendChild(li);
        });
    }

    async function runRecurring(idx) {
        var items = loadLocal('estafagen-recurring-v1');
        var item = items[idx];
        if (!item) return;
        var blocked = requireClientAndAccount();
        if (blocked) { formMsg($('recurringStatus'), blocked); return; }
        try {
            var rootTitle = item.parentTitle + ' — ' + new Date().toLocaleDateString('en-US');
            await runWrite('Creating root task…',
                function (onStage) { return state.client.createTask(state.signer, rootTitle, 'Recurring: ' + item.title, onStage); },
                'Root task created.');
            var rootId = await state.client.getTaskCount();
            await runWrite('Delegating…',
                function (onStage) {
                    return state.client.delegateTask(state.signer, rootId, item.to, item.title, item.description, onStage);
                },
                'Recurring delegation sent to ' + EA.shortAddress(item.to) + '.');
        } catch (e) { /* message already shown by txFail */ }
    }

    // Swarm fan-out (Round 5): checkbox list of directory agents.
    function renderSwarmList() {
        var wrap = $('swarmList');
        wrap.innerHTML = '';
        var agents = state.rankedProfiles.map(function (r) { return r.profile; });
        if (agents.length === 0) {
            wrap.textContent = 'Load the directory first to pick agents.';
            return;
        }
        agents.forEach(function (a) {
            var label = document.createElement('label');
            label.className = 'check';
            var box = document.createElement('input');
            box.type = 'checkbox';
            box.value = a.holder;
            box.className = 'swarm-agent';
            label.appendChild(box);
            label.appendChild(document.createTextNode(' ' + (a.name || EA.shortAddress(a.holder)) + ' (' + EA.shortAddress(a.holder) + ')'));
            wrap.appendChild(label);
        });
    }

    // Provenance tree + swarm view (Round 5).
    async function showTree(rootId) {
        var treeWrap = $('treeWrap');
        var treeList = $('treeList');
        var swarmWrap = $('swarmWrap');
        treeList.innerHTML = '';
        treeWrap.hidden = true;
        swarmWrap.hidden = true;
        if (!state.client) return;
        try {
            var nodes = await state.client.getProvenance(rootId);
            if (nodes.length === 0) {
                treeList.appendChild(el('li', null, 'Task not found (or too old to be in the newest 100 tasks).'));
            } else {
                var privCache = {};
                for (var i = 0; i < nodes.length; i++) {
                    var node = nodes[i];
                    var t = node.task;
                    var isPriv = await state.client.isPrivateTask(t.id);
                    var indent = '';
                    for (var d = 0; d < node.depth; d++) indent += '— ';
                    var li = el('li', null,
                        indent + '#' + t.id + ' · ' + t.title + ' — ' + t.statusLabel +
                        ' (assignee ' + EA.shortAddress(t.assignee) + ')' +
                        (isPriv ? ' · [private]' : '') +
                        ' · ' + new Date(t.createdAt * 1000).toLocaleString('en-US'));
                    treeList.appendChild(li);
                }
            }
            var swarm = await state.client.getSwarm(rootId);
            if (swarm.total > 0) {
                swarmWrap.hidden = false;
                $('swarmBar').style.width = swarm.progressPct + '%';
                $('swarmSummary').textContent =
                    swarm.completed + ' of ' + swarm.total + ' subtasks completed (' + swarm.progressPct + '%) — ' +
                    'Delegated ' + swarm.counts.Delegated + ' · Accepted ' + swarm.counts.Accepted +
                    ' · Completed ' + swarm.counts.Completed + ' · Rejected ' + swarm.counts.Rejected +
                    ' · Cancelled ' + swarm.counts.Cancelled + '.';
            }
            treeWrap.hidden = false;
        } catch (err) {
            treeList.appendChild(el('li', null, explain(err, 'call')));
            treeWrap.hidden = false;
        }
        $('chainSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // Analytics dashboard (Round 5, Tier 3): public stats computed
    // in the browser from on-chain events. No server involved.
    async function refreshAnalytics() {
        var status = $('analyticsStatus');
        if (!state.client) {
            status.textContent = 'Analytics are not available on this network.';
            return;
        }
        status.textContent = 'Loading analytics…';
        try {
            var a = await state.client.computeAnalytics();
            $('statProfiles').textContent = String(a.profiles);
            $('statTasks').textContent = String(a.tasks);
            $('statDelegations').textContent = String(a.delegations);
            $('statCompleted').textContent = String(a.completed);
            $('statRate').textContent = a.completionRate === null ? '—' : a.completionRate + '%';
            $('statRecent').textContent = String(a.recentDelegations7d);
            $('analyticsCaps').textContent = a.topCapabilities.length === 0
                ? 'No capabilities listed yet.'
                : a.topCapabilities.map(function (c) { return c.capability + ' (' + c.count + ')'; }).join(' · ');
            var topList = $('analyticsTop');
            topList.innerHTML = '';
            if (a.topAgents.length === 0) {
                topList.appendChild(el('li', null, 'No reputation history yet.'));
            } else {
                a.topAgents.forEach(function (r) {
                    var li = el('li');
                    li.appendChild(el('h3', null, EA.shortAddress(r.holder) + ' — ★ ' + r.score + ' pts (' + r.level + ')'));
                    li.appendChild(el('p', null, 'Completed: ' + r.completed + ' · Delegated to: ' + r.delegatedTo));
                    topList.appendChild(li);
                });
            }
            var guildList = $('analyticsGuilds');
            guildList.innerHTML = '';
            if (a.guilds.length === 0) {
                guildList.appendChild(el('li', null, 'No guilds declared yet.'));
            } else {
                a.guilds.forEach(function (g) {
                    var li = el('li');
                    li.appendChild(el('h3', null, g.guild));
                    li.appendChild(el('p', null, g.members + ' member(s) · average score ' + g.avgScore + ' pts'));
                    guildList.appendChild(li);
                });
            }
            status.textContent = '';
        } catch (err) {
            status.textContent = explain(err, 'call');
            try { console.error('[EstafAgen] analytics load failed', err); } catch (e) { /* ignore */ }
        }
    }

    async function refreshAll() {
        if (!hasContract(state.chainId)) {
            $('dirStatus').textContent = 'Directory is not available on this network.';
            $('tasksStatus').textContent = 'Tasks are not available on this network.';
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
        // The refreshes are independent reads — run them in
        // parallel instead of one after another (F16).
        await Promise.all([refreshDirectory(), refreshTasks(), refreshMyProfile(), refreshAttestations(), refreshAnalytics()]);
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
            $('wrongNetworkMsg').textContent = 'No provider for this network.';
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
                $('connectBtn').textContent = 'Connect wallet';
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
        if (!state.client) return 'The contract is not available on this network yet.';
        if (!state.account) return 'Connect your wallet first.';
        if (!state.holder) return 'This address does not hold an Agent ID yet.';
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
            loadMsg.textContent = 'Failed to load the ethers library from the CDN (jsDelivr and unpkg). Check your internet connection, then reload this page.';
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
        $('refreshAnalyticsBtn').addEventListener('click', refreshAnalytics);
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
            if (!name || !caps) { formMsg($('profileMsg'), 'Name and capabilities are required.'); return; }
            formMsg($('profileMsg'), '');
            try {
                await runWrite('Publishing profile…',
                    function (onStage) {
                        return state.client.publishProfile(state.signer, name, caps, desc, onStage);
                    },
                    'Profile published. It is now visible in the directory.');
                formMsg($('profileMsg'), 'Profile published.', true);
            } catch (e) { /* message already shown by txFail */ }
        });

        $('removeProfileBtn').addEventListener('click', async function () {
            var blocked = requireClientAndAccount();
            if (blocked) { formMsg($('profileMsg'), blocked); return; }
            if (!window.confirm('Remove your profile? The directory entry will disappear.')) return;
            try {
                await runWrite('Removing profile…',
                    function (onStage) { return state.client.removeProfile(state.signer, onStage); },
                    'Profile removed.');
                formMsg($('profileMsg'), 'Profile removed.', true);
            } catch (e) { /* message already shown by txFail */ }
        });

        // Profile extras (Round 5): availability, capacity, guild, Agent Card URL.
        $('extrasForm').addEventListener('submit', async function (ev) {
            ev.preventDefault();
            var blocked = requireClientAndAccount();
            if (blocked) { formMsg($('extrasMsg'), blocked); return; }
            var availability = Number($('extrasAvailability').value);
            var capacity = $('extrasCapacity').value.trim();
            var guild = $('extrasGuild').value.trim();
            var cardUrl = $('extrasCardUrl').value.trim();
            if (cardUrl && !/^https:\/\//.test(cardUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(cardUrl)) {
                formMsg($('extrasMsg'), 'Agent Card URL must start with https:// (http is only allowed for localhost).');
                return;
            }
            formMsg($('extrasMsg'), '');
            try {
                // Keep the existing signature when the URL is unchanged;
                // a new URL clears it (it must be re-verified).
                var sig = '';
                if (cardUrl && state.myExtras && state.myExtras.agentCardUrl === cardUrl) {
                    sig = state.myExtras.agentCardSignature || '';
                }
                await runWrite('Saving extras…',
                    function (onStage) {
                        return state.client.setProfileExtras(
                            state.signer, availability, capacity, guild, cardUrl, sig, onStage);
                    },
                    'Extras saved.');
                formMsg($('extrasMsg'), 'Extras saved.', true);
            } catch (e) { /* message already shown by txFail */ }
        });

        // Agent Card verification (Round 5): fetch the holder's own card
        // in this browser only, check the A2A shape, then ask the wallet
        // to sign the verification message. The signature is stored
        // on-chain so the badge can be checked without fetching again.
        $('verifyCardBtn').addEventListener('click', async function () {
            var blocked = requireClientAndAccount();
            if (blocked) { formMsg($('extrasMsg'), blocked); return; }
            var cardUrl = $('extrasCardUrl').value.trim();
            if (!cardUrl) { formMsg($('extrasMsg'), 'Enter your Agent Card URL first.'); return; }
            if (!/^https:\/\//.test(cardUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(cardUrl)) {
                formMsg($('extrasMsg'), 'Agent Card URL must start with https:// (http is only allowed for localhost).');
                return;
            }
            formMsg($('extrasMsg'), 'Fetching your Agent Card…');
            try {
                var card = await EA.fetchAgentCard(cardUrl);
                formMsg($('extrasMsg'), 'Card looks like an A2A Agent Card ("' + card.name + '"). Sign the verification message in your wallet…');
                var signature = await state.signer.signMessage(EA.agentCardMessage(cardUrl));
                if (!EA.verifyAgentCardSignature(state.account, cardUrl, signature)) {
                    formMsg($('extrasMsg'), 'Signature check failed — this wallet did not sign for this address.');
                    return;
                }
                var availability = Number($('extrasAvailability').value);
                var capacity = $('extrasCapacity').value.trim();
                var guild = $('extrasGuild').value.trim();
                await runWrite('Saving verified Agent Card…',
                    function (onStage) {
                        return state.client.setProfileExtras(
                            state.signer, availability, capacity, guild, cardUrl, signature, onStage);
                    },
                    'Agent Card verified and saved.');
                formMsg($('extrasMsg'), 'Agent Card verified.', true);
            } catch (err) {
                formMsg($('extrasMsg'), 'Verification failed: ' + explain(err, 'call'));
                try { console.error('[EstafAgen] agent card verification failed', err); } catch (e) { /* ignore */ }
            }
        });

        $('renewProfileBtn').addEventListener('click', async function () {
            var blocked = requireClientAndAccount();
            if (blocked) { formMsg($('extrasMsg'), blocked); return; }
            try {
                await runWrite('Renewing profile…',
                    function (onStage) { return state.client.renewProfile(state.signer, onStage); },
                    'Profile renewed.');
                formMsg($('extrasMsg'), 'Profile renewed.', true);
            } catch (e) { /* message already shown by txFail */ }
        });

        $('showCvBtn').addEventListener('click', function () {
            showCV($('cvAddress').value.trim());
        });
        $('guildFilter').addEventListener('change', refreshDirectory);

        $('createTaskForm').addEventListener('submit', async function (ev) {
            ev.preventDefault();
            var blocked = requireClientAndAccount();
            if (blocked) { formMsg($('taskMsg'), blocked); return; }
            var title = $('taskTitle').value.trim();
            var desc = $('taskDesc').value.trim();
            if (!title) { formMsg($('taskMsg'), 'A task title is required.'); return; }
            formMsg($('taskMsg'), '');
            try {
                await runWrite('Creating task…',
                    function (onStage) {
                        return state.client.createTask(state.signer, title, desc, onStage);
                    },
                    'Task created.');
                formMsg($('taskMsg'), 'Task created.', true);
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
            var isPrivate = $('delegatePrivate').checked;
            var privateContent = $('delegatePrivateContent').value;
            if (!parentId || parentId < 1) { formMsg($('delegateMsg'), 'Parent task ID is not valid.'); return; }
            if (!EA.isAddress(to)) { formMsg($('delegateMsg'), 'Recipient address is not valid.'); return; }
            if (!title) { formMsg($('delegateMsg'), 'A subtask title is required.'); return; }
            if (isPrivate && !privateContent.trim()) {
                formMsg($('delegateMsg'), 'Private delegation needs private content (only its hash goes on-chain).');
                return;
            }
            formMsg($('delegateMsg'), '');
            try {
                if (isPrivate) {
                    var hash = EA.contentHashFor(privateContent);
                    await runWrite('Delegating privately…',
                        function (onStage) {
                            return state.client.delegateTaskPrivate(state.signer, parentId, to, title, hash, onStage);
                        },
                        'Private subtask delegated to ' + EA.shortAddress(to) + '. Share the content off-chain; its hash is ' + hash.slice(0, 18) + '…');
                    state.lastDelegation = null; // private delegations are not saved as recurring templates
                    $('saveRecurringBtn').disabled = true;
                } else {
                    await runWrite('Delegating…',
                        function (onStage) {
                            return state.client.delegateTask(state.signer, parentId, to, title, desc, onStage);
                        },
                        'Subtask delegated to ' + EA.shortAddress(to) + '.');
                    var parentTask = null;
                    try { parentTask = await state.client.getTask(parentId); } catch (e) { /* ignore */ }
                    state.lastDelegation = {
                        to: to,
                        title: title,
                        description: desc,
                        parentTitle: parentTask ? parentTask.title : ('Task #' + parentId),
                    };
                    $('saveRecurringBtn').disabled = false;
                }
                formMsg($('delegateMsg'), isPrivate ? 'Private subtask delegated.' : 'Subtask delegated.', true);
                $('delegateTitle').value = '';
                $('delegateDesc').value = '';
                $('delegatePrivateContent').value = '';
                $('privateHashPreview').textContent = '';
            } catch (e) { /* message already shown by txFail */ }
        });

        $('delegatePrivate').addEventListener('change', function () {
            var on = $('delegatePrivate').checked;
            $('privateFields').hidden = !on;
            $('delegateDesc').disabled = on;
            updatePrivateHashPreview();
        });
        $('delegatePrivateContent').addEventListener('input', updatePrivateHashPreview);

        function updatePrivateHashPreview() {
            if (!$('delegatePrivate').checked) {
                $('privateHashPreview').textContent = '';
                return;
            }
            var content = $('delegatePrivateContent').value;
            $('privateHashPreview').textContent = content
                ? 'On-chain hash: ' + EA.contentHashFor(content)
                : 'Type the private content to see its hash.';
        }

        $('saveRecurringBtn').addEventListener('click', function () {
            if (!state.lastDelegation) return;
            var items = loadLocal('estafagen-recurring-v1');
            items.push(state.lastDelegation);
            saveLocal('estafagen-recurring-v1', items);
            state.lastDelegation = null;
            $('saveRecurringBtn').disabled = true;
            renderRecurring();
            formMsg($('delegateMsg'), 'Saved as a recurring delegation.', true);
        });

        $('swarmDelegateBtn').addEventListener('click', async function () {
            var blocked = requireClientAndAccount();
            if (blocked) { formMsg($('swarmMsg'), blocked); return; }
            var parentId = Number($('delegateParentId').value);
            var title = $('delegateTitle').value.trim();
            var desc = $('delegateDesc').value.trim();
            var selected = Array.prototype.slice.call(document.querySelectorAll('.swarm-agent:checked'))
                .map(function (box) { return box.value; });
            if (!parentId || parentId < 1) { formMsg($('swarmMsg'), 'Enter a parent task ID first.'); return; }
            if (!title) { formMsg($('swarmMsg'), 'A subtask title is required.'); return; }
            if (selected.length === 0) { formMsg($('swarmMsg'), 'Select at least one agent.'); return; }
            formMsg($('swarmMsg'), '');
            var done = 0;
            try {
                for (var i = 0; i < selected.length; i++) {
                    await runWrite('Delegating to ' + EA.shortAddress(selected[i]) + ' (' + (i + 1) + '/' + selected.length + ')…',
                        (function (to) {
                            return function (onStage) {
                                return state.client.delegateTask(state.signer, parentId, to, title, desc, onStage);
                            };
                        })(selected[i]),
                        'Delegated to ' + EA.shortAddress(selected[i]) + '.');
                    done++;
                }
                formMsg($('swarmMsg'), 'Swarm fan-out complete: ' + done + ' delegation(s) under #' + parentId + '.', true);
            } catch (e) {
                formMsg($('swarmMsg'), done + ' of ' + selected.length + ' delegation(s) sent before the failure. The rest were not sent.');
            }
        });

        $('showTreeBtn').addEventListener('click', function () {
            var id = Number($('chainTaskId').value);
            if (id > 0) showTree(id);
        });

        wireWalletEvents();
        initNavSpy();
        renderPlaybooks();
        renderRecurring();

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
