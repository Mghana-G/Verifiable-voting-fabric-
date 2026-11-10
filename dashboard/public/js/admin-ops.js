'use strict';

// Network control (the runbook) and Logs.
(() => {
    const { esc, $, api, follow, banner, loading, errorBox, empty, drawer, hash } = VN;

    // Streams a job's output into a <pre>; resolves when it ends.
    function attachLog(pre, jobId, onEnd) {
        pre.textContent = '';
        return follow(`/api/stream/job/${jobId}`, (e) => {
            if (e.type === 'log') { pre.textContent += `${e.line}\n`; pre.scrollTop = pre.scrollHeight; }
        }, onEnd);
    }

    VN.views.network = async (el) => {
        el.innerHTML = `<h2>Network control</h2>
          <p class="dim small">One place to run the bring-up from HOW_IT_WORKS section 2. Each card runs exactly one fixed command; nothing typed on this page reaches the shell. One operation runs at a time, and voting pauses while it does.</p>
          <div id="nc">${loading('Reading the network state…')}</div>`;
        let streams = [];
        const render = async () => {
            const r = await api('/api/admin/network/ops');
            const box = $('#nc');
            if (!box) return;
            if (!r.ok) { box.innerHTML = errorBox(r.data.error || 'Not available.'); return; }
            const job = r.data.job;
            const running = job && job.state === 'running';
            const idx = { start: 'Start and stop' };
            const HEAD = {
                prereqs: ['Before the election: first-time bring-up', 'Run in this order: 00 to 04, then Health check, then 05 and 06. Skip steps already done. Never run 01 or 02 again without a Teardown.'],
                start: ['During the election: keep the chain running', 'If a node stops or the VM restarts, Start nodes brings everything back with the ledgers intact. Wait about 30 seconds before voting again.'],
                stop: ['After voting is closed: shut down', 'Stops the containers and keeps every ledger volume, so the results stay on the chain.'],
                teardown: ['Danger zone: wipe and start over', 'Only when you want a brand new chain. A full 00 to 06 bring-up follows.'],
            };
            const cards = r.data.ops.map((o) => {
                const isLast = job && job.kind === o.id;
                return `${HEAD[o.id] ? `<div style="margin:18px 0 0;border-top:2px solid var(--line);padding-top:8px"><h3 style="margin:0">${HEAD[o.id][0]}</h3><p class="dim small" style="margin:2px 0 0">${HEAD[o.id][1]}</p></div>` : ''}<div class="step ${isLast && job.state === 'done' ? 'ran' : ''}" data-op="${o.id}"><div class="no">${esc(o.step || (o.id === 'health' ? '✓' : o.id === 'start' ? '▶' : '■'))}</div>
                  <div class="card"><h3 style="margin:0">${esc(o.title)}</h3><p class="small" style="margin:4px 0">${esc(o.does)}<br><span class="dim">Produces: ${esc(o.produces)}</span></p>
                  <div class="cmd"><code>${esc(o.command)}</code></div>
                  ${o.warning ? `<div class="gate">${esc(o.warning)}</div>` : ''}
                  ${o.blocked ? `<div class="gate">${esc(o.blocked)}</div>` : ''}
                  <div class="actions">
                    ${o.typed ? `<input type="text" class="typed" placeholder="type ${o.typed}" aria-label="Type ${o.typed} to confirm" style="width:150px">` : ''}
                    <button class="run ${o.id === 'teardown' ? 'danger' : 'primary'}" ${o.blocked ? 'disabled' : ''}>Run</button>
                    <span class="runmsg small" role="alert"></span></div>
                  <div class="logwrap" ${isLast ? '' : 'hidden'}><pre class="log"></pre><div class="small dim endline"></div></div>
                  ${drawer(o.drawer)}</div></div>`;
            }).join('');
            box.innerHTML = `${running ? banner('warn', `Running: ${esc(job.label)}. Other operations and voting are paused until it ends.`) : ''}<div class="runbook">${cards}</div>`;
            // Re-attach the log of the running (or just finished) job.
            if (job) {
                const card = box.querySelector(`[data-op="${job.kind}"]`);
                if (card) {
                    const pre = card.querySelector('pre.log');
                    card.querySelector('.logwrap').hidden = false;
                    // A finished job is only replayed and labelled; re-running finish() here would loop.
                    streams.push(attachLog(pre, job.id, running ? () => finish(card, job.id) : () => endLine(card, job)));
                }
            }
            box.querySelectorAll('.step').forEach((card) => {
                card.querySelector('.run').onclick = () => run(card);
            });
        };
        function endLine(card, j) {
            card.querySelector('.endline').innerHTML = `${j.state === 'done' ? '<span class="badge b-ok">exit 0</span>' : `<span class="badge b-bad">exit ${esc(j.exitCode)}</span>`} ${(j.durationMs / 1000).toFixed(1)} s${j.logFile ? ` · saved log <code>${esc(j.logFile)}</code>` : ''}`;
        }
        async function finish(card, id) {
            const r = await api('/api/admin/jobs/current');
            const j = r.data;
            if (j && j.id === id) endLine(card, j);
            setTimeout(render, 600);
            VN.admin.poll();
        }
        async function run(card) {
            const id = card.dataset.op;
            const msg = card.querySelector('.runmsg');
            const typed = card.querySelector('.typed');
            if (id === 'teardown' && (!typed || typed.value !== 'TEARDOWN')) { msg.innerHTML = '<span style="color:var(--bad)">Type TEARDOWN first.</span>'; return; }
            if (id === 'teardown' && !confirm('Teardown deletes every ledger volume. Block numbers cited in evidence/ will no longer exist. A full 01 to 06 rebuild follows. Continue?')) return;
            msg.textContent = 'Starting…';
            const r = await api('/api/admin/network/run', { json: { confirm: true, op: id, typed: typed ? typed.value : undefined } });
            if (!r.ok) { msg.innerHTML = `<span style="color:var(--bad)">${esc(r.data.error)}</span>`; return; }
            msg.textContent = '';
            const pre = card.querySelector('pre.log');
            card.querySelector('.logwrap').hidden = false;
            card.querySelectorAll('button.run').forEach((b) => { b.disabled = true; });
            streams.push(attachLog(pre, r.data.id, () => finish(card, r.data.id)));
        }
        render();
        return () => { streams.forEach((s) => s.close()); streams = []; };
    };

    VN.views.logs = async (el) => {
        el.innerHTML = `<h2>Logs</h2><div class="card"><label for="cont">Container (whitelisted: the 17 services and the chaincode containers)</label>
          <select id="cont"></select> <button id="refresh">Refresh</button> <span class="dim small">last 200 lines</span><pre class="log" id="logtext" style="height:520px">Choose a container.</pre></div>`;
        const r = await api('/api/admin/logs');
        const sel = $('#cont');
        if (!r.ok) { $('#logtext').textContent = 'Docker is not answering.'; return; }
        sel.innerHTML = r.data.containers.map((c) => `<option>${esc(c)}</option>`).join('');
        const load = async () => {
            $('#logtext').textContent = 'Loading…';
            const x = await api(`/api/admin/logs/${encodeURIComponent(sel.value)}`);
            $('#logtext').textContent = x.ok ? (x.data.text || '(no output)') : (x.data.error || 'Not available.');
            $('#logtext').scrollTop = $('#logtext').scrollHeight;
        };
        sel.onchange = load; $('#refresh').onclick = load;
        if (r.data.containers.length) load(); else $('#logtext').textContent = 'No containers found.';
    };
})();
