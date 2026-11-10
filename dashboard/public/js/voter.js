'use strict';

(() => {
    const { esc, $, api, sse, hash, num, banner, drawer, initials } = VN;
    const STEPS = ['Verified', 'Ballot token', 'Ballot', 'Seal and sign', 'Submitting', 'Receipt'];
    const BAND = ['var(--c1)', 'var(--c2)', 'var(--c3)'];
    let st = null;          // /api/voter/state
    let step = 1;
    let chosen = null;
    let receipt = null;
    let ended = false;

    const stage = $('#stage');

    function stepper() {
        $('#stepper').innerHTML = STEPS.map((s, i) => `<li class="${i + 1 < step ? 'done' : i + 1 === step ? 'now' : ''}">${i + 1}. ${s}</li>`).join('');
    }

    function endpoint(e) { return e; }
    const orgs = (list) => (list && list.length ? list.map((m) => `<span class="badge b-info">${esc(String(m).replace(/^Org|MSP$/g, ''))}</span>`).join(' ') : '<span class="dim">not reported</span>');

    function show(html) { stepper(); stage.innerHTML = html; }

    function errBox(text, extra = '') { return banner('bad', `<strong>${esc(text)}</strong>${extra}`); }

    // 1. Verified
    function s1() {
        step = 1;
        show(`<h2>1. Your ID was verified</h2>
          ${banner('ok', 'The registry hash was recomputed from your voter ID and salt, and it matched the stored hash.')}
          <div class="kv"><div>Voter hash (first 12 hex)</div><div><code>${esc(st.hashPrefix)}…</code></div><div>Election</div><div>${esc(st.election.title)} <span class="dim">(${esc(st.election.electionID)})</span></div></div>
          <p>Your voter ID and salt stay on the polling-station machine. Only the hash goes to the chain, and the chain stores it only in a private collection that IEBC and Judiciary hold.</p>
          <div class="row-end"><button class="primary big" id="next">Request my ballot token</button></div>${drawer('verify')}`);
        $('#next').onclick = s2;
    }

    // 2. Mint
    async function s2() {
        step = 2;
        show(`<h2>2. Issuing your ballot token</h2>${VN.loading('IEBC, Judiciary and Civil Society are endorsing MintVAT…')}`);
        const r = await api('/api/voter/mint', { json: {} });
        if (!r.ok) {
            show(`<h2>2. Ballot token</h2>${errBox(r.data.error || 'Could not issue a token.')}<div class="row-end"><button id="again" class="primary">Try again</button><button id="leave2">Leave booth</button></div>${drawer('mint')}`);
            $('#again').onclick = s2; $('#leave2').onclick = leave;
            return;
        }
        st.vat = r.data.vat;
        showVat();
    }
    function showVat() {
        step = 2;
        const v = st.vat;
        show(`<h2>2. Ballot token issued</h2>
          ${banner('ok', 'MintVAT committed. This token is single-use: casting burns it.')}
          <div class="kv"><div>Token (vatID)</div><div>${hash(v.vatID)} <span class="dim small">the transaction ID</span></div>
          <div>Block</div><div class="num">${num(v.blockNumber)}</div>
          <div>Validation code</div><div><span class="badge b-ok">${esc(v.validationCode)}</span></div>
          <div>Endorsed by</div><div>${orgs(v.endorsedBy)}</div></div>
          <div class="row-end"><button class="primary big" id="next">Go to the ballot</button></div>${drawer('mint')}`);
        $('#next').onclick = s3;
    }

    // 3. Ballot
    function s3() {
        step = 3;
        const cards = st.candidates.map((c, i) => `<button type="button" class="cand" data-id="${esc(c.candidateID)}" aria-pressed="${chosen === c.candidateID}" style="border-top-color:${BAND[i % 3]}">
            <span class="tick" aria-hidden="true">${chosen === c.candidateID ? '&#10003;' : ''}</span>
            <div class="av" style="background:${BAND[i % 3]}">${esc(initials(c.name))}</div>
            <div class="nm">${esc(c.name)}</div><div class="pt">${esc(c.party)}</div><div class="dim small mono">${esc(c.candidateID)}</div></button>`).join('');
        show(`<h2>3. Choose one candidate</h2><div class="cands">${cards}</div>
          <div class="row-end"><button class="primary big" id="confirm" ${chosen ? '' : 'disabled'}>Confirm my choice</button></div>${drawer('ballot')}`);
        stage.querySelectorAll('.cand').forEach((b) => { b.onclick = () => { chosen = b.dataset.id; s3(); }; });
        $('#confirm').onclick = s4;
    }

    // 4. Seal and sign
    async function s4() {
        step = 4;
        show(`<h2>4. Sealing and signing</h2>${VN.loading('Building the canonical payload and signing it with a one-time key…')}`);
        const r = await api('/api/voter/seal', { json: { candidateID: chosen } });
        if (!r.ok) { show(`<h2>4. Seal and sign</h2>${errBox(r.data.error || 'Could not seal.')}<div class="row-end"><button id="back">Back</button></div>`); $('#back').onclick = s3; return; }
        const d = r.data;
        show(`<h2>4. Sealed and signed</h2>
          ${banner('ok', 'The signing key was created, used once and discarded. It is not stored anywhere.')}
          <h3>Canonical payload</h3><pre class="code" style="white-space:pre-wrap;word-break:break-all">${esc(d.payloadStr)}</pre>
          <h3>Signature (base64)</h3><pre class="code" style="white-space:pre-wrap;word-break:break-all">${esc(d.signatureB64)}</pre>
          <details><summary>Ephemeral public key (PEM)</summary><pre class="code">${esc(d.ephemeralPubKey)}</pre></details>
          <p><span class="badge b-ok">private key discarded</span> <span class="dim small">The signature proves the ballot was not altered; it does not prove who you are.</span></p>
          <div class="row-end"><button class="primary big" id="go">Submit my ballot</button><button id="back">Change my choice</button></div>${drawer('seal')}`);
        $('#go').onclick = s5; $('#back').onclick = s3;
    }

    // 5. Submitting: four real stages streamed over SSE
    const PIPE = [
        ['endorsement', 'Endorsement', 'Peers simulate CastBallot and sign (3 of 4 needed).'],
        ['ordering', 'Ordering', 'The Raft ordering service accepts it and cuts a block within 500 ms.'],
        ['validation', 'Validation', 'Every peer checks the endorsement policy and key versions (MVCC).'],
        ['committed', 'Committed', 'The block is written and the state database updated.'],
    ];
    function pipeHTML(states, notes) {
        return `<div class="pipe">${PIPE.map(([id, t, d]) => `<div class="stage ${states[id] || ''}" id="st-${id}"><div class="t">${t}</div><div class="d">${esc(notes[id] || d)}</div></div>`).join('')}</div>`;
    }
    async function s5() {
        step = 5;
        const states = {}; const notes = {};
        const paint = () => { stage.querySelector('#pipeBox').innerHTML = pipeHTML(states, notes); };
        show(`<h2>5. Submitting to the network</h2><div id="pipeBox"></div><div id="s5msg"></div>${drawer('submit')}`);
        paint();
        let failed = null; let retry = false;
        const res = await sse('/api/voter/cast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, (e) => {
            if (e.type === 'receipt') { receipt = e.receipt; return; }
            if (e.type === 'error') { failed = e.error; retry = !!e.retry; return; }
            if (!e.stage) return;
            states[e.stage] = e.state === 'start' ? 'active' : e.state;
            if (e.state === 'done' && e.ms !== undefined) notes[e.stage] = `${e.ms} ms${e.endorsedBy && e.endorsedBy.length ? `, signed by ${e.endorsedBy.map((m) => String(m).replace(/^Org|MSP$/g, '')).join(', ')}` : ''}`;
            if (e.stage === 'committed' && e.state === 'done') notes.committed = `Block ${e.blockNumber}, ${e.code}`;
            paint();
        });
        if (!res.ok) failed = (res.data && res.data.error) || 'The booth could not submit the ballot.';
        if (receipt) return s6();
        if (!failed) failed = 'The connection closed before the result arrived. The ballot may or may not have committed; check the public verifier before retrying.';
        $('#s5msg').innerHTML = `${errBox(failed)}<div class="row-end">${retry ? '<button class="primary" id="retry">Retry cast</button>' : ''}<button id="leave2">Leave booth</button></div>${retry ? '<p class="dim small">Your ballot token is kept in this booth session only, in memory. Retrying is safe: a token can be spent once.</p>' : ''}`;
        if (retry) $('#retry').onclick = s5;
        $('#leave2').onclick = leave;
    }

    // 6. Receipt
    function s6() {
        step = 6; ended = true;
        const r = receipt;
        show(`<h2>6. Your ballot was counted</h2>
          <div class="receipt"><div class="kv">
            <div>Election</div><div>${esc(r.title)} <span class="dim">(${esc(r.electionID)})</span></div>
            <div>Ballot ID</div><div>${hash(r.ballotID)}</div>
            <div>Block</div><div class="num">${num(r.blockNumber)}</div>
            <div>Validation code</div><div><span class="badge b-ok">${esc(r.validationCode)}</span></div>
            <div>Time (UTC)</div><div>${esc(typeof r.timestamp === 'number' ? new Date(r.timestamp * 1000).toISOString() : r.timestamp)}</div>
            <div>Endorsed by</div><div>${orgs(r.endorsedBy)}</div></div>
            <p class="small dim">Keep the ballot ID. Anyone can look it up on the public portal. This receipt can also prove your choice to another person, so this prototype is not receipt-free.</p></div>
          <div class="row-end"><a class="btn primary big" href="/verify#ballot=${encodeURIComponent(r.ballotID)}" target="_blank" rel="noopener">Verify on the public portal</a><button id="print">Print receipt</button><button id="done">Finish</button></div>${drawer('receipt')}`);
        $('#print').onclick = () => window.print();
        $('#done').onclick = leave;
    }

    async function leave() {
        await api('/api/voter/logout', { json: {} });
        location.href = '/';
    }
    $('#leave').onclick = leave;

    function tick() {
        if (!st || ended) { $('#timer').textContent = ''; return; }
        const left = Math.max(0, Math.round((st.expiresAt - Date.now()) / 1000));
        $('#timer').textContent = `Session ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        if (left === 0) { ended = true; show(`<h2>Session ended</h2>${banner('warn', 'This booth session expired after 10 minutes. Sign in again to continue.')}<div class="row-end"><a class="btn primary" href="/">Back to sign-in</a></div>`); }
    }
    setInterval(tick, 1000);

    // Polling-station mode: the simulated batch.
    let batchShown = false;
    $('#batchToggle').onclick = () => {
        const root = $('#batchRoot');
        root.hidden = !root.hidden;
        if (!root.hidden && !batchShown) { VN.batchPanel(root, '/api/voter/batch'); batchShown = true; }
    };

    (async () => {
        const r = await api('/api/voter/state');
        if (!r.ok) { location.href = '/'; return; }
        st = r.data;
        $('#ttl').textContent = st.election.title;
        $('#pstation').textContent = `Polling station ${st.election.pollingStationID}`;
        if (st.election.locked) { show(`<h2>Voting is closed</h2>${banner('warn', 'Voting is closed for this election. This lock is enforced by the dashboard, not by the chaincode.')}`); return; }
        if (st.sealed) { chosen = st.sealed.candidateID; s5(); return; }
        if (st.vat) { showVat(); return; }
        s1();
    })();
})();
