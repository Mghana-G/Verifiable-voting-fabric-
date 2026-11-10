'use strict';

(() => {
    const { esc, $, api, hash, num, banner, loading, errorBox, empty } = VN;
    const pane = $('#pane');
    const COL = ['var(--c1)', 'var(--c2)', 'var(--c3)'];
    let tab = 'results';

    function select(t) {
        tab = t;
        document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
        try { history.replaceState(null, '', `#${t}`); } catch { /* ignore */ }
        ({ results, ballot, chain, privacy, limits })[t]();
    }
    document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => select(b.dataset.tab); });

    // ── Results ──
    async function results() {
        pane.innerHTML = loading('Reading the tally and audit invariant from all four peers…');
        const r = await api('/api/verify/results');
        if (!r.ok) { pane.innerHTML = errorBox(r.data.error || 'The results could not be read. The network may be down.'); return; }
        const d = r.data;
        const max = Math.max(1, ...d.candidates.map((c) => c.votes || 0));
        const inv = d.invariant;
        const invOK = inv && inv.holds;
        const bars = d.candidates.map((c, i) => `<div class="bar"><div><strong>${esc(c.name)}</strong><div class="dim small">${esc(c.party)}</div></div><div class="track"><div class="fill" style="width:${c.votes === null ? 0 : (c.votes / max) * 100}%;background:${COL[i % 3]}"></div></div><div class="num"><strong>${c.votes === null ? 'n/a' : num(c.votes)}</strong></div></div>`).join('');
        const peers = d.peers.map((p) => `<div class="peer"><h4>${esc(p.org)}</h4>${p.ok
            ? `<div class="small">Tally: ${Object.keys(p.tally).length ? Object.entries(p.tally).sort().map(([k, v]) => `${esc(k)} ${num(v)}`).join(', ') : 'no votes'}</div><div class="small">burnedCount ${num(p.invariant.burnedCount)}, tallyTotal ${num(p.invariant.tallyTotal)}</div>`
            : `<span class="unavail">${esc(p.tally.reason || p.invariant.reason || 'did not answer')}</span>`}</div>`).join('');
        pane.innerHTML = `<div class="grid cols-2">
          <section class="card"><h2>Results: ${esc(d.electionID)}</h2><div class="bars">${bars}</div>
            <p class="small dim">Total ballots counted: <strong>${d.total === null ? 'n/a' : num(d.total)}</strong>. Read ${esc(VN.when(d.readAt))} as Civil Society (the auditor), by evaluating GetTally. Nothing is submitted.</p></section>
          <section class="card"><h2>Audit invariant</h2>
            ${inv && !inv.unavailable ? `<div class="inv"><div class="mark ${invOK ? 'ok' : 'no'}" aria-label="${invOK ? 'holds' : 'broken'}">${invOK ? '&#10003;' : '&#10007;'}</div><div><div><strong>burnedCount ${num(inv.burnedCount)} ${invOK ? '=' : '&ne;'} tallyTotal ${num(inv.tallyTotal)}</strong></div><div class="small dim">Burned tokens equal counted ballots. This is a consistency check, not an independent count (see "What this proves").</div></div></div>` : '<span class="unavail">unavailable</span>'}
          </section></div>
          <section class="card" style="margin-top:14px"><h2>Four peers agree ${d.agree ? '<span class="badge b-ok">identical</span>' : '<span class="badge b-bad">not identical</span>'}</h2>
            <p class="dim small">GetTally and GetAuditInvariant were evaluated separately against each of the four peers, one connection per organisation. This is the positive form of test 2: an honest network gives the same answer everywhere.</p>
            <div class="peers">${peers}</div></section>`;
    }

    // ── Verify my ballot ──
    function ballot(prefill) {
        pane.innerHTML = `<section class="card"><h2>Verify my ballot</h2>
          <p class="dim small">Enter the ballot ID from your receipt (a transaction ID, 64 hexadecimal characters). The ledger is read with the committed block itself, not with a chaincode query.</p>
          <form id="bf" style="display:flex;gap:8px;flex-wrap:wrap"><input type="text" id="bid" style="flex:1;min-width:240px" placeholder="ballot ID" spellcheck="false" autocomplete="off"><button class="primary" type="submit">Verify</button></form>
          <div id="bres" style="margin-top:14px"></div></section>`;
        const run = async (id) => {
            $('#bres').innerHTML = loading('Reading the block…');
            const r = await api(`/api/verify/ballot/${encodeURIComponent(id.trim())}`);
            const out = $('#bres');
            if (!r.ok) { out.innerHTML = errorBox(r.data.error || 'Not available.'); return; }
            const d = r.data;
            if (!d.found) { out.innerHTML = banner('warn', 'No transaction with this ID exists on the channel.'); return; }
            if (!d.isBallot) { out.innerHTML = banner('warn', `This ID is a ${esc(d.function)} transaction, not a ballot.`) + `<div class="kv"><div>Block</div><div>${num(d.blockNumber)}</div><div>Validation</div><div>${esc(d.validationName)}</div></div>`; return; }
            const head = d.counted ? banner('ok', '<strong>Counted.</strong> The ballot is in a committed block with validation code VALID.')
                : banner('bad', `<strong>Not counted.</strong> The transaction is in the block but its validation code is ${esc(d.validationName)}, so its writes were discarded.`);
            out.innerHTML = `${head}<div class="kv">
              <div>Ballot ID</div><div>${hash(d.txID)}</div><div>Block</div><div class="num">${num(d.blockNumber)}</div>
              <div>Validation code</div><div><span class="badge ${d.validationCode === 0 ? 'b-ok' : 'b-bad'}">${esc(d.validationName)}</span></div>
              <div>Election</div><div>${esc(d.electionID)}</div>
              ${d.ballot ? `<div>Record</div><div><code>${esc(d.ballot.key)}</code></div><div>Candidate</div><div><strong>${esc(d.ballot.candidateID)}</strong></div><div>Timestamp</div><div>${esc(typeof d.ballot.timestamp === 'number' ? new Date(d.ballot.timestamp * 1000).toISOString() : d.ballot.timestamp)}</div>` : '<div>Record</div><div class="dim">no BALLOT record in the write set</div>'}
              <div>Endorsed by</div><div>${d.endorsers.map((m) => `<span class="badge b-info">${esc(m.replace(/^Org|MSP$/g, ''))}</span>`).join(' ')}</div></div>`;
        };
        $('#bf').onsubmit = (e) => { e.preventDefault(); run($('#bid').value); };
        if (prefill) { $('#bid').value = prefill; run(prefill); }
    }

    // ── Chain integrity ──
    async function chain() {
        pane.innerHTML = `<section class="card"><h2>Chain integrity</h2>
          <p class="dim small">The server recomputes two things for the latest blocks. <strong>Data hash:</strong> SHA-256 of the block's transactions equals the header's data hash. <strong>Header hash:</strong> SHA-256 of the DER encoding of (number, previous hash, data hash) equals the next block's previous-hash field.</p>
          <label for="nb">Latest blocks to check</label><select id="nb"><option>10</option><option selected>50</option><option>100</option><option>200</option></select> <button id="chk" class="primary">Check</button>
          <div id="cres" style="margin-top:14px"></div></section>`;
        const run = async () => {
            $('#cres').innerHTML = loading('Fetching blocks and recomputing hashes…');
            const r = await api(`/api/verify/integrity?n=${$('#nb').value}`);
            if (!r.ok) { $('#cres').innerHTML = errorBox(r.data.error || 'The ledger could not be read.'); return; }
            const d = r.data;
            const parts = [];
            d.blocks.forEach((b, i) => {
                parts.push(`<div class="blk ${b.dataHashOK ? '' : 'bad'}" title="header hash ${esc(b.headerHash)}"><strong>${num(b.number)}</strong><div>${b.dataHashOK ? 'data &#10003;' : 'data &#10007;'}</div></div>`);
                if (i < d.blocks.length - 1) parts.push(`<div class="link ${b.linkToNextOK ? '' : 'bad'}" title="${b.linkToNextOK ? 'next block previous_hash matches' : 'MISMATCH'}"></div>`);
            });
            $('#cres').innerHTML = `${d.allValid ? banner('ok', `<strong>All ${d.count} blocks check out.</strong> Every data hash matches and every link matches the next block's previous hash. Chain height ${num(d.height)}.`) : banner('bad', '<strong>A hash did not match.</strong> Red marks the block or link.')}<div class="chain" role="img" aria-label="Linked blocks">${parts.join('')}</div><p class="small dim">Green links: the hash of one block equals the next block's previous-hash. The oldest block's own previous link points outside the range checked.</p>`;
        };
        $('#chk').onclick = run;
        run();
    }

    // ── Privacy ──
    async function privacy() {
        pane.innerHTML = loading('Finding a recent MintVAT transaction…');
        const r = await api('/api/verify/privacy');
        const body = !r.ok ? errorBox(r.data.error || 'The ledger could not be read.')
            : !r.data.found ? empty('No MintVAT transaction in the latest blocks yet. Issue a ballot token in the booth first.')
                : `<p>Public view of <strong>MintVAT</strong> ${hash(r.data.txID)} in block ${num(r.data.blockNumber)}, election <code>${esc(r.data.electionID)}</code>:</p>
                <div class="privgrid"><div><h3>Public write set</h3><div class="scroll"><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${r.data.publicWrites.map((w) => `<tr><td><code>${esc(w.key)}</code></td><td><code>${esc(w.value)}</code></td></tr>`).join('')}</tbody></table></div></div>
                <div><h3>Private collection write (hashed only)</h3>${r.data.privateWrites.length ? r.data.privateWrites.map((c) => `<div class="small"><strong>${esc(c.collection)}</strong></div>${c.writes.map((w) => `<div class="small">key hash ${hash(w.keyHash)}<br>value hash ${hash(w.valueHash)}</div>`).join('')}`).join('') : '<span class="unavail">no private write set in this transaction</span>'}</div></div>
                <p class="small dim">The VOTERISSUED record (voter hash to token) is not in the block in readable form. Only member organisations hold it; everyone else sees the hashes above.</p>`;
        pane.innerHTML = `<section class="card"><h2>Privacy check</h2>${body}
          <h3>Read probe</h3><p class="small dim">Evaluates (never submits) the MintVAT read as Civil Society, which is not a member of the private collection, and shows the refusal.</p>
          <button id="probe" class="primary">Run read probe</button><div id="pres" style="margin-top:10px"></div>
          <div class="banner info small" style="margin-top:14px"><strong>What this proves:</strong> the peer refuses a non-member's read of the collection. <strong>What it does not prove:</strong> that non-member peers hold no copy of the data; whether their stores contain only hashes was not inspected (UNKNOWN 5 in HOW_IT_WORKS).</div></section>`;
        $('#probe').onclick = async () => {
            $('#pres').innerHTML = loading('Evaluating as Civil Society…');
            const p = await api('/api/verify/privacy-probe', { json: {} });
            const d = p.data;
            $('#pres').innerHTML = d.ok ? banner('warn', `Unexpected: the read was allowed. Output: ${esc(d.result)}`) : banner('ok', `<strong>Refused, as designed.</strong><br><code>${esc(d.message)}</code><div class="small">Evaluated as ${esc(d.evaluatedAs)}. Submitted: ${d.submitted}.</div>`);
        };
    }

    // ── Limits ──
    function limits() {
        pane.innerHTML = `<section class="card limits"><h2>What this verification does and does not prove</h2>
          <ul>
            <li><strong>The invariant is a consistency check, not an independent count.</strong> burnedCount and the tally are both written by the same chaincode in the same transaction, so they can agree even if the chaincode were wrong. They disagree only if state were altered outside the chaincode.</li>
            <li><strong>A token is not bound to its election at cast time.</strong> CastBallot takes the election from the signed payload, not from the token, so a token issued in one election is not checked against the election named in the payload.</li>
            <li><strong>The signature proves integrity, not identity.</strong> The key is ephemeral: it shows the payload was not altered after signing, not who signed it.</li>
            <li><strong>No receipt-freeness.</strong> The ballot ID and the public record let a voter prove their choice to someone else. Receipt-freeness is future work.</li>
            <li><strong>The token-to-candidate link is public on the channel.</strong> Every channel member can see which token voted for which candidate. The private collection hides only the link from the voter hash to the token.</li>
            <li><strong>Consensus is crash fault tolerant.</strong> Raft tolerates failed ordering nodes, not malicious ones.</li>
          </ul>
          <p class="small dim">These points are drawn from section 6 of docs/HOW_IT_WORKS.md. This page reads the ledger; it cannot show anything the code does not do.</p></section>`;
    }

    function route() {
        const h = (location.hash || '').replace(/^#/, '');
        if (h.startsWith('ballot=')) { select('ballot'); ballot(decodeURIComponent(h.slice(7))); } else select(['results', 'ballot', 'chain', 'privacy', 'limits'].includes(h) ? h : 'results');
    }
    window.addEventListener('hashchange', route);
    route();
})();
