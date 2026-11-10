'use strict';

// Project records (carried over from D1 and D2, nothing dropped). Renders /api/state. Every value goes through V(), which shows a red MISSING
// (with the collector's reason) instead of any default when data is absent.

VN.views.records = async (rootEl) => {
    rootEl.innerHTML = `<h2>Project records</h2>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px"><button id="refresh" type="button">Refresh</button><button id="export" type="button">Export status report</button><span class="dim small" id="exportnote"></span><span class="dim small" id="meta"></span></div>
      <nav id="nav" class="small" style="display:flex;flex-wrap:wrap;gap:4px 12px;margin-bottom:12px"></nav>
      <div id="loading" class="state">Collecting state from the evidence files…</div><div id="app"></div>`;
    let state = null;
    let liveState = null;
    let liveFailedAt = null;
    let electionID = '';
    let liveTimer = null;

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const isM = (v) => v !== null && typeof v === 'object' && v.__missing === true;
    const missingHTML = (v) => `<span class="missing">MISSING</span><span class="why">${esc(v.why)}</span>`;

    const isU = (v) => v !== null && typeof v === 'object' && v.__unavailable === true;
    const unavailHTML = (v) => `<span class="unavail">${esc(v.why)}</span>`;
    function V(v, fmt) {
        if (isM(v)) return missingHTML(v);
        if (isU(v)) return unavailHTML(v);
        if (v === null || v === undefined) return '<span class="dim">none</span>';
        return esc(fmt ? fmt(v) : v);
    }
    // V() plus a design note shown when the value is MISSING by design.
    const VM = (v, note, fmt) => V(v, fmt) + (isM(v) && note ? `<span class="note">${esc(note)}</span>` : '');
    const errBox = (o) => (o && typeof o.error === 'string' ? `<p>${missingHTML({ why: o.error })}</p>` : '');

    const num = (n, d = 0) => Number(n).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
    const msFmt = (n) => `${num(n, 1)} ms`;
    const dur = (ms) => {
        const s = ms / 1000;
        if (s < 120) return `${num(s, 1)} s`;
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        return h ? `${h} h ${m} min` : `${m} min ${num(sec, 1)} s`;
    };
    const gib = (b) => `${num(b / 1073741824, 2)} GiB`;
    const gb = (b) => `${num(b / 1e9, 1)} GB`;
    const mib = (b) => `${num(b / 1048576, 1)} MiB`;
    const pct = (p) => `${p >= 0 ? '+' : ''}${num(p, 2)} %`;
    const when = (iso) => String(iso).replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC');
    const evLink = (rel, label) => `<a href="/${rel.split('/').map(encodeURIComponent).join('/')}/">${esc(label || rel)}</a>`;
    const passBadge = (p) => (isM(p) ? missingHTML(p) : p === true ? '<span class="badge b-ok">PASS</span>' : '<span class="badge b-bad">FAIL</span>');
    const table = (head, rows, numCols = []) => `<div class="scroll"><table><thead><tr>${head.map((h, i) => `<th${numCols.includes(i) ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${numCols.includes(i) ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    const inv = (o) => (isM(o) ? missingHTML(o) : `burnedCount ${o.burnedCount}, tallyTotal ${o.tallyTotal}`);

    function notesBox(n) {
        const notes = state.data.notes;
        if (isM(notes)) return `<details class="notes"><summary>Notes</summary>${missingHTML(notes)}</details>`;
        const text = notes[String(n)] || '';
        return `<details class="notes"${text ? ' open' : ''}><summary>Notes${text ? '' : ' (none)'}</summary>
<textarea data-note="${n}" aria-label="Notes for panel ${n}">${esc(text)}</textarea>
<button type="button" data-save-note="${n}">Save note</button> <span class="dim" data-note-status="${n}"></span></details>`;
    }

    const panel = (n, title, ref, body) => `<section class="card recpanel" id="p${n}"><h2><span class="pn">${n}</span>${esc(title)}<span class="ref">${esc(ref)}</span></h2>${body}${notesBox(n)}</section>`;

    // ── Inline SVG line chart (no libraries) ───────────────────────────────
    const COLOURS = ['#2563eb', '#d97706', '#059669', '#7c3aed'];

    function niceMax(v) {
        if (!(v > 0)) return 1;
        const mag = 10 ** Math.floor(Math.log10(v));
        return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((f) => f * mag).find((x) => x >= v * 1.05);
    }

    function chart({ title, series, xs, xLog, xFmt, yFmt, lines = true }) {
        const W = 640; const H = 280; const m = { l: 64, r: 16, t: 34, b: 40 };
        const pw = W - m.l - m.r; const ph = H - m.t - m.b;
        const ys = series.flatMap((s) => s.points.map((p) => p.y)).filter(Number.isFinite);
        const yMax = niceMax(Math.max(...ys));
        const xMin = Math.min(...xs); const xMax = Math.max(...xs);
        const fx = (x) => m.l + (xLog ? (Math.log10(x) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin) || 1)
            : (x - xMin) / (xMax - xMin || 1)) * pw;
        const fy = (y) => m.t + ph - (y / yMax) * ph;
        let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">`;
        svg += `<text x="${m.l}" y="16" font-weight="600">${esc(title)}</text>`;
        for (let i = 0; i <= 4; i++) {
            const y = (yMax / 4) * i;
            svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${fy(y)}" y2="${fy(y)}" stroke="#e5e7eb"/>`;
            svg += `<text x="${m.l - 6}" y="${fy(y) + 4}" text-anchor="end">${esc(yFmt(y))}</text>`;
        }
        for (const x of xs) svg += `<text x="${fx(x)}" y="${H - m.b + 16}" text-anchor="middle">${esc(xFmt(x))}</text>`;
        svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${m.t + ph}" y2="${m.t + ph}" stroke="#9ca3af"/>`;
        series.forEach((s, i) => {
            const c = COLOURS[i % COLOURS.length];
            const pts = s.points.filter((p) => Number.isFinite(p.y));
            if (lines && pts.length > 1) svg += `<polyline fill="none" stroke="${c}" stroke-width="2" points="${pts.map((p) => `${fx(p.x)},${fy(p.y)}`).join(' ')}"/>`;
            for (const p of pts) svg += `<circle cx="${fx(p.x)}" cy="${fy(p.y)}" r="4" fill="${c}"><title>${esc(`${s.name} at ${xFmt(p.x)}: ${yFmt(p.y)}`)}</title></circle>`;
            svg += `<rect x="${m.l + 6 + i * 150}" y="22" width="10" height="3" fill="${c}"/><text x="${m.l + 20 + i * 150}" y="27">${esc(s.name)}</text>`;
        });
        return `${svg}</svg>`;
    }

    // ── Panels ─────────────────────────────────────────────────────────────

    function chips0() {
        const s = state.status;
        const chip = (k, v, cls = '') => `<div class="chip"><div class="k">${esc(k)}</div><div class="v ${cls}">${v}</div></div>`;
        const L = liveState;
        const netChip = !L ? '<span class="badge b-info">reading…</span>'
            : `<span class="badge ${L.status === 'up' ? 'b-ok' : L.status === 'degraded' || L.status === 'starting' ? 'b-warn' : 'b-bad'}">${esc(L.status === 'up' ? 'up' : L.status === 'down' ? 'down' : L.status)}</span><span class="note">${esc(`read ${when(L.readAt)}`)}</span>`;
        const eq = !L || !L.network.peers ? '<span class="badge b-info">not known</span>'
            : L.network.heightsEqual === true ? `<span class="badge b-ok">equal</span><span class="note">height ${num(L.network.height)}</span>`
                : L.network.heightsEqual === false ? '<span class="badge b-bad">differ</span>' : '<span class="badge b-warn">not all answering</span>';
        const crit = s.criteria.error ? missingHTML({ why: s.criteria.error })
            : `${V(s.criteria.proven)}/${s.criteria.of} proven, ${V(s.criteria.measured)}/${s.criteria.ofMeasured} measured`;
        let blk;
        if (s.openBlockers && s.openBlockers.error) blk = missingHTML({ why: s.openBlockers.error });
        else if (isM(s.openBlockers)) blk = missingHTML(s.openBlockers);
        else blk = `<span class="badge ${s.openBlockers ? 'b-warn' : 'b-ok'}">${s.openBlockers} open</span>`;
        const shots = s.screenshots.error ? missingHTML({ why: s.screenshots.error })
            : `<span class="badge ${s.screenshots.present === s.screenshots.expected ? 'b-ok' : 'b-warn'}">${s.screenshots.present}/${s.screenshots.expected}</span>`;
        return `${chip('Network', netChip)}
${chip('Peer heights equal', eq)}
${chip('Criteria (evidence/SUMMARY.md)', crit)}
${chip('Blockers (docs/BLOCKERS.md)', blk)}
${chip('Screenshots present', shots)}
${chip('Next milestone', V(s.nextMilestone))}`;
    }

    function p0() {
        const miss = state.missing;
        const missList = miss.length ? `<details><summary>${miss.length} MISSING field${miss.length === 1 ? '' : 's'} across the page</summary>${table(['Field', 'Reason'], miss.map((x) => [`<code>${esc(x.path)}</code>`, esc(x.why)]))}</details>` : '<p class="dim">No MISSING fields.</p>';
        return panel(0, 'Status', 'overview', `<div class="chips" id="chips0">${chips0()}</div><h3>MISSING fields</h3>${missList}<p class="dim">This list covers the file-based panels. A live read that does not answer shows in amber on its own panel.</p>`);
    }

    function p1() {
        const e = state.environment;
        if (e.error) return panel(1, 'Environment', '5.2, Tables 5.1 and 5.2', errBox(e));
        const g = e.guest;
        const host = isM(e.host) ? missingHTML(e.host) : table(['Item', 'Value'], e.host.map((h) => [esc(h.item), esc(h.value)]));
        const guest = `<div class="kv">
<div>vCPU</div><div>${V(g.vcpu)}</div>
<div>Memory</div><div>${isM(g.memory) ? missingHTML(g.memory) : `${gib(g.memory.totalBytes)} total, ${gib(g.memory.usedBytes)} used, ${gib(g.memory.availableBytes)} available`}</div>
<div>Disk (/)</div><div>${isM(g.disk) ? missingHTML(g.disk) : `${gb(g.disk.sizeBytes)} size, ${gb(g.disk.usedBytes)} used, ${gb(g.disk.freeBytes)} free`}</div>
<div>OS</div><div>${V(g.os)}</div><div>Kernel</div><div>${V(g.kernel)}</div></div>`;
        const badge = { matches: 'b-ok', differs: 'b-warn', unpinned: 'b-info', 'not probed': 'b-info', unknown: 'b-bad' };
        const tools = isM(e.tools) ? missingHTML(e.tools) : table(['Component', 'Live', 'Locked (A.4)', 'Check'], e.tools.map((t) => [
            esc(t.component), V(t.live), esc(t.locked),
            `<span class="badge ${badge[t.status] || 'b-info'}">${esc(t.status)}</span>${t.deviation ? ` <span class="dim">see ${esc(t.deviation)}</span>` : ''}${t.note ? `<span class="note">${esc(t.note)}</span>` : ''}`,
        ]));
        return panel(1, 'Environment', '5.2, Tables 5.1 and 5.2', `
<h3>Host (static, from ${esc(e.hostSource)})</h3>${host}
<h3>Guest VM (live)</h3>${guest}
<h3>Software versions</h3><p class="dim">Expected values: ${esc(e.toolsSource)}. "differs" links the deviation that accounts for it.</p>${tools}`);
    }

    function p2() {
        const e = state.environment;
        if (e.error) return panel(2, 'Toolchain', '5.3.1, 5.3.2', errBox(e));
        const live = e.prereqs.live;
        const checks = isM(live.checks) ? missingHTML(live.checks)
            : `<p><span class="badge ${live.passed === live.total ? 'b-ok' : 'b-warn'}">${live.passed}/${live.total} pass</span> <span class="dim">live re-evaluation of the check lines in ${esc(live.source)}, using the script's own rule</span></p>${table(['Check', 'Expects', 'Got', ''], live.checks.map((c) => [esc(c.label), esc(c.want || '(any output)'), esc(c.got), c.pass ? '<span class="badge b-ok">OK</span>' : '<span class="badge b-bad">FAIL</span>']))}`;
        const bins = e.binaries.map((b) => `<div>${esc(b.name)}</div><div>${isM(b.output) ? missingHTML(b.output) : `<code>${esc(b.output.replace(/\s*\n\s*/g, '; '))}</code>`}</div>`).join('');
        const imgs = e.images;
        const expected = isM(imgs.expected) ? missingHTML(imgs.expected) : table(['Image (from docker-compose.yaml)', 'Present'], imgs.expected.map((i) => [esc(i.name), isM(i.present) ? missingHTML(i.present) : i.present ? '<span class="badge b-ok">yes</span>' : '<span class="badge b-bad">no</span>']));
        const all = isM(imgs.all) ? missingHTML(imgs.all) : `<details><summary>All ${imgs.all.length} local images</summary><pre>${esc(imgs.all.join('\n'))}</pre></details>`;
        const p0e = e.phase0Evidence;
        return panel(2, 'Toolchain', '5.3.1, 5.3.2', `
<h3>Prereqs, last stored run</h3><p>${V(e.prereqs.lastRun)}</p>
<h3>Prereqs, re-evaluated now</h3>${checks}
<h3>Fabric binaries</h3><div class="kv">${bins}</div>
<h3>Container images</h3>${expected}${all}
<h3>Phase 0 test-network evidence</h3><p><a href="/${esc(p0e.path)}">${esc(p0e.path)}</a>, modified ${V(p0e.modified, when)}</p>${isM(p0e.preview) ? missingHTML(p0e.preview) : `<pre>${esc(p0e.preview)}</pre>`}`);
    }

    function p5() {
        const d = state.deviations;
        if (d.error) return panel(5, 'Deviations', '5.3.5, Table 5.3', errBox(d));
        const devs = isM(d.deviations) ? missingHTML(d.deviations) : table(['ID', 'Deviation', 'Status', 'Consequence'], d.deviations.map((x) => [
            `<strong>${esc(x.id)}</strong>`, esc(x.title),
            isM(x.status) ? missingHTML(x.status) : `<span class="badge b-ok">${esc(x.status)}</span>${x.statusDate ? `<span class="note">${esc(x.statusDate)}</span>` : ''}`,
            V(x.consequence),
        ]));
        const blks = isM(d.blockers) ? missingHTML(d.blockers) : d.blockers.length
            ? table(['Blocker', 'State'], d.blockers.map((b) => [esc(b.title), b.resolved ? '<span class="badge b-ok">resolved</span>' : '<span class="badge b-warn">open</span>']))
            : '<p class="dim">No blockers recorded.</p>';
        return panel(5, 'Deviations', '5.3.5, Table 5.3', `${devs}<h3>Blockers</h3>${blks}<p class="dim">Sources: ${d.sources.map(esc).join(', ')}</p>`);
    }

    function p6() {
        const p = state.performance;
        if (p.error) return panel(6, 'Timing trials', '5.3.5, Figure 5.8', errBox(p));
        const [a, b] = p.timing.trials;
        const row = (label, fa, fb) => [esc(label), fa(a), fb ? fb(b) : fa(b)];
        const ms = (k) => (t) => V(t[k], msFmt);
        const rows = [
            row('Votes', (t) => V(t.count)),
            row('Mint phase total', ms('mintTotalMs')),
            row('Cast phase total', ms('castTotalMs')),
            row('Total', (t) => V(t.totalMs, dur)),
            row('Mean mint per vote (concurrent)', ms('meanMintMs')),
            row('Mean cast latency', ms('meanCastMs')),
            row('Total per vote', ms('perVoteTotalMs')),
            row('Invariant', (t) => inv(t.invariant)),
            row('BatchTimeout in decoded channel config', (t) => V(t.batchTimeoutDecoded)),
            row('Evidence', (t) => evLink(t.dir)),
        ];
        const red = p.timing.reduction;
        const proj = (t) => (t.projection ? t.projection : null);
        const projRows = [
            ['test3, 1,000 votes x3', (t) => V(proj(t) && proj(t).test3x3Ms, dur)],
            ['Sweep 100 to 10,000 (16,600 votes)', (t) => V(proj(t) && proj(t).sweepMs, dur)],
            ['Total', (t) => V(proj(t) && proj(t).totalMs, dur)],
        ].map(([l, f]) => [esc(l), f(a), f(b)]);
        return panel(6, 'Timing trials', '5.3.5, Figure 5.8', `
${table(['100-vote trial', esc(a.label), esc(b.label)], rows, [1, 2])}
<p>Reduction factor, 2 s to 500 ms: mean cast latency <strong>${V(red.meanCast, (x) => `${num(x, 2)}x`)}</strong>, total per vote <strong>${V(red.perVoteTotal, (x) => `${num(x, 2)}x`)}</strong> <span class="dim">(computed from the two result.json files)</span></p>
<h3>Projections (linear, from each trial's per-vote total)</h3>${table(['Workload', esc(a.label), esc(b.label)], projRows, [1, 2])}`);
    }

    function p7() {
        const t = state.tests;
        if (t.error) return panel(7, 'Tests', '5.4, Table 5.4, 5.4.3 to 5.4.10', errBox(t));
        const cards = t.cards.map((c) => {
            const n = c.newest;
            if (isM(n)) return `<div class="subcard" id="test-${esc(c.id)}"><h3>Test ${esc(c.id)}: ${esc(c.name)}</h3>${missingHTML(n)}</div>`;
            const notes = n.notes || {};
            const r = c.runs;
            const reg = c.regression;
            const regLine = reg ? `${passBadge(reg.pass)} ${isM(reg.observed) || isM(n.observed) ? '' : reg.observed === n.observed ? '<span class="dim">same observed result</span>' : '<span class="badge b-warn">observed result differs</span>'}` : '<span class="dim">no regression run</span>';
            const archived = [...r.invalid.dirs.map((x) => ['invalid', x]), ...r.superseded.dirs.map((x) => ['superseded', x])]
                .map(([k, x]) => `<li>${esc(k)}: ${evLink(x.dir, x.dir.split('/').pop())}<span class="note">${V(x.reason)}</span></li>`).join('');
            return `<div class="subcard" id="test-${esc(c.id)}"><h3><span>Test ${esc(c.id)}: ${esc(c.name)}</span>${passBadge(n.pass)}</h3><dl>
<dt>Scenario</dt><dd>${esc(c.scenario)}</dd>
<dt>Expected</dt><dd>${esc(c.expected)}</dd>
<dt>Observed</dt><dd><strong>${VM(n.observed, notes.observed)}</strong></dd>
<dt>Block</dt><dd>${VM(n.block, notes.block)}</dd>
<dt>Before</dt><dd>${VM(n.before, notes.before)}</dd>
<dt>After</dt><dd>${VM(n.after, notes.after)}</dd>
<dt>Runs</dt><dd>valid ${r.valid.count} (${r.valid.passed} pass), regression ${r.regression.count} (${r.regression.passed} pass), invalid ${r.invalid.count}, superseded ${r.superseded.count}</dd>
<dt>Regression</dt><dd>${regLine}</dd>
<dt>Evidence</dt><dd>${evLink(n.dir, 'newest valid run')}, ${evLink(c.evidenceDir, 'all runs')}</dd>
</dl>${archived ? `<details><summary>Archived runs</summary><ul>${archived}</ul></details>` : ''}</div>`;
        }).join('');
        return panel(7, 'Tests', '5.4, Table 5.4, 5.4.3 to 5.4.10', `<p class="dim">Each card reads the newest valid run's result.json. A field the test does not write shows MISSING; a grey note explains absences that follow from the test's design.</p><div class="cards">${cards}</div>`);
    }

    function p8() {
        const c = state.criteria;
        if (c.error) return panel(8, 'Criteria', '5.5.1, Table 5.5', errBox(c));
        if (isM(c.criteria)) return panel(8, 'Criteria', '5.5.1, Table 5.5', missingHTML(c.criteria));
        const rows = c.criteria.map((x) => {
            const runs = (x.runs || []).map((t) => `${esc(t.test)}: ${t.runs.map((r) => (isM(r.result) ? missingHTML(r.result) : `<span class="badge ${r.result === 'PASS' ? 'b-ok' : 'b-bad'}" title="${esc(r.run)}">${esc(r.result)}</span>`)).join(' ')}`).join('<br>');
            const tests = (x.tests || []).map((id) => `<a href="#test-${esc(id)}">${esc(id)}</a>`).join(' + ');
            const kind = x.number <= 7 ? 'proven' : 'measured';
            return [esc(x.number), esc(x.description || ''), tests || '<span class="dim">test7</span>',
                isM(x.result) ? missingHTML(x.result) : `<span class="badge ${x.result === 'PASS' ? 'b-ok' : 'b-bad'}">${esc(x.result)}</span> <span class="dim">${kind}</span>`,
                runs || esc(x.detail || '')];
        });
        return panel(8, 'Criteria', '5.5.1, Table 5.5', `${table(['#', 'Criterion', 'Tests', 'Result', 'Per run'], rows)}<p class="dim">Source: ${esc(c.source)}, generated ${V(c.generated, when)}</p>`);
    }

    function p9() {
        const p = state.performance;
        if (p.error) return panel(9, 'Performance', '5.5.2, Table 5.6', errBox(p));
        // Rounded for reading; the exact result.json value is in the tooltip.
        const X = (v, fmt) => (isM(v) ? missingHTML(v) : `<span title="exact: ${esc(v)}">${esc(fmt(v))}</span>`);
        const rows = p.sweep.map((r) => (r.error ? [num(r.scale), missingHTML(r.error), '', '', '', '', '', ''] : [
            num(r.scale), X(r.latencyMeanMs, (x) => num(x, 1)), X(r.latencyMedianMs, num), X(r.latencyP95Ms, num),
            X(r.throughputBallotsPerSec, (x) => num(x, 3)), X(r.throughputTxPerSec, (x) => num(x, 3)),
            isM(r.invariant) ? missingHTML(r.invariant) : `${r.invariantOK === true ? '<span class="badge b-ok">equal</span>' : '<span class="badge b-bad">not equal</span>'} <span class="dim">${r.invariant.burnedCount} = ${r.invariant.tallyTotal}</span>`,
            evLink(r.dir, 'files'),
        ]));
        const ch = p.change;
        const cc = (k) => (isM(ch[k]) ? missingHTML(ch[k]) : `<strong>${pct(ch[k].percent)}</strong>`);
        rows.push([`<strong>Change ${num(ch.from)} to ${num(ch.to)}</strong>`, cc('latencyMeanMs'), cc('latencyMedianMs'), cc('latencyP95Ms'),
            cc('throughputBallotsPerSec'), cc('throughputTxPerSec'), '<span class="dim">computed from the result.json files</span>', '']);
        const ok = p.sweep.filter((r) => !r.error);
        const pts = (k) => ok.map((r) => ({ x: r.scale, y: isM(r[k]) ? NaN : r[k] }));
        const xs = ok.map((r) => r.scale);
        const charts = xs.length ? `<div class="charts">
${chart({ title: 'Cast latency (ms) against scale', xs, xLog: true, xFmt: num, yFmt: (y) => num(y), series: [{ name: 'mean', points: pts('latencyMeanMs') }, { name: 'median', points: pts('latencyMedianMs') }, { name: 'p95', points: pts('latencyP95Ms') }] })}
${chart({ title: 'Throughput against scale', xs, xLog: true, xFmt: num, yFmt: (y) => num(y, 2), series: [{ name: 'ballots/s', points: pts('throughputBallotsPerSec') }, { name: 'tx/s (2 per ballot)', points: pts('throughputTxPerSec') }] })}
</div>` : '';
        return panel(9, 'Performance', '5.5.2, Table 5.6', `${table(['Scale', 'Mean (ms)', 'Median (ms)', 'p95 (ms)', 'Ballots/s', 'Tx/s', 'Invariant', 'Evidence'], rows, [0, 1, 2, 3, 4, 5])}
<p class="dim">Latency is per sequential CastBallot; mints run concurrently (DEV-005). Tx/s counts the MintVAT and the CastBallot of each ballot. x axis is logarithmic.</p>${charts}`);
    }

    function p10() {
        const p = state.performance;
        if (p.error) return panel(10, 'Contention probe', '5.5.3', errBox(p));
        const q = p.probe;
        if (q.error) return panel(10, 'Contention probe', '5.5.3', missingHTML(q.error));
        const of = (v) => (isM(v) || isM(q.scale) ? V(v) : `${num(v)} of ${num(q.scale)}`);
        const earlier = q.earlierRuns.map((r) => `<li>${evLink(r.dir, r.dir.split('/').pop())} ${passBadge(r.pass)}</li>`).join('');
        return panel(10, 'Contention probe', '5.5.3', `<div class="kv">
<div>Scale, window, max retries</div><div>${V(q.scale)} ballots, ${V(q.windowSize)} in flight, ${V(q.maxRetries)} retries</div>
<div>First-attempt commits</div><div>${of(q.firstAttemptCommitted)}</div>
<div>First-attempt MVCC conflicts</div><div>${of(q.firstAttemptMvccConflicts)}</div>
<div>Other first-attempt failures</div><div>${V(q.firstAttemptOtherFail)}</div>
<div>Conflict rate</div><div><strong>${V(q.mvccConflictRate, (x) => `${num(x * 100, 1)} %`)}</strong></div>
<div>Retries</div><div>${V(q.totalRetries, num)}</div>
<div>Final committed</div><div>${of(q.finalCommitted)}</div>
<div>Invariant</div><div>${inv(q.invariant)} ${q.invariantOK === true ? '<span class="badge b-ok">equal</span>' : V(q.invariantOK)}</div>
<div>Result</div><div>${passBadge(q.pass)}</div>
<div>Evidence</div><div>${evLink(q.dir)} <span class="dim">(newest of ${q.runCount} runs)</span></div></div>
${earlier ? `<details><summary>Earlier runs</summary><ul>${earlier}</ul><p class="dim">See docs/BLOCKERS.md: the earlier run's FAIL came from a pass criterion later corrected, not from the system.</p></details>` : ''}`);
    }

    function p11() {
        const p = state.performance;
        if (p.error) return panel(11, 'Resources', '5.5.4', errBox(p));
        const blocks = p.resources.map((r) => {
            if (r.error) return `<details><summary>Scale ${num(r.scale)}</summary>${missingHTML(r.error)}</details>`;
            const ds = r.dockerStats;
            const b = r.couchBefore; const a = r.couchAfter;
            const delta = (k) => (isM(a[k]) || isM(b[k]) ? '' : ` <span class="dim">(${a[k] - b[k] >= 0 ? '+' : ''}${k === 'docCount' ? num(a[k] - b[k]) : mib(a[k] - b[k])})</span>`);
            const couch = isM(b) || isM(a) ? `${V(b)} ${V(a)}` : table(['CouchDB votingchannel_voting', 'Before', 'After'], [
                ['File size', V(b.fileBytes, mib), V(a.fileBytes, mib) + delta('fileBytes')],
                ['Active size', V(b.activeBytes, mib), V(a.activeBytes, mib) + delta('activeBytes')],
                ['Documents', V(b.docCount, num), V(a.docCount, num) + delta('docCount')],
            ], [1, 2]);
            const stats = isM(ds) ? missingHTML(ds) : `<p class="dim">${ds.containers.length} containers, sampled every 5 s from ${when(ds.firstSample)} to ${when(ds.lastSample)}${ds.unparsedRows ? `, ${ds.unparsedRows} rows unparsed` : ''}. ${evLink(r.dir, 'files')}</p>${table(['Container', 'Samples', 'CPU min %', 'CPU max %', 'Mem min MiB', 'Mem max MiB'],
                ds.containers.map((c) => [esc(c.name), num(c.samples), num(c.cpuMin, 2), num(c.cpuMax, 2), num(c.memMinMiB, 1), num(c.memMaxMiB, 1)]), [1, 2, 3, 4, 5])}`;
            return `<details${r.scale === 10000 ? ' open' : ''}><summary>Scale ${num(r.scale)}</summary>${couch}${stats}</details>`;
        }).join('');
        return panel(11, 'Resources', '5.5.4', blocks);
    }

    function p12() {
        const p = state.performance;
        if (p.error) return panel(12, 'Recovery', '5.4.5, 5.5.5', errBox(p));
        const runs = p.recovery.runs;
        const cat = { valid: 'b-ok', regression: 'b-info', invalid: 'b-warn', superseded: 'b-info' };
        const rows = runs.map((r) => [
            `<span class="badge ${cat[r.category]}">${esc(r.category)}</span><span class="note">${evLink(r.dir, r.dir.split('/').pop())}</span>`,
            `${V(r.chainHeight, num)}${r.heightSource ? `<span class="note">${esc(r.heightSource)}</span>` : ''}`,
            V(r.replayedBlocks, num), V(r.replayStart, when), V(r.replayEnd, when),
            `<strong>${V(r.replayDurationMs, dur)}</strong>`, r.msPerBlock ? num(r.msPerBlock, 1) : '<span class="dim">none</span>',
            isM(r.outcome) ? missingHTML(r.outcome) : esc(r.outcome),
        ]);
        const timed = runs.filter((r) => typeof r.replayDurationMs === 'number' && typeof r.chainHeight === 'number');
        const sc = timed.length ? chart({ title: 'Replay duration (s) against chain height', xs: timed.map((r) => r.chainHeight), xLog: false, lines: false, xFmt: num, yFmt: (y) => num(y), series: [{ name: 'timed runs', points: timed.map((r) => ({ x: r.chainHeight, y: r.replayDurationMs / 1000 })) }] }) : '';
        return panel(12, 'Recovery', '5.4.5, 5.5.5', `<p class="dim">Duration is the Media peer's own replay window after rebuild-dbs: from its "Recommitting lost blocks" log line to "Recommitted lost blocks", read from each run's peer-logs.txt (rebuild-dbs-output.txt is empty in every run). All Test 2 runs are listed, archived ones included.</p>
${table(['Run', 'Chain height', 'Blocks replayed', 'Replay start', 'Replay end', 'Duration', 'ms per block', 'Outcome'], rows, [1, 2, 5, 6])}
${sc ? `<div class="charts">${sc}</div>` : ''}`);
    }

    function p13() {
        const s = state.screenshots;
        if (s.error) return panel(13, 'Figures and tables', 'all of Chapter 5', errBox(s));
        if (isM(s.figures)) return panel(13, 'Figures and tables', 'all of Chapter 5', missingHTML(s.figures));
        const rows = s.figures.map((f) => [
            `<strong>${esc(f.item)}</strong>`, esc(f.content), `<code>${esc(f.source)}</code>`,
            f.screenshot ? `${V(f.screenshotTaken, (d) => `taken ${when(d)}`)}<span class="note">${esc(f.screenshot)}</span>` : '<span class="dim">no screenshot (table)</span>',
            f.sourceUpdated === null ? '<span class="dim">live or static</span>' : V(f.sourceUpdated, when),
        ]);
        const other = s.otherFiles.length ? `<p class="dim">Other files in ${esc(s.directory)}/: ${s.otherFiles.map((n) => `<a href="/${esc(s.directory)}/${encodeURIComponent(n)}">${esc(n)}</a>`).join(', ')}</p>` : '';
        return panel(13, 'Figures and tables', 'all of Chapter 5', `<p>Screenshots present: <span class="badge ${s.present === s.expected ? 'b-ok' : 'b-warn'}">${s.present}/${s.expected}</span> <span class="dim">expected in ${esc(s.directory)}/ as fig5-01.png to fig5-21.png</span></p>
${table(['Item', 'Content', 'Source', 'Screenshot', 'Source last updated'], rows)}${other}<p class="dim">The map is dashboard/data/figures.json.</p>`);
    }

    function p15() {
        const b = state.build;
        if (b.error) return panel(15, 'Repo', 'n/a', errBox(b));
        const notes = state.data.notes;
        const pushNote = isM(notes) ? missingHTML(notes) : notes['15'] ? esc(notes['15']) : '<span class="dim">not recorded; add it to this panel\'s notes</span>';
        const cur = isM(b.current) ? missingHTML(b.current) : `<code>${esc(b.current.hash)}</code> on ${V(b.current.branch)}, ${esc(when(b.current.date))}: ${esc(b.current.subject)}`;
        const unc = isM(b.uncommitted) ? missingHTML(b.uncommitted) : `<span class="badge ${b.uncommitted.count ? 'b-warn' : 'b-ok'}">${b.uncommitted.count}</span>${b.uncommitted.count ? `<details><summary>Files</summary><pre>${esc(b.uncommitted.files.join('\n'))}</pre></details>` : ''}`;
        const commits = isM(b.commits) ? missingHTML(b.commits) : table(['Commit', 'Date', 'Subject'], b.commits.map((c) => [`<code>${esc(c.hash)}</code>`, esc(c.date), esc(c.subject)]));
        const phases = isM(b.phases) ? missingHTML(b.phases) : table(['Phase', 'Entries', 'From', 'To', 'Exit gate row', 'Latest entry'], b.phases.map((p) => [
            esc(p.id), num(p.entries), esc(p.firstDate), esc(p.lastDate),
            p.exitGatePassed ? '<span class="badge b-ok">EXIT GATE PASSED</span>' : '<span class="dim">none</span>',
            `<span class="dim">${esc(p.lastTask.length > 140 ? `${p.lastTask.slice(0, 140)}…` : p.lastTask)}</span>`,
        ]), [1]);
        return panel(15, 'Repo', 'n/a', `<div class="kv"><div>Current commit</div><div>${cur}</div><div>Uncommitted changes</div><div>${unc}</div><div>Last backup or push</div><div>${pushNote}</div></div>
<h3>Last ${isM(b.commits) ? '' : b.commits.length} commits</h3>${commits}
<h3>Build progress (${esc(b.progressSource)})</h3>${phases}`);
    }

    // ── Live panels (D2): 3 network, 4 chaincode, 14 demo ───────────────────

    const GROUPS = ['IEBC', 'Judiciary', 'Civil Society', 'Media', 'Orderer', 'Tools'];
    const banner = (cls, title, text) => `<div class="banner ${cls}"><strong>${esc(title)}</strong>${text ? esc(text) : ''}</div>`;
    const stateBadge = (st) => `<span class="badge ${st === 'running' ? 'b-ok' : st === 'exited' || st === 'absent' ? 'b-bad' : 'b-warn'}">${esc(st)}</span>`;

    function netBanner() {
        const L = liveState;
        if (!L) return banner('wait', liveFailedAt ? 'The dashboard server did not answer' : 'Reading the network…', liveFailedAt ? 'It will try again shortly.' : '');
        const last = L.lastReading;
        const lastText = last ? `last reading at ${when(last.at)}` : 'no earlier reading on record';
        let b;
        if (L.status === 'up') {
            b = banner('up', 'Network up', `${L.network.runningCount} of ${L.network.expected} services running and answering. Read ${when(L.readAt)}.`);
        } else if (L.status === 'degraded' || L.status === 'starting') {
            b = banner('partial', L.status === 'starting' ? 'Network starting' : 'Network partly up', `${L.summary} ${L.network.runningCount} of ${L.network.expected} services running. Read ${when(L.readAt)}.`);
        } else if (L.status === 'down') {
            b = banner('down', `Network down, ${lastText}`, 'No network service is running. Use Start network below to bring it back.');
        } else {
            b = banner('down', `Network not answering, ${lastText}`, L.summary);
        }
        return liveFailedAt ? `${banner('wait', 'The dashboard server did not answer just now', `Showing the reading from ${when(L.readAt)}.`)}${b}` : b;
    }

    function servicesTable(n) {
        if (!n.services || !n.services.length) return '';
        const rows = [];
        for (const g of GROUPS) {
            const list = n.services.filter((x) => x.group === g);
            if (!list.length) continue;
            rows.push(`<tr class="group-row"><th colspan="4">${esc(g)}</th></tr>`);
            for (const x of list) rows.push(`<tr><td>${esc(x.name)}</td><td>${esc(x.role)}</td><td>${stateBadge(x.state)}</td><td class="dim">${esc(x.status)}</td></tr>`);
        }
        return `<h3>${n.services.length} services (docker-compose.yaml): ${n.runningCount} running</h3><div class="scroll"><table><thead><tr><th>Service</th><th>Role</th><th>State</th><th>Status</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
    }

    function liveTables(n) {
        if (!n.peers) return '<p class="dim">Peers, CouchDB and orderers cannot answer while their services are not running.</p>';
        const leader = n.raftLeader && n.raftLeader.leader;
        const peerRows = n.peers.map((p, i) => [esc(p.org), `<code>${esc(p.peer)}</code>`, `<strong>${V(p.height, num)}</strong>`,
            n.couch && n.couch[i] ? (n.couch[i].up === true ? '<span class="badge b-ok">up</span>' : V(n.couch[i].up)) : '']);
        const eqLine = n.heightsEqual === true ? `<span class="badge b-ok">all four peer heights equal</span> <span class="dim">${num(n.height)} blocks</span>`
            : n.heightsEqual === false ? '<span class="badge b-bad">peer heights differ</span>' : '<span class="badge b-warn">not every peer answered</span>';
        const ordRows = (n.orderers || []).map((o) => [`<code>${esc(o.name)}</code>`,
            isU(o.channel) ? unavailHTML(o.channel) : `${esc(o.channel.status)} <span class="dim">(${esc(o.channel.consensusRelation)})</span>`,
            isU(o.channel) ? '' : num(o.channel.height),
            leader === o.short ? '<span class="badge b-ok">Raft leader</span>' : (leader ? '<span class="dim">follower</span>' : '')]);
        const rl = n.raftLeader;
        const leaderLine = !rl ? '' : rl.pending ? `<span class="dim">${esc(rl.note)}</span>`
            : isU(rl) ? unavailHTML(rl)
                : `<strong>${esc(rl.leader)}</strong>, term ${num(rl.term)}; ${rl.agreement ? 'all running orderers agree' : '<span class="unavail">the orderers do not all agree</span>'} <span class="dim">(from ${esc(rl.source)}, read ${esc(when(rl.readAt))})</span>`;
        const bt = n.batchTimeout;
        const btLine = !bt ? '' : bt.pending ? `<span class="dim">${esc(bt.note)}</span>`
            : isU(bt) ? unavailHTML(bt)
                : `<strong>${esc(bt.batchTimeout)}</strong> with MaxMessageCount ${num(bt.maxMessageCount)} <span class="dim">(${esc(bt.source)}, read ${esc(when(bt.readAt))}; not taken from configtx.yaml)</span>`;
        return `<h3>Peers and CouchDB</h3><p>${eqLine}</p>${table(['Organisation', 'Peer', 'Ledger height', 'CouchDB'], peerRows, [2])}
<h3>Orderers</h3>${table(['Orderer', 'Channel votingchannel', 'Height', 'Raft'], ordRows, [2])}
<div class="kv" style="margin-top:8px"><div>Raft leader</div><div>${leaderLine}</div><div>Effective BatchTimeout</div><div>${btLine}</div></div>`;
    }

    function lastKnown(L) {
        const last = L && L.lastReading;
        if (!last || L.status === 'up') return '';
        const n = last.network;
        const lines = n.peers.map((p) => `${esc(p.org)} ${V(p.height, num)}`).join(', ');
        return `<details><summary>Last known values (read ${esc(when(last.at))})</summary><p>Peer heights: ${lines}. Raft leader: ${n.raftLeader && n.raftLeader.leader ? esc(n.raftLeader.leader) : 'not recorded'}. BatchTimeout: ${n.batchTimeout && n.batchTimeout.batchTimeout ? esc(n.batchTimeout.batchTimeout) : 'not recorded'}.</p></details>`;
    }

    function netBody() {
        const L = liveState;
        if (!L) return netBanner();
        return `${netBanner()}${servicesTable(L.network)}${liveTables(L.network)}${lastKnown(L)}`;
    }

    function p3() {
        return panel(3, 'Network (live)', '5.3.3', `<div id="net-body">${netBody()}</div><p class="dim">Starting, stopping and running the bring-up scripts now lives in <a href="#network">Network control</a>.</p>`);
    }

    function ccDefinition(L) {
        const d = L && L.chaincode.definition;
        if (!d) return '<span class="dim">reading…</span>';
        if (d.pending) return `<span class="dim">${esc(d.note)}</span>`;
        if (isU(d)) return unavailHTML(d);
        const cols = d.collections.length ? table(['Collection', 'Member organisations', 'Peers (required / max)', 'Member-only read / write', 'Collection endorsement policy'],
            d.collections.map((c) => [`<strong>${esc(c.name)}</strong>`, `<code>${esc(c.memberOrgs)}</code>`, `${num(c.requiredPeerCount)} / ${num(c.maximumPeerCount)}`, `${c.memberOnlyRead} / ${c.memberOnlyWrite}`, c.endorsementPolicy ? `<code>${esc(c.endorsementPolicy)}</code>` : '<span class="dim">none</span>'])) : '<p class="dim">No private data collections are committed.</p>';
        const appr = Object.entries(d.approvals || {}).map(([k, v]) => `${esc(k)} ${v ? '<span class="badge b-ok">approved</span>' : '<span class="badge b-bad">not approved</span>'}`).join(' ');
        return `<div class="kv"><div>Chaincode</div><div><strong>${esc(d.name)}</strong> version <strong>${esc(d.version)}</strong>, sequence <strong>${num(d.sequence)}</strong></div>
<div>Endorsement policy</div><div><code>${esc(d.endorsementPolicy)}</code></div>
<div>Plugins</div><div>${esc(d.endorsementPlugin)} / ${esc(d.validationPlugin)}</div>
<div>Approvals</div><div>${appr}</div></div><h3>Private data</h3>${cols}<p class="dim">Read from the committed definition (_lifecycle query)${d.readAt ? `, ${esc(when(d.readAt))}` : ''}; the policy text is decoded from the committed bytes.</p>`;
    }

    function ccContainers(L) {
        const c = L && L.chaincode.containers;
        if (!c) return '';
        if (!c.length) return '<p class="dim">No chaincode containers exist (the peers start them when the network comes up).</p>';
        return table(['Chaincode container', 'State', 'Status'], c.map((x) => [`<code>${esc(x.name)}</code>`, stateBadge(x.state), `<span class="dim">${esc(x.status)}</span>`]));
    }

    function ccAudit(L) {
        const a = L && L.chaincode.audit;
        if (!a) return '<p class="dim">Choose an election ID to read its audit invariant and tally. These are read-only queries (GetAuditInvariant, GetTally).</p>';
        const inv = a.invariant;
        const invHtml = isU(inv) ? unavailHTML(inv)
            : `${a.equal ? '<span class="badge b-ok">equal</span>' : '<span class="badge b-bad">not equal</span>'} burnedCount <strong>${num(inv.burnedCount)}</strong>, tallyTotal <strong>${num(inv.tallyTotal)}</strong>`;
        const tally = isU(a.tally) ? unavailHTML(a.tally)
            : (Object.keys(a.tally).length ? table(['Candidate', 'Votes'], Object.entries(a.tally).map(([k, v]) => [esc(k), num(v)]), [1]) : '<span class="dim">no votes recorded for this election</span>');
        return `<div class="kv"><div>Election</div><div><code>${esc(a.electionID)}</code></div><div>Invariant</div><div>${invHtml}</div></div><h3>Tally</h3>${tally}<p class="dim">Queried ${esc(when(a.queriedAt || ''))}.</p>`;
    }

    function ccSuggestions(L) {
        const e = (L && L.chaincode.elections) || [];
        return e.map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('');
    }

    function p4() {
        return panel(4, 'Chaincode', '5.3.4', `<div id="cc-def">${ccDefinition(liveState)}</div>
<h3>Chaincode containers</h3><div id="cc-containers">${ccContainers(liveState)}</div>
<h3>Audit invariant for an election</h3>
<form id="cc-form"><input type="text" id="cc-election" list="cc-elections" placeholder="election ID" autocomplete="off" value="${esc(electionID)}" aria-label="Election ID"> <datalist id="cc-elections">${ccSuggestions(liveState)}</datalist>
<button type="submit" class="primary">Query</button> <span class="dim">suggestions come from the evidence files</span></form>
<div id="cc-audit">${ccAudit(liveState)}</div>`);
    }

    const PANELS = [[0, 'Status', p0], [1, 'Environment', p1], [2, 'Toolchain', p2], [3, 'Network', p3], [4, 'Chaincode', p4],
        [5, 'Deviations', p5], [6, 'Timing', p6], [7, 'Tests', p7], [8, 'Criteria', p8], [9, 'Performance', p9], [10, 'Probe', p10],
        [11, 'Resources', p11], [12, 'Recovery', p12], [13, 'Figures', p13], [15, 'Repo', p15]];

    const $ = (id) => rootEl.querySelector('#' + id);
    const setHTML = (id, html) => { const el = $(id); if (el && el.innerHTML !== html) el.innerHTML = html; };

    // Refreshes only the live containers, so notes and the election box keep
    // whatever the person is typing.
    function updateLivePanels() {
        if (!state) return;
        setHTML('chips0', chips0());
        setHTML('net-body', netBody());
        setHTML('cc-def', ccDefinition(liveState));
        setHTML('cc-containers', ccContainers(liveState));
        setHTML('cc-audit', ccAudit(liveState));
        setHTML('cc-elections', ccSuggestions(liveState));
        const ex = $('exportnote');
        if (ex && liveState) ex.textContent = '';
    }

    function render() {
        $('nav').innerHTML = PANELS.map(([n, t]) => `<a href="#records/p${n}" data-scrollto="p${n}">${n} ${esc(t)}</a>`).join('');
        $('app').innerHTML = PANELS.map(([n, , fn]) => {
            try {
                return fn();
            } catch (e) {
                return panel(n, `Panel ${n}`, 'render error', missingHTML({ why: `render failed: ${e.message}` }));
            }
        }).join('');
        $('meta').textContent = `Files collected ${when(state.generatedAt)}`;
    }

    // ── Loading ──────────────────────────────────────────────────────────

    const livePending = () => !!liveState && (
        (liveState.network.raftLeader && liveState.network.raftLeader.pending)
        || (liveState.network.batchTimeout && liveState.network.batchTimeout.pending)
        || (liveState.chaincode.definition && liveState.chaincode.definition.pending));

    let alive = true;
    function scheduleLive() {
        clearTimeout(liveTimer);
        if (!alive) return;
        const busy = livePending() || !liveState || liveFailedAt || (liveState && liveState.status !== 'up');
        liveTimer = setTimeout(loadLive, busy ? 5000 : 20000);
    }

    async function loadLive() {
        if (!alive) return;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 9000);
        try {
            const res = await fetch(`/api/live${electionID ? `?election=${encodeURIComponent(electionID)}` : ''}`, { signal: ctl.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            liveState = await res.json();
            liveFailedAt = null;
        } catch {
            liveFailedAt = new Date().toISOString();
        } finally {
            clearTimeout(timer);
        }
        if (!alive) return;
        updateLivePanels();
        scheduleLive();
    }

    async function load() {
        const loading = $('loading');
        loading.style.display = '';
        loading.textContent = 'Collecting state from the evidence files…';
        try {
            const res = await fetch('/api/state');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            state = await res.json();
            loading.style.display = 'none';
            if (!alive) return;
            render();
        } catch (e) {
            loading.textContent = `Could not load /api/state: ${e.message}`;
            return;
        }
        loadLive();
    }

    const onClick = async (ev) => {
        const t = ev.target;
        if (!t.getAttribute) return undefined;
        const n = t.getAttribute('data-save-note');
        if (n === null || n === undefined) return undefined;
        const status = rootEl.querySelector(`[data-note-status="${n}"]`);
        const notes = { ...(isM(state.data.notes) ? {} : state.data.notes) };
        const text = rootEl.querySelector(`[data-note="${n}"]`).value.trim();
        if (text) notes[n] = text; else delete notes[n];
        try {
            const res = await fetch('/api/data/notes.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(notes) });
            if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
            state.data.notes = notes;
            status.textContent = 'Saved.';
        } catch (e) {
            status.textContent = `Not saved: ${e.message}`;
        }
        return undefined;
    };

    const onSubmit = (ev) => {
        if (ev.target.id !== 'cc-form') return;
        ev.preventDefault();
        electionID = $('cc-election').value.trim();
        setHTML('cc-audit', '<span class="dim">querying…</span>');
        loadLive();
    };
    rootEl.addEventListener('click', onClick);
    rootEl.addEventListener('submit', onSubmit);

    $('export').addEventListener('click', async () => {
        const note = $('exportnote');
        note.textContent = 'Writing…';
        try {
            const res = await fetch('/api/export/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const r = await res.json();
            note.innerHTML = `Written ${esc(when(r.writtenAt))}: <a href="/out/status-report.md" target="_blank" rel="noopener">${esc(r.path)}</a> (${num(r.lines)} lines)`;
        } catch {
            note.textContent = 'The report could not be written.';
        }
    });
    $('refresh').addEventListener('click', load);
    load();
    return () => { alive = false; clearTimeout(liveTimer); };
};
