'use strict';

// Dashboard v2 (docs/DASHBOARD_PLAN.md): landing page and three roles.
//   voter     polling-station booth (MintVAT and CastBallot only, lib/station.js)
//   admin     console: network control, explorer, tests, project records
//   verifier  public portal, auditor identity, read-only
// Loopback only, reached from Windows through an SSH tunnel. Demo-grade access
// control for a local prototype, not production authentication.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { REPO, DASH, readJSON, isMissing, collectMissing } = require('./lib/util');
require('./lib/env');
const session = require('./lib/session');
const live = require('./lib/live');
const report = require('./lib/report');
const gw = require('./lib/gw');
const station = require('./lib/station');

const HOST = '127.0.0.1';
const PORT = 5050;
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const EVIDENCE = path.join(REPO, 'evidence');
const DATA_DIR = path.join(DASH, 'data');
const OUT_DIR = path.join(DASH, 'out');
// Each data file's required top-level JSON shape.
const DATA_FILES = { 'figures.json': 'array', 'milestones.json': 'array', 'notes.json': 'object' };

const collectors = {
    environment: require('./collectors/environment'),
    build: require('./collectors/build'),
    deviations: require('./collectors/deviations'),
    tests: require('./collectors/tests'),
    criteria: require('./collectors/criteria'),
    performance: require('./collectors/performance'),
    screenshots: require('./collectors/screenshots'),
};

// Write via a temp file and rename so a reader never sees a half-written file.
function writeAtomic(abs, text) {
    const tmp = `${abs}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, abs);
}

function nextMilestone(milestones) {
    if (isMissing(milestones)) return milestones;
    if (!Array.isArray(milestones) || !milestones.length) return 'none set';
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = milestones.filter((m) => m && !m.done && typeof m.date === 'string' && m.date >= today)
        .sort((a, b) => a.date.localeCompare(b.date));
    return upcoming.length ? `${upcoming[0].date}: ${upcoming[0].label}` : 'none upcoming';
}

function statusBar(s) {
    const pending = { state: 'checking', detail: 'The live reading is requested separately from /api/live.' };
    const c = s.criteria;
    const sh = s.screenshots;
    return {
        network: pending,
        peerHeights: pending,
        criteria: c.error ? { error: c.error } : { proven: c.provenCount, of: 7, measured: c.measuredCount, ofMeasured: 2 },
        openBlockers: s.deviations.error ? { error: s.deviations.error } : s.deviations.openBlockers,
        screenshots: sh.error ? { error: sh.error } : { present: sh.present, expected: sh.expected },
        nextMilestone: nextMilestone(s.data.milestones),
    };
}

async function buildState() {
    const names = Object.keys(collectors);
    const results = await Promise.all(names.map((n) => collectors[n].collect()));
    const state = { generatedAt: new Date().toISOString(), phase: 'v2' };
    names.forEach((n, i) => { state[n] = results[i]; });
    state.data = {
        milestones: readJSON(path.join(DATA_DIR, 'milestones.json')),
        notes: readJSON(path.join(DATA_DIR, 'notes.json')),
    };
    state.missing = collectMissing(state);
    state.status = statusBar(state);
    return state;
}

const app = express();
app.disable('x-powered-by');

// Bound to loopback, but also refuse other Host headers so a DNS-rebinding
// page cannot drive the API from the browser.
app.use((req, res, next) => {
    if (!ALLOWED_HOSTS.has(req.headers.host)) return res.status(403).send('Forbidden host');
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    });
    return next();
});

// A state-changing request must come from this page: if the browser sends
// an Origin it has to be ours, so another site cannot drive the API.
app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: 'cross-origin request refused' });
    return next();
});

app.use(session.attach);

const admin = session.requireRole('admin');

app.use('/api/auth', require('./routes/auth').router);
app.use('/api/voter', require('./routes/voter').router);
app.use('/api/verify', require('./routes/verify').router);
app.use('/api/admin', require('./routes/admin').router);
app.use('/api/stream', require('./routes/stream').router);

// ── Project records (admin): /api/state, /api/live, data files, report export ──

app.get('/api/live', admin, async (req, res) => {
    const election = typeof req.query.election === 'string' && req.query.election ? req.query.election : undefined;
    res.json(await live.collect({ electionID: election }));
});

app.post('/api/export/report', admin, express.json({ limit: '1kb' }), async (req, res) => {
    const [state, reading] = await Promise.all([buildState(), live.collect()]);
    res.json(report.write(state, reading, live.lastReading()));
});

// Generated files under dashboard/out/ that the page links to.
const OUT_FILES = { 'status-report.md': 'text/markdown; charset=utf-8', 'state.json': 'application/json; charset=utf-8', 'live-last.json': 'application/json; charset=utf-8' };
app.get('/out/:file', admin, (req, res) => {
    const type = OUT_FILES[req.params.file];
    if (!type) return res.status(404).send('Not found');
    const abs = path.join(OUT_DIR, req.params.file);
    if (!fs.existsSync(abs)) return res.status(404).send('Not generated yet');
    return res.type(type).send(fs.readFileSync(abs));
});

app.get('/api/state', admin, async (req, res) => {
    const state = await buildState();
    try {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        writeAtomic(path.join(OUT_DIR, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
    } catch (e) {
        state.snapshotError = `could not write dashboard/out/state.json: ${e.message}`;
    }
    res.json(state);
});

app.get('/api/data/:file', admin, (req, res) => {
    if (!DATA_FILES[req.params.file]) return res.status(404).json({ error: 'unknown data file' });
    return res.json(readJSON(path.join(DATA_DIR, req.params.file)));
});

app.put('/api/data/:file', admin, express.text({ type: '*/*', limit: '1mb' }), (req, res) => {
    const shape = DATA_FILES[req.params.file];
    if (!shape) return res.status(404).json({ error: 'unknown data file' });
    let value;
    try {
        value = JSON.parse(req.body);
    } catch (e) {
        return res.status(400).json({ error: `not valid JSON: ${e.message}` });
    }
    const ok = shape === 'array' ? Array.isArray(value) : value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!ok) return res.status(400).json({ error: `${req.params.file} must be a JSON ${shape}` });
    writeAtomic(path.join(DATA_DIR, req.params.file), `${JSON.stringify(value, null, 2)}\n`);
    return res.json({ saved: req.params.file });
});

// ── Read-only evidence browser (admin) ──────────────────────────────────────
app.use('/evidence', (req, res, next) => {
    if (!req.session || req.session.role !== 'admin') return res.status(401).send('Administrator sign-in required. <a href="/">Sign in</a>');
    return next();
});

// ── Read-only evidence browser ───────────────────────────────────────────────

const TYPES = {
    '.json': 'application/json; charset=utf-8',
    '.csv': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function insideEvidence(abs) {
    return abs === EVIDENCE || abs.startsWith(EVIDENCE + path.sep);
}

function listing(abs, urlPath) {
    const entries = fs.readdirSync(abs, { withFileTypes: true })
        .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    const crumbs = urlPath.split('/').filter(Boolean);
    const trail = crumbs.map((c, i) => `<a href="/${crumbs.slice(0, i + 1).map(encodeURIComponent).join('/')}/">${esc(c)}</a>`).join(' / ');
    const rows = entries.map((e) => {
        const st = fs.statSync(path.join(abs, e.name));
        const href = encodeURIComponent(e.name) + (e.isDirectory() ? '/' : '');
        const size = e.isDirectory() ? '' : `${st.size.toLocaleString('en-GB')} B`;
        return `<tr><td><a href="${href}">${esc(e.name)}${e.isDirectory() ? '/' : ''}</a></td><td>${size}</td><td>${st.mtime.toISOString().replace('T', ' ').slice(0, 19)}</td></tr>`;
    }).join('');
    return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(urlPath)}</title><style>
body{font:14px/1.45 system-ui,sans-serif;margin:16px;color:#1f2937;background:#fff}a{color:#1d4ed8}
table{border-collapse:collapse;width:100%;max-width:960px}td{padding:4px 8px;border-bottom:1px solid #e5e7eb;word-break:break-all}
td:nth-child(2),td:nth-child(3){white-space:nowrap;color:#6b7280;word-break:normal}.note{color:#6b7280}
</style></head><body><p><a href="/">Dashboard</a> / ${trail}</p><p class="note">Read-only view of evidence/. Nothing here can be changed from the dashboard.</p>
<table>${urlPath !== '/evidence/' ? '<tr><td><a href="../">../</a></td><td></td><td></td></tr>' : ''}${rows}</table></body></html>`;
}

