'use strict';

// Shared helpers for every page. No framework, no network access except this server.
window.VN = (() => {
    const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const $ = (sel, root = document) => root.querySelector(sel);
    const num = (n, d = 0) => (n === null || n === undefined || Number.isNaN(Number(n)) ? 'n/a' : Number(n).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }));
    const when = (iso) => (iso ? String(iso).replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC') : 'n/a');
    const dur = (ms) => (ms === null || ms === undefined ? 'n/a' : ms < 1000 ? `${Math.round(ms)} ms` : `${num(ms / 1000, 1)} s`);

    // First 8 and last 6 characters, copy button, full value on hover.
    function hash(v) {
        if (!v) return '<span class="dim">none</span>';
        const s = String(v);
        const short = s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
        return `<span class="hash" title="${esc(s)}"><code>${esc(short)}</code><button type="button" class="copy" data-copy="${esc(s)}" aria-label="Copy ${esc(short)}">copy</button></span>`;
    }

    async function api(path, opts = {}) {
        const init = { credentials: 'same-origin', headers: {}, ...opts };
        if (opts.json !== undefined) {
            init.method = init.method || 'POST';
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(opts.json);
            delete init.json;
        }
        let res;
        try { res = await fetch(path, init); } catch { return { ok: false, status: 0, data: { error: 'The dashboard server did not answer.' } }; }
        let data = null;
        try { data = await res.json(); } catch { data = {}; }
        return { ok: res.ok, status: res.status, data };
    }

    // Reads Server-Sent Events from a fetch response (works for POST streams).
    async function sse(path, opts, onEvent) {
        const res = await fetch(path, { credentials: 'same-origin', ...opts });
        if (!res.ok || !res.body) {
            let data = {};
            try { data = await res.json(); } catch { /* not JSON */ }
            return { ok: false, status: res.status, data };
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
                const chunk = buf.slice(0, i);
                buf = buf.slice(i + 2);
                const line = chunk.split('\n').find((l) => l.startsWith('data: '));
                if (line) { try { onEvent(JSON.parse(line.slice(6))); } catch { /* skip */ } }
            }
        }
        return { ok: true, status: res.status };
    }

    // EventSource with the end event closing it.
    function follow(path, onEvent, onEnd) {
        const es = new EventSource(path);
        es.onmessage = (m) => { let e; try { e = JSON.parse(m.data); } catch { return; } onEvent(e); if (e.type === 'end') { es.close(); if (onEnd) onEnd(e); } };
        es.onerror = () => { if (es.readyState === EventSource.CLOSED && onEnd) onEnd(null); };
        return es;
    }

    // ── What happened on the network drawers ──
    function drawer(id) {
        return `<details class="drawer" data-drawer="${esc(id)}"><summary>What happened on the network</summary><div class="drawer-body dim">Loading…</div></details>`;
    }
    function renderDrawer(d) {
        const keys = d.keys && d.keys.length
            ? `<h3>Keys read and written</h3><div class="scroll"><table><thead><tr><th>Direction</th><th>Key</th><th>Where</th><th>Value</th></tr></thead><tbody>${d.keys.map((k) => `<tr>${k.map((c, i) => `<td>${i === 1 ? `<code>${esc(c)}</code>` : esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '';
        const src = (d.sources || []).map((s) => {
            if (s.error) return `<div class="src"><div class="path">${esc(s.file)}${s.fn ? ` · ${esc(s.fn)}` : ''}</div><span class="unavail">${esc(s.error)}</span></div>`;
            const code = s.lines.map((l, i) => `<span class="ln">${s.from + i}</span>${esc(l)}`).join('\n');
            return `<div class="src"><div class="path"><code>${esc(s.file)}</code> lines ${s.from} to ${s.to}${s.fn ? ` (${esc(s.fn)})` : ''}${s.truncated ? ', shortened' : ''}${s.note ? `. ${esc(s.note)}` : ''}</div><pre class="code">${code}</pre></div>`;
        }).join('');
        return `<p>${esc(d.text)}</p>${keys}${src ? `<h3>Source on disk now</h3>${src}` : ''}`;
    }
    document.addEventListener('toggle', async (ev) => {
        const el = ev.target;
        if (!(el instanceof HTMLElement) || !el.matches || !el.matches('details.drawer') || !el.open || el.dataset.loaded) return;
        const body = el.querySelector('.drawer-body');
        const r = await api(`/api/verify/drawer/${encodeURIComponent(el.dataset.drawer)}`);
        if (r.ok) { body.innerHTML = renderDrawer(r.data); el.dataset.loaded = '1'; } else body.innerHTML = '<span class="unavail">The explanation could not be loaded.</span>';
    }, true);

    // ── Copy buttons ──
    document.addEventListener('click', async (ev) => {
        const b = ev.target.closest && ev.target.closest('[data-copy]');
        if (!b) return;
        try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'copied'; } catch { b.textContent = 'select'; }
        setTimeout(() => { b.textContent = 'copy'; }, 1200);
    });

    // ── Theme ──
    function theme() {
        let t = null;
        try { t = localStorage.getItem('vn-theme'); } catch { /* storage blocked */ }
        if (t) document.documentElement.dataset.theme = t;
    }
    function toggleTheme() {
        const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        const next = cur === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem('vn-theme', next); } catch { /* storage blocked */ }
    }
    theme();
    document.addEventListener('click', (ev) => { if (ev.target.closest && ev.target.closest('[data-theme-toggle]')) toggleTheme(); });

    const banner = (kind, html) => `<div class="banner ${kind}">${html}</div>`;
    const loading = (t = 'Loading…') => `<div class="state"><span class="spinner"></span>${esc(t)}</div>`;
    const errorBox = (t) => `<div class="state err">${esc(t)}</div>`;
    const empty = (t) => `<div class="state">${esc(t)}</div>`;
    const initials = (name) => String(name).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

    return { esc, $, num, when, dur, hash, api, sse, follow, drawer, banner, loading, errorBox, empty, initials };
})();
