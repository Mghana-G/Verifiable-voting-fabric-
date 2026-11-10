'use strict';

// Admin shell: navigation, status strip, overview (live topology), chaincode, election.
window.VN.views = {};
window.VN.admin = (() => {
    const { esc, $, api, hash, num, banner, loading, errorBox, empty, drawer } = VN;
    const NAV = [
        ['overview', 'Overview'], ['network', 'Network control'], ['chaincode', 'Chaincode'], ['election', 'Election'],
        ['explorer', 'Ledger explorer'], ['tests', 'Tests and evidence'], ['logs', 'Logs'],
        ['records', 'Project records'], ['report', 'Report companion'],
    ];
    let current = 'overview';
    let overview = null;
    let timer = null;
    let cleanup = null;

    function strip(o) {
        const el = $('#strip');
        if (!o) { el.innerHTML = '<span class="pill warn">Status unavailable</span>'; return; }
        const live = o.live;
        const net = live.network;
        const peers = net.peers || [];
        const heights = peers.map((p) => p.height).filter((h) => typeof h === 'number');
        const inSync = heights.length === 4 && new Set(heights).size === 1;
        const audit = live.chaincode && live.chaincode.audit;
        const eq = audit && audit.equal;
        const leader = net.raftLeader && net.raftLeader.leader;
        el.innerHTML = [
            `<span class="pill ${live.status === 'up' ? 'ok' : live.status === 'down' ? 'bad' : 'warn'}">Network ${esc(live.status)}</span>`,
            `<span class="pill">Height ${heights.length ? num(Math.max(...heights)) : 'n/a'}</span>`,
            `<span class="pill ${inSync ? 'ok' : 'warn'}">Peers ${heights.length ? (inSync ? 'in sync' : 'not in sync') : 'n/a'}</span>`,
            `<span class="pill">Raft leader ${leader ? esc(leader) : 'n/a'}</span>`,
            `<span class="pill">${esc(o.election.electionID)}${o.election.locked ? ' (closed)' : ''}</span>`,
            `<span class="pill ${eq === true ? 'ok' : eq === false ? 'bad' : ''}">Invariant ${eq === true ? 'OK' : eq === false ? 'BROKEN' : 'n/a'}</span>`,
            o.job ? `<span class="pill warn">Running: ${esc(o.job.label)}</span>` : '',
        ].join('');
    }

    async function poll() {
        const r = await api('/api/admin/overview');
        if (r.status === 401 || r.status === 403) { location.href = '/'; return; }
        overview = r.ok ? r.data : null;
        strip(overview);
        if (current === 'overview' && VN.views.overviewUpdate) VN.views.overviewUpdate(overview);
        clearTimeout(timer);
        timer = setTimeout(poll, overview && overview.live.status === 'up' ? 12000 : 6000);
    }

    // ── Topology ──
    const stateOf = (services, name) => {
        const s = (services || []).find((x) => x.name === name);
        if (!s) return 'down';
        if (s.state !== 'running') return 'down';
        return /unhealthy|starting/.test(s.status || '') ? 'warn' : 'up';
    };
    function topology(live) {
        const net = live.network || {};
        const svc = net.services || [];
        const cc = net.chaincodeContainers || [];
        const peers = net.peers || [];
        const leader = net.raftLeader && net.raftLeader.leader;
        const orgs = [['IEBC', 'iebc'], ['Judiciary', 'judiciary'], ['Civil Society', 'civilsociety'], ['Media', 'media']];
        let g = '';
        orgs.forEach(([label, k], i) => {
            const x = 20 + i * 240;
            const peer = stateOf(svc, `peer0.org${k}.example.com`);
            const db = stateOf(svc, `couchdb.org${k}`);
            const ca = stateOf(svc, `ca.org${k}.example.com`);
            const ccn = (cc.find((c) => c.name.includes(`org${k}-`)) || {});
            const ccs = ccn.state === 'running' ? 'up' : 'down';
            const h = peers.find((p) => p.key === ['IEBC', 'Judiciary', 'CivilSociety', 'Media'][i]);
            g += `<rect class="box" x="${x}" y="14" width="220" height="196" rx="10"/><text x="${x + 12}" y="34" font-weight="700">${label}</text>
              <rect class="n ${peer}" x="${x + 12}" y="44" width="196" height="40" rx="6"/><text x="${x + 22}" y="62">Peer</text><text class="small" x="${x + 22}" y="76">${h && typeof h.height === 'number' ? `height ${num(h.height)}` : 'height n/a'}</text>
              <rect class="n ${db}" x="${x + 12}" y="92" width="196" height="30" rx="6"/><text x="${x + 22}" y="112">CouchDB</text>
              <rect class="n ${ca}" x="${x + 12}" y="128" width="196" height="30" rx="6"/><text x="${x + 22}" y="148">Certificate authority</text>
              <rect class="n ${ccs}" x="${x + 12}" y="164" width="196" height="34" rx="6"/><text x="${x + 22}" y="178">Chaincode container</text><text class="small" x="${x + 22}" y="191">voting_1.0</text>
              <line class="wire" x1="${x + 110}" y1="210" x2="${x + 110}" y2="236"/>`;
        });
        g += `<rect class="chan" x="20" y="236" width="940" height="34" rx="8"/><text x="490" y="258" text-anchor="middle" font-weight="700">votingchannel (endorsement: 3 of 4 organisations)</text>`;
        const ord = [1, 2, 3].map((n, i) => {
            const x = 150 + i * 250;
            const s = stateOf(svc, `orderer${n}.orgorderer.example.com`);
            const isL = leader === `orderer${n}`;
            return `<line class="wire" x1="${x + 90}" y1="270" x2="${x + 90}" y2="296"/><rect class="n ${s}" x="${x}" y="296" width="180" height="48" rx="6" ${isL ? 'stroke-width="3"' : ''}/><text x="${x + 12}" y="316">orderer${n}${isL ? ' ★ leader' : ''}</text><text class="small" x="${x + 12}" y="332">Raft node ${n}</text>`;
        }).join('');
        g += `<rect class="box" x="120" y="284" width="760" height="70" rx="10"/><text x="130" y="298" class="small">Ordering service (Raft, crash fault tolerant)</text>${ord}`;
        return `<svg class="topo" viewBox="0 0 980 364" role="img" aria-label="Network topology coloured by live state">${g}</svg>
          <div class="legend"><span><i style="background:var(--ok-bg);border:1px solid var(--ok)"></i>running</span><span><i style="background:var(--warn-bg);border:1px solid var(--warn)"></i>degraded</span><span><i style="background:var(--bad-bg);border:1px solid var(--bad)"></i>down</span><span>★ Raft leader</span></div>`;
    }

    VN.views.overview = async (el) => {
        el.innerHTML = '<h2>Overview</h2><div id="ov">' + loading('Reading the network…') + '</div>';
        const draw = (o) => {
            const box = $('#ov');
            if (!box) return;
            if (!o) { box.innerHTML = errorBox('The overview could not be read.'); return; }
            const live = o.live; const net = live.network;
            const banners = live.status === 'up' ? '' : banner(live.status === 'down' ? 'bad' : 'warn', `${esc(live.summary)} ${live.lastReading ? `Last good reading ${esc(VN.when(live.lastReading.at))}.` : ''} <a href="#network">Open Network control</a>`);
            const audit = live.chaincode && live.chaincode.audit;
            const tally = audit && audit.tally && !audit.tally.__unavailable ? audit.tally : {};
            const cands = ['C001', 'C002', 'C003'];
            const tmax = Math.max(1, ...cands.map((c) => tally[c] || 0));
            const rate = o.rate && o.rate.buckets ? o.rate.buckets : null;
            const rmax = rate ? Math.max(1, ...rate) : 1;
            box.innerHTML = `${banners}<section class="card">${topology(live)}</section>
              <div class="grid cols-3" style="margin-top:14px">
              <section class="card"><h3 style="margin-top:0">Peer heights</h3>${(net.peers || []).length ? `<table><tbody>${net.peers.map((p) => `<tr><td>${esc(p.org)}</td><td class="num">${typeof p.height === 'number' ? num(p.height) : '<span class="unavail">n/a</span>'}</td></tr>`).join('')}</tbody></table>` : empty('No peer answered.')}</section>
              <section class="card"><h3 style="margin-top:0">Blocks per minute, last 10 minutes</h3>${rate ? `<div class="mini" role="img" aria-label="Blocks per minute">${rate.map((b) => `<div style="height:${(b / rmax) * 100}%" title="${b}"></div>`).join('')}</div><div class="small dim">oldest to newest, peak ${rmax} per minute${o.rate.capped ? ' (walk capped at 300 blocks)' : ''}</div>` : empty('Not available.')}</section>
              <section class="card"><h3 style="margin-top:0">${esc(o.election.electionID)}</h3>${audit ? `<div class="mini" role="img" aria-label="Tally">${cands.map((c, i) => `<div style="height:${((tally[c] || 0) / tmax) * 100}%;background:var(--c${i + 1})" title="${c}: ${tally[c] || 0}"></div>`).join('')}</div><div class="small dim">${cands.map((c) => `${c} ${tally[c] || 0}`).join(', ')}</div><div style="margin-top:6px">${audit.equal === true ? '<span class="badge b-ok">invariant holds</span>' : audit.equal === false ? '<span class="badge b-bad">invariant broken</span>' : '<span class="badge b-warn">invariant n/a</span>'} ${audit.invariant && !audit.invariant.__unavailable ? `<span class="dim small">burnedCount ${audit.invariant.burnedCount}, tallyTotal ${audit.invariant.tallyTotal}</span>` : ''}</div>` : empty('Not available.')}</section></div>
              <p class="small dim">Read ${esc(VN.when(live.readAt))}. BatchTimeout ${net.batchTimeout && net.batchTimeout.value ? esc(net.batchTimeout.value) : 'being read'}. Orderers: ${(net.orderers || []).map((x) => `${esc(x.short)} ${esc((x.channel && x.channel.status) || 'n/a')}`).join(', ')}.</p>`;
        };
        VN.views.overviewUpdate = draw;
        draw(overview);
    };

    // ── Chaincode ──
    VN.views.chaincode = async (el) => {
        el.innerHTML = `<h2>Chaincode</h2><div id="ccbox">${loading('Reading the committed definition…')}</div>`;
        const r = await api('/api/live');
        const box = $('#ccbox');
        if (!box) return;
        const d = r.ok && r.data.chaincode && r.data.chaincode.definition;
        const defHTML = !r.ok ? errorBox('Not available.') : !d ? empty('No definition.') : d.__unavailable ? `<span class="unavail">${esc(d.why)}</span>` : d.pending ? loading('Decoding the committed definition…') : `<div class="kv"><div>Name</div><div>${esc(d.name)}</div><div>Sequence</div><div>${esc(d.sequence)}</div><div>Version</div><div>${esc(d.version)}</div><div>Endorsement policy</div><div><code>${esc(d.endorsementPolicy)}</code></div><div>Plugins</div><div>${esc(d.endorsementPlugin)} / ${esc(d.validationPlugin)}</div><div>Approvals</div><div>${Object.entries(d.approvals || {}).map(([k, v]) => `<span class="badge ${v ? 'b-ok' : 'b-bad'}">${esc(k)} ${v ? 'approved' : 'not approved'}</span>`).join(' ')}</div></div>
          <h3>Private data collections</h3>${(d.collections || []).map((c) => `<div class="kv"><div>Name</div><div><code>${esc(c.name)}</code></div><div>Members</div><div><code>${esc(c.memberOrgs)}</code></div><div>memberOnlyRead / Write</div><div>${c.memberOnlyRead} / ${c.memberOnlyWrite}</div><div>Required / max peers</div><div>${c.requiredPeerCount} / ${c.maximumPeerCount}</div><div>blockToLive</div><div>${c.blockToLive}</div></div>`).join('') || empty('No collections')}`;
        const FN = [['CreateCandidate', 'candidateID, name, party', 'admin only (role=admin attribute)'], ['MintVAT', 'voterHash, electionID, pollingStationID', 'issues a single-use token; writes VOTERISSUED privately'], ['CastBallot', 'vatID, candidateID, ephemeralPubKey, signature, payload, nonce', 'six checks, then five writes'], ['GetAuditInvariant', 'electionID', 'burnedCount and tallyTotal'], ['GetTally', 'electionID', 'votes per candidate'], ['GetBlockAudit', 'electionID', 'raw chain info for the verifier']];
        const CHK = [['1', 'verifySignature(ephemeralPubKey, signature, payload)', 'ERR_BAD_SIGNATURE'], ['1b', 'payload JSON parses; vatID, candidateID and nonce equal the arguments', 'ERR_BAD_SIGNATURE'], ['2', 'NONCE~election~nonce must be empty', 'ERR_NONCE_USED'], ['3', 'VAT~vatID must exist and be ACTIVE', 'ERR_VAT_NOT_ACTIVE'], ['4', 'CANDIDATE~candidateID must exist', 'ERR_NO_CANDIDATE']];
        box.innerHTML = `<section class="card"><h3 style="margin-top:0">Committed definition</h3>${defHTML}</section>
          <section class="card" style="margin-top:14px"><h3 style="margin-top:0">The six functions</h3><div class="scroll"><table><thead><tr><th>Function</th><th>Arguments, in order</th><th>Notes</th></tr></thead><tbody>${FN.map((f) => `<tr><td><code>${f[0]}</code></td><td>${esc(f[1])}</td><td>${esc(f[2])}</td></tr>`).join('')}</tbody></table></div></section>
          <section class="card" style="margin-top:14px"><h3 style="margin-top:0">CastBallot check order (do not reorder)</h3><div class="scroll"><table><thead><tr><th>#</th><th>Check</th><th>Throws</th></tr></thead><tbody>${CHK.map((c) => `<tr><td>${c[0]}</td><td>${esc(c[1])}</td><td><code>${c[2]}</code></td></tr>`).join('')}</tbody></table></div>${drawer('submit')}</section>`;
    };

    // ── Election ──
    VN.views.election = async (el) => {
        el.innerHTML = `<h2>Election</h2><div id="elbox">${loading('Reading the election…')}</div>`;
        const load = async () => {
            const r = await api('/api/admin/election');
            const box = $('#elbox');
            if (!box) return;
            if (!r.ok) { box.innerHTML = errorBox(r.data.error || 'Not available.'); return; }
            const d = r.data; const e = d.election;
            const tally = d.current && d.current.tally ? d.current.tally : {};
            const inv = d.current && d.current.invariant;
            box.innerHTML = `<div class="grid cols-2"><section class="card"><h3 style="margin-top:0">${esc(e.title)}</h3>
              <div class="kv"><div>Election ID</div><div><code>${esc(e.electionID)}</code></div><div>Polling station</div><div>${esc(e.pollingStationID)}</div><div>Dashboard votes</div><div class="num">${num(e.dashboardVotes)}</div><div>Voting</div><div>${e.locked ? '<span class="badge b-warn">closed</span>' : '<span class="badge b-ok">open</span>'} <span class="dim small">dashboard lock, not enforced by the chaincode</span></div></div>
              <h3>Candidates on this ballot</h3><table><tbody>${d.candidates.map((c) => `<tr><td><code>${esc(c.candidateID)}</code></td><td>${esc(c.name)}</td><td class="dim">${esc(c.party)}</td><td class="num"><strong>${num(tally[c.candidateID] || 0)}</strong></td></tr>`).join('')}</tbody></table>
              <p class="small dim">${d.onChainOnly.map((c) => `${esc(c.candidateID)} ${esc(c.name)}`).join(', ')} exists on chain but is not on this ballot.</p>
              <div>${inv ? `${inv.burnedCount === inv.tallyTotal ? '<span class="badge b-ok">invariant holds</span>' : '<span class="badge b-bad">invariant broken</span>'} <span class="small dim">burnedCount ${inv.burnedCount}, tallyTotal ${inv.tallyTotal}</span>` : '<span class="unavail">invariant unavailable</span>'}</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button id="lock">${e.locked ? 'Reopen voting' : 'Close voting'}</button><button id="fresh">Start a fresh mock election</button></div><div id="elmsg" class="small" role="alert" style="margin-top:6px"></div></section>
              <section class="card"><h3 style="margin-top:0">History</h3>${d.history.length ? `<table><thead><tr><th>Election</th><th>Final tally</th></tr></thead><tbody>${d.history.map((h) => `<tr><td><code>${esc(h.electionID)}</code></td><td>${h.tally ? Object.entries(h.tally).sort().map(([k, v]) => `${esc(k)} ${v}`).join(', ') || 'no votes' : '<span class="unavail">n/a</span>'}</td></tr>`).join('')}</tbody></table>` : empty('No earlier mock election. Starting a fresh one writes a new election ID; earlier ones stay on the ledger.')}</section></div>
              <div id="batchRoot" style="margin-top:14px"></div>`;
            VN.batchPanel($('#batchRoot'), '/api/admin/election/batch');
            $('#lock').onclick = async () => { await api('/api/admin/election/lock', { json: { confirm: true, locked: !e.locked } }); load(); };
            $('#fresh').onclick = () => {
                $('#elmsg').innerHTML = `<div class="confirmbox">Write a new election ID into data/election.json? The current election stays on the ledger and moves to History. <button class="primary" id="fyes">Start fresh</button> <button id="fno">Cancel</button></div>`;
                $('#fno').onclick = () => { $('#elmsg').innerHTML = ''; };
                $('#fyes').onclick = async () => { const x = await api('/api/admin/election/fresh', { json: { confirm: true } }); if (x.ok) load(); else $('#elmsg').textContent = x.data.error; };
            };
        };
        load();
    };

    // ── Router ──
    function mount() {
        const name = (location.hash || '#overview').replace('#', '').split('/')[0];
        current = VN.views[name] ? name : 'overview';
        $('#side').innerHTML = NAV.map(([id, t], i) => `${i === 0 ? '<div class="grp">Operate</div>' : id === 'tests' ? '<div class="grp">Evidence</div>' : id === 'records' ? '<div class="grp">Thesis</div>' : ''}<a href="#${id}" ${id === current ? 'aria-current="page"' : ''}>${t}</a>`).join('');
        if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
        const view = $('#view');
        const result = VN.views[current](view);
        Promise.resolve(result).then((c) => { if (typeof c === 'function') cleanup = c; });
    }

    function start() {
        $('#logout').onclick = async () => { await api('/api/auth/logout', { json: {} }); location.href = '/'; };
        $('#present').onchange = (e) => document.body.classList.toggle('present', e.target.checked);
        window.addEventListener('hashchange', () => {
            const parts = (location.hash || '#overview').replace('#', '').split('/');
            if (VN.views[parts[0]] && parts[0] !== current) { mount(); return; }
            const target = parts[1] || (VN.views[parts[0]] ? null : parts[0]);
            const el = target && document.getElementById(target);
            if (el) el.scrollIntoView({ block: 'start' });
        });
        mount();
        poll();
    }
    return { start, get overview() { return overview; }, poll };
})();
