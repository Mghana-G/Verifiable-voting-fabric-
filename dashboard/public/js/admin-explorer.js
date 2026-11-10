'use strict';

// Ledger explorer: newest blocks first, 20 per page, jump to block, election
// filter, live tail over SSE. Blocks are read through qscc as the auditor.
(() => {
    const { esc, $, api, hash, num, loading, errorBox, empty, drawer } = VN;

    function txHTML(t) {
        const bad = t.validationCode !== 0;
        const both = t.function === 'CastBallot' && t.args[0] && t.args[1] ? ' <span class="badge b-info" title="This link is public on the channel by design; see HOW_IT_WORKS 5.3">&#9432; vatID + candidateID public</span>' : '';
        const args = (t.args || []).map((a, i) => (a.length > 70 ? `<div class="small"><span class="dim">arg ${i}</span> <code title="${esc(a)}">${esc(a.slice(0, 60))}…</code></div>` : `<div class="small"><span class="dim">arg ${i}</span> <code>${esc(a)}</code></div>`)).join('');
        return `<div class="txrow ${bad ? 'invalid' : ''}">
          <div>${hash(t.txID)} <strong>${esc(t.function || t.typeName)}</strong> <span class="badge ${bad ? 'b-bad' : 'b-ok'}">${esc(t.validationName)}</span>${both}</div>
          <div class="small dim">creator ${esc(t.creatorMsp || 'n/a')} · endorsed by ${(t.endorsers || []).map((m) => esc(String(m).replace(/^Org|MSP$/g, ''))).join(', ') || 'n/a'}${t.electionID ? ` · election <code>${esc(t.electionID)}</code>` : ''}</div>
          ${args ? `<details><summary class="small">Arguments (${t.args.length})</summary>${args}</details>` : ''}
          ${t.writes && t.writes.length ? `<details><summary class="small">Public write set (${t.writes.length})</summary>${t.writes.map((w) => `<div class="small"><code>${esc(w.key)}</code> = <code>${esc(w.value)}</code></div>`).join('')}</details>` : ''}
          ${t.hashedWrites && t.hashedWrites.length ? `<details><summary class="small">Private collection writes: hashed only</summary>${t.hashedWrites.map((c) => `<div class="small"><strong>${esc(c.collection)}</strong> (hashed only)${c.writes.map((w) => `<div>key hash ${hash(w.keyHash)} value hash ${hash(w.valueHash)}</div>`).join('')}</div>`).join('')}</details>` : ''}
        </div>`;
    }

    function blockRow(b, fresh) {
        const t = b.time ? VN.when(b.time) : 'n/a';
        return `<tr class="blkrow ${fresh ? 'newblk' : ''}" data-n="${b.number}"><td class="num"><strong>${num(b.number)}</strong></td><td>${esc(t)}</td><td class="num">${b.txCount}</td><td>${hash(b.dataHash)}</td><td>${hash(b.previousHash)}</td><td class="small">${b.transactions.map((x) => esc(x.function || x.typeName)).join(', ')}</td></tr>`;
    }

    VN.views.explorer = async (el) => {
        let before; let filter = false; let es = null; let live = false;
        el.innerHTML = `<h2>Ledger explorer</h2>
          <div class="card" style="margin-bottom:12px"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end">
            <div><label for="jump">Jump to block</label><input type="number" id="jump" min="0" style="width:120px"> <button id="jgo">Go</button></div>
            <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" id="fel"> This election only</label>
            <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" id="tail"> Live tail</label>
            <span class="small dim" id="hint"></span></div></div>
          <div class="card"><div class="scroll"><table><thead><tr><th class="num">Block</th><th>Time</th><th class="num">Tx</th><th>Data hash</th><th>Previous hash</th><th>Functions</th></tr></thead><tbody id="rows"></tbody></table></div>
          <div id="pg" style="margin-top:8px"></div>${drawer('tx')}</div><div id="detail" class="card" style="margin-top:12px" hidden></div>`;
        const rows = $('#rows');
        async function loadPage(append) {
            if (!append) { rows.innerHTML = `<tr><td colspan="6">${loading('Reading blocks…')}</td></tr>`; }
            const q = new URLSearchParams();
            if (before !== undefined) q.set('before', before);
            if (filter) q.set('election', '1');
            const r = await api(`/api/admin/blocks?${q}`);
            if (!$('#rows')) return;
            if (!r.ok) { rows.innerHTML = `<tr><td colspan="6">${errorBox(r.data.error || 'The ledger could not be read.')}</td></tr>`; return; }
            if (!append) rows.innerHTML = '';
            if (!r.data.blocks.length) rows.innerHTML += `<tr><td colspan="6">${empty(filter ? 'No block of this election in the blocks searched.' : 'No blocks.')}</td></tr>`;
            rows.insertAdjacentHTML('beforeend', r.data.blocks.map((b) => blockRow(b)).join(''));
            before = r.data.next;
            $('#hint').textContent = `Chain height ${num(r.data.height)}${r.data.scanCapped ? '. The election filter searched 400 blocks; load more to continue.' : ''}`;
            $('#pg').innerHTML = before !== null && before >= 0 ? '<button id="more">Older blocks</button>' : '<span class="dim small">Start of the chain reached.</span>';
            if ($('#more')) $('#more').onclick = () => loadPage(true);
        }
        async function open(n) {
            const d = $('#detail');
            d.hidden = false; d.innerHTML = loading(`Reading block ${n}…`);
            const r = await api(`/api/admin/block/${n}`);
            if (!r.ok) { d.innerHTML = errorBox(r.data.error || 'Not available.'); return; }
            const b = r.data;
            d.innerHTML = `<h3 style="margin-top:0">Block ${num(b.number)}</h3><div class="kv"><div>Data hash</div><div>${hash(b.dataHash)}</div><div>Previous hash</div><div>${hash(b.previousHash)}</div><div>Transactions</div><div>${b.txCount}</div></div>${b.transactions.map(txHTML).join('')}`;
            d.scrollIntoView({ block: 'nearest' });
        }
        rows.addEventListener('click', (e) => { if (e.target.closest('button,a,.hash')) return; const tr = e.target.closest('tr.blkrow'); if (tr) open(Number(tr.dataset.n)); });
        $('#jgo').onclick = () => { const n = Number($('#jump').value); if (Number.isInteger(n) && n >= 0) open(n); };
        $('#fel').onchange = (e) => { filter = e.target.checked; before = undefined; loadPage(false); };
        $('#tail').onchange = (e) => {
            live = e.target.checked;
            if (es) { es.close(); es = null; }
            if (!live) return;
            es = new EventSource('/api/stream/blocks');
            es.onmessage = (m) => {
                const b = JSON.parse(m.data);
                if (b.error) { $('#hint').textContent = b.error; return; }
                if (b.hello) { $('#hint').textContent = `Live from block ${num(b.fromBlock)}`; return; }
                rows.insertAdjacentHTML('afterbegin', blockRow(b, true));
            };
            es.onerror = () => { $('#hint').textContent = 'Live tail disconnected.'; };
        };
        loadPage(false);
        return () => { if (es) es.close(); };
    };
})();
