'use strict';

// A single-lock job runner for scripts, tests and simulated-voter batches.
// One job at a time; the voter booth and the batch runner refuse to start
// while a network operation holds the lock. Output is kept as an event list
// so a browser that connects late (or reconnects) replays it, and is also
// written to dashboard/out/ops/<kind>-<time>.log for scripts and tests.
// Batch events carry no voter identifier (see lib/batch.js).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { REPO, DASH, RUN_ENV } = require('./util');

const OPS_DIR = path.join(DASH, 'out', 'ops');
const MAX_EVENTS = 6000;
const HEARTBEAT_MS = 15000;

let current = null;
let last = null;
let seq = 0;

const now = () => new Date().toISOString();

function busy() { return !!current; }
function active() { return current ? { id: current.id, kind: current.kind, label: current.label } : null; }

function emit(job, ev) {
    const e = { n: job.events.length, t: Date.now(), ...ev };
    if (job.events.length < MAX_EVENTS) job.events.push(e);
    for (const res of job.listeners) res.write(`data: ${JSON.stringify(e)}\n\n`);
    if (job.logStream && (ev.type === 'log')) job.logStream.write(`${ev.line}\n`);
}

// `fn(ctx)` does the work; ctx.log(line), ctx.emit({type:'row'...}), ctx.spawn(file,args).
// Resolves to the job (already registered) as soon as it starts.
function start(kind, label, fn, { logToFile = true } = {}) {
    if (current) return { ok: false, reason: `another operation is already running: ${current.label}` };
    seq += 1;
    const job = {
        id: `${Date.now().toString(36)}${seq}`, kind, label, state: 'running', startedAt: now(), finishedAt: null,
        exitCode: null, durationMs: null, events: [], listeners: new Set(), logFile: null, logStream: null, result: null,
    };
    if (logToFile) {
        try {
            fs.mkdirSync(OPS_DIR, { recursive: true });
            const file = path.join(OPS_DIR, `${kind}-${job.startedAt.replace(/[:.]/g, '-')}.log`);
            job.logStream = fs.createWriteStream(file);
            job.logFile = path.relative(REPO, file);
        } catch { /* the stream still works without a file */ }
    }
    current = job;
    const t0 = Date.now();
    const ctx = {
        job,
        log: (line) => emit(job, { type: 'log', line: String(line) }),
        emit: (ev) => emit(job, ev),
        spawn: (file, args, opts = {}) => new Promise((resolve) => {
            const child = spawn(file, args, { cwd: REPO, env: RUN_ENV, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
            let text = '';
            let carry = '';
            const take = (d) => {
                text += d;
                carry += d;
                const parts = carry.split('\n');
                carry = parts.pop();
                parts.forEach((l) => emit(job, { type: 'log', line: l }));
            };
            child.stdout.on('data', take);
            child.stderr.on('data', take);
            const timer = setTimeout(() => { emit(job, { type: 'log', line: '[dashboard] timeout, killing the process' }); child.kill('SIGKILL'); }, opts.timeoutMs || 30 * 60 * 1000);
            child.on('close', (code) => {
                clearTimeout(timer);
                if (carry) emit(job, { type: 'log', line: carry });
                resolve({ code, text });
            });
            child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, text: e.message }); });
        }),
    };
    (async () => {
        try {
            const r = await fn(ctx);
            job.exitCode = r && r.exitCode !== undefined ? r.exitCode : 0;
            job.result = r && r.result !== undefined ? r.result : null;
            job.state = job.exitCode === 0 ? 'done' : 'failed';
        } catch (e) {
            job.state = 'failed';
            job.exitCode = job.exitCode === null ? 1 : job.exitCode;
            emit(job, { type: 'log', line: `[dashboard] ${e.message}` });
        } finally {
            job.finishedAt = now();
            job.durationMs = Date.now() - t0;
            emit(job, { type: 'end', state: job.state, exitCode: job.exitCode, durationMs: job.durationMs, logFile: job.logFile, result: job.result });
            if (job.logStream) job.logStream.end();
            for (const res of job.listeners) { try { res.end(); } catch { /* gone */ } }
            job.listeners.clear();
            last = job;
            current = null;
        }
    })();
    return { ok: true, job };
}

function find(id) {
    if (current && current.id === id) return current;
    if (last && last.id === id) return last;
    return null;
}

function view(job) {
    if (!job) return null;
    const { id, kind, label, state, startedAt, finishedAt, exitCode, durationMs, logFile, result } = job;
    return { id, kind, label, state, startedAt, finishedAt, exitCode, durationMs, logFile, result };
}

// SSE: replay then follow, heartbeat every 15 s, close when the job ends.
function stream(job, req, res) {
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    for (const e of job.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
    if (job.state !== 'running') return res.end();
    job.listeners.add(res);
    const hb = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
    req.on('close', () => { clearInterval(hb); job.listeners.delete(res); });
    res.on('close', () => clearInterval(hb));
    return undefined;
}

module.exports = { start, busy, active, find, view, stream, current: () => current, lastJob: () => last, HEARTBEAT_MS };
