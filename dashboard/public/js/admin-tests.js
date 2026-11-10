'use strict';

// Tests and evidence: one card per validation test (what it attacks, which
// layer stops it, latest result, link into /evidence/), run buttons for the
// quick tests, a typed confirm for test 2, and commands for the long ones.
(() => {
    const { esc, $, api, follow, num, banner, loading, errorBox, drawer } = VN;
    const isM = (v) => v !== null && typeof v === 'object' && v.__missing === true;
    const val = (v) => (isM(v) ? `<span class="missing">MISSING</span><span class="why">${esc(v.why)}</span>` : esc(v === null || v === undefined ? 'none' : v));
    const evLink = (rel, label) => `<a href="/${rel.split('/').map(encodeURIComponent).join('/')}/" target="_blank" rel="noopener">${esc(label || rel)}</a>`;

    VN.views.tests = async (el) => {
        el.innerHTML = `<h2>Tests and evidence</h2>
          <p class="dim small">The tests write their own timestamped folders under <code>evidence/</code>; the dashboard never writes there. Quick tests can be started here. Test 7 and the full suite are shown as commands only.</p>
          <div id="tbox">${loading('Reading the evidence files…')}</div>`;
        const [st, meta] = await Promise.all([api('/api/state'), api('/api/admin/tests/meta')]);
        const box = $('#tbox');
        if (!box) return;
        if (!st.ok || !meta.ok) { box.innerHTML = errorBox('The evidence files could not be read.'); return; }
        const tests = st.data.tests;
        const crit = st.data.criteria;
        const cards = (tests.cards || []).map((c) => {
            const m = meta.data[c.id] || {};
            const n = c.newest;
            const latest = isM(n) ? val(n) : `${n.pass === true ? '<span class="badge b-ok">PASS</span>' : isM(n.pass) ? val(n.pass) : '<span class="badge b-bad">FAIL</span>'} <span class="dim small">${val(n.observed)}</span>`;
            const run = m.script
                ? `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px">
                    ${m.count ? '<label style="margin:0;display:flex;gap:4px;align-items:center">Votes <input type="number" class="tcount" value="50" min="1" max="1000" style="width:80px"></label>' : ''}
                    ${m.typed ? `<input type="text" class="ttyped" placeholder="type ${m.typed}" style="width:140px">` : ''}
                    <button class="primary trun" data-test="${c.id}">Run test ${c.id}</button><span class="tmsg small" role="alert"></span></div>
                    ${m.typed ? '<div class="gate">This stops the Media peer and runs rebuild-dbs. The replay took about 45 minutes on the current chain (more than 25,000 blocks).</div>' : ''}`
                : '';
            return `<div class="subcard" id="test-${esc(c.id)}"><h3><span>Test ${esc(c.id)}: ${esc(c.name)}</span></h3>
              <dl><dt>Attacks</dt><dd>${esc(m.attacks || c.scenario)}</dd><dt>Stopped by</dt><dd>${esc(m.stoppedBy || c.expected)}</dd><dt>Latest</dt><dd>${latest}</dd>
              <dt>Evidence</dt><dd>${isM(n) ? '' : evLink(n.dir, 'newest valid run')}${isM(n) ? '' : ', '}${evLink(c.evidenceDir, 'all runs')}</dd></dl>${run}
              <div class="logwrap" hidden><pre class="log" style="height:160px"></pre></div></div>`;
        }).join('');
        const cmds = ['7', 'all'].map((k) => `<div class="subcard"><h3>${k === '7' ? 'Test 7: performance' : 'Full suite (run-all.sh)'}</h3><p class="small">${esc(meta.data[k].attacks)}</p><code>${esc(meta.data[k].command)}</code> <button class="copy" data-copy="cd ~/voting-network &amp;&amp; ${esc(meta.data[k].command)}">copy</button><p class="small dim">Run from a terminal: it can take a long time and changes the chain height.</p></div>`).join('');
        const critRows = isM(crit.criteria) || crit.error ? '' : `<h3>Success criteria (evidence/SUMMARY.md)</h3><div class="scroll"><table><thead><tr><th>#</th><th>Criterion</th><th>Tests</th><th>Result</th></tr></thead><tbody>${crit.criteria.map((x) => `<tr><td>${esc(x.number)}</td><td>${esc(x.description || '')}</td><td>${(x.tests || []).map((id) => `<a href="#tests/test-${esc(id)}">${esc(id)}</a>`).join(' + ') || '<span class="dim">test7</span>'}</td><td>${isM(x.result) ? val(x.result) : `<span class="badge ${x.result === 'PASS' ? 'b-ok' : 'b-bad'}">${esc(x.result)}</span>`}</td></tr>`).join('')}</tbody></table></div>`;
        box.innerHTML = `<div class="cards">${cards}</div><h3>Long-running (commands only)</h3><div class="cards">${cmds}</div>${critRows}${drawer('submit').replace('What happened on the network', 'Where the tests attack (the CastBallot checks)')}`;
        box.querySelectorAll('.trun').forEach((b) => {
            b.onclick = async () => {
                const card = b.closest('.subcard');
                const msg = card.querySelector('.tmsg');
                const typed = card.querySelector('.ttyped');
                const count = card.querySelector('.tcount');
                if (typed && typed.value !== 'RUN TEST 2') { msg.innerHTML = '<span style="color:var(--bad)">Type RUN TEST 2 first.</span>'; return; }
                msg.textContent = 'Starting…';
                const r = await api('/api/admin/tests/run', { json: { confirm: true, test: b.dataset.test, typed: typed ? typed.value : undefined, count: count ? Number(count.value) : undefined } });
                if (!r.ok) { msg.innerHTML = `<span style="color:var(--bad)">${esc(r.data.error)}</span>`; return; }
                msg.textContent = 'Running…';
                document.querySelectorAll('.trun').forEach((x) => { x.disabled = true; });
                const wrap = card.querySelector('.logwrap'); wrap.hidden = false;
                const pre = wrap.querySelector('pre');
                follow(`/api/stream/job/${r.data.id}`, (e) => { if (e.type === 'log') { pre.textContent += `${e.line}\n`; pre.scrollTop = pre.scrollHeight; } },
                    async () => { const j = await api('/api/admin/jobs/current'); msg.innerHTML = j.data.state === 'done' ? '<span class="badge b-ok">finished</span> reload this page to see the new result' : `<span class="badge b-bad">exit ${esc(j.data.exitCode)}</span>`; document.querySelectorAll('.trun').forEach((x) => { x.disabled = false; }); });
            };
        });
    };
})();