app.get(/^\/evidence(\/.*)?$/, (req, res) => {
    let relPath;
    try {
        relPath = decodeURIComponent(req.params[0] || '/');
    } catch {
        return res.status(400).send('Bad path');
    }
    const abs = path.resolve(EVIDENCE, `.${relPath}`);
    if (!insideEvidence(abs)) return res.status(403).send('Outside evidence/');
    let real;
    try {
        real = fs.realpathSync(abs);
    } catch {
        return res.status(404).send('Not found');
    }
    if (!insideEvidence(real)) return res.status(403).send('Outside evidence/');
    const st = fs.statSync(real);
    if (st.isDirectory()) {
        if (!req.path.endsWith('/')) return res.redirect(301, `${req.path}/`);
        return res.type('html').send(listing(real, `/evidence${relPath.endsWith('/') ? relPath : `${relPath}/`}`));
    }
    const type = TYPES[path.extname(real).toLowerCase()];
    res.set('Content-Type', type || 'application/octet-stream');
    if (!type) res.set('Content-Disposition', `attachment; filename="${path.basename(real).replace(/"/g, '')}"`);
    return fs.createReadStream(real).pipe(res);
});

app.all(/^\/evidence(\/.*)?$/, (req, res) => res.status(405).set('Allow', 'GET, HEAD').send('evidence/ is read-only'));

// ── Pages ───────────────────────────────────────────────────────────────────
const PUBLIC = path.join(DASH, 'public');
for (const page of ['voter', 'admin', 'verify']) {
    app.get(`/${page}`, (req, res) => res.sendFile(path.join(PUBLIC, `${page}.html`)));
}
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
app.use(express.static(PUBLIC, { index: 'index.html' }));

app.listen(PORT, HOST, () => {
    console.log(`Dashboard v2 on http://${HOST}:${PORT}`);
    // Open the gateway connections and fill the probe caches now, so the
    // first page load is not the slow one.
    live.collect().catch(() => {});
});

const shutdown = () => { gw.closeAll(); station.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
