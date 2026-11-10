'use strict';

// "Simulate N voters at this polling station": starts the batch and shows a
// live table over SSE. Rows carry a number, txID, block, latency and result,
// never a voter identifier.
window.VN.batchPanel = function batchPanel(root, startPath) {
    const { esc, api, follow, hash, num, dur } = VN;
    root.innerHTML = `<div class="card">
      <h2>Simulate voters at this polling station</h2>
      <p class="dim small">Registry voters are verified, tokens are minted up to 5 at a time, and ballots are then cast strictly one at a time, because the single TALLY and BURNEDCOUNT keys conflict under concurrency (DEV-005; see <em>What happened on the network</em> below). These are simulated voters: keys are generated on the server for each ballot.</p>
      <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap">
        <div><label for="bcount">Voters (1 to 100)</label><input type="number" id="bcount" min="1" max="100" value="20" style="width:90px"></div>
        <button type="button" class="primary" id="bgo">Run batch</button>
        <span id="bmsg" class="small" role="alert"></span>
      </div>
      <div id="bout"></div>
      ${VN.drawer('submit')}
    </div>`;
    const out = root.querySelector('#bout');
    const msg = root.querySelector('#bmsg');
    const go = root.querySelector('#bgo');

    function attach(job) {
        go.disabled = true;
        const rows = [];
        out.innerHTML = `<div class="small" id="bprog">Starting…</div><div class="scroll"><table><thead><tr><th class="num">#</th><th>Transaction</th><th class="num">Block</th><th class="num">Latency</th><th>Candidate</th><th>Result</th></tr></thead><tbody id="brows"></tbody></table></div><div id="bsum"></div>`;
        const tbody = out.querySelector('#brows');
        follow(`/api/stream/job/${job.id}`, (e) => {
            if (e.type === 'start') out.querySelector('#bprog').textContent = `Issuing ${e.count} ballot tokens…`;
            if (e.type === 'progress') out.querySelector('#bprog').textContent = `Tokens issued: ${e.minted} of ${e.of}${e.skipped ? ` (${e.skipped} skipped, already issued)` : ''}`;
            if (e.type === 'row') {
                out.querySelector('#bprog').textContent = `Casting ballot ${e.n} of ${e.of}`;
                rows.push(e);
                tbody.insertAdjacentHTML('beforeend', `<tr><td class="num">${e.n}</td><td>${hash(e.txID)}</td><td class="num">${e.block === null ? '' : num(e.block)}</td><td class="num">${e.ms === null ? '' : `${num(e.ms)} ms`}</td><td>${esc(e.candidateID)}</td><td><span class="badge ${e.result === 'VALID' ? 'b-ok' : 'b-bad'}">${esc(e.result)}</span></td></tr>`);
            }
            if (e.type === 'log' && /^\d+ registry voters|Only \d+/.test(e.line)) msg.textContent = e.line;
            if (e.type === 'end' && e.result) {
                const r = e.result;
                const inv = r.invariant && !r.invariant.unavailable ? `burnedCount ${r.invariant.burnedCount}, tallyTotal ${r.invariant.tallyTotal} ${r.invariant.burnedCount === r.invariant.tallyTotal ? '<span class="badge b-ok">equal</span>' : '<span class="badge b-bad">differ</span>'}` : '<span class="unavail">unavailable</span>';
                out.querySelector('#bprog').textContent = e.state === 'done' ? 'Finished.' : 'Finished with failures.';
                out.querySelector('#bsum').innerHTML = `<div class="chips" style="margin-top:10px">
                  <div class="chip"><div class="k">Committed</div><div class="v">${r.committed} of ${r.requested}</div></div>
                  <div class="chip"><div class="k">Mean latency</div><div class="v">${r.meanLatencyMs === null ? 'n/a' : `${num(r.meanLatencyMs, 1)} ms`}</div></div>
                  <div class="chip"><div class="k">Ballots per second</div><div class="v">${r.ballotsPerSecond === null ? 'n/a' : num(r.ballotsPerSecond, 2)}</div></div>
                  <div class="chip"><div class="k">Total cast time</div><div class="v">${dur(r.elapsedMs)}</div></div>
                  <div class="chip"><div class="k">Fresh invariant</div><div class="v" style="font-size:.9rem">${inv}</div></div></div>`;
            }
        }, () => { go.disabled = false; });
    }

    go.addEventListener('click', async () => {
        msg.textContent = '';
        const r = await api(startPath, { json: { count: Number(root.querySelector('#bcount').value), confirm: true } });
        if (!r.ok) { msg.innerHTML = `<span style="color:var(--bad)">${esc(r.data.error || 'Could not start.')}</span>`; return; }
        attach(r.data);
    });
    return { attach };
};
