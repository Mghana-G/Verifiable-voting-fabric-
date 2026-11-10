'use strict';

// In-memory sessions. Demo-grade access control for a local prototype, not
// production authentication (docs/DASHBOARD_PLAN.md section 3).
//   cookie: vn_session=<64 hex>; HttpOnly; SameSite=Strict; Path=/
//   voter sessions expire 10 minutes after sign-in or when a ballot commits
//   admin sessions expire after 8 hours
// Nothing here is written to disk, so a voter ID never leaves memory.

const crypto = require('crypto');

const COOKIE = 'vn_session';
const TTL_MS = { voter: 10 * 60 * 1000, admin: 8 * 60 * 60 * 1000 };
const store = new Map();

function create(role, data = {}) {
    const id = crypto.randomBytes(32).toString('hex');
    const s = { id, role, createdAt: Date.now(), expiresAt: Date.now() + TTL_MS[role], ...data };
    store.set(id, s);
    return s;
}

function destroy(id) { store.delete(id); }

function parseCookie(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
}

function lookup(req) {
    const id = parseCookie(req.headers.cookie)[COOKIE];
    if (!id || !/^[0-9a-f]{64}$/.test(id)) return null;
    const s = store.get(id);
    if (!s) return null;
    if (Date.now() > s.expiresAt) { store.delete(id); return null; }
    return s;
}

function attach(req, res, next) {
    req.session = lookup(req);
    next();
}

function setCookie(res, s) {
    res.append('Set-Cookie', `${COOKIE}=${s.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor((s.expiresAt - Date.now()) / 1000)}`);
}

function clearCookie(res) {
    res.append('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

// Role check on the server for every protected route.
const requireRole = (role) => (req, res, next) => {
    if (!req.session) return res.status(401).json({ error: 'not signed in' });
    if (req.session.role !== role) return res.status(403).json({ error: `this needs the ${role} role` });
    return next();
};

setInterval(() => {
    for (const [id, s] of store) if (Date.now() > s.expiresAt) store.delete(id);
}, 60 * 1000).unref();

module.exports = { create, destroy, attach, setCookie, clearCookie, requireRole, COOKIE };
