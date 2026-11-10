'use strict';

// Panel 15 (Repo): build phases from docs/PROGRESS.md, recent commits,
// current commit and uncommitted changes. Git is called with
// --no-optional-locks so `git status` never rewrites .git/index.

const { missing, isMissing, repoPath, readText, sh, safe } = require('../lib/util');

const ROW_RE = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(.*?)\s*\|\s*$/;
const PHASE_RE = /^Phase (\d+[A-Z]?)\b/;

function phases(text, fileLabel) {
    if (isMissing(text)) return text;
    const rows = text.split('\n').map((l) => ROW_RE.exec(l)).filter(Boolean)
        .map((m) => ({ date: m[1], task: m[2] }));
    if (!rows.length) return missing(`no dated rows found in ${fileLabel}`);
    const groups = new Map();
    for (const row of rows) {
        const m = PHASE_RE.exec(row.task);
        const id = m ? `Phase ${m[1]}` : 'Unlabelled';
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(row);
    }
    return [...groups.entries()].map(([id, list]) => ({
        id,
        entries: list.length,
        firstDate: list[0].date,
        lastDate: list[list.length - 1].date,
        exitGatePassed: list.some((r) => /EXIT GATE PASSED/i.test(r.task)),
        lastTask: list[list.length - 1].task,
    }));
}

async function collect() {
    const progressFile = 'docs/PROGRESS.md';
    const [log, branch, head, status] = await Promise.all([
        sh("git --no-optional-locks log -15 --date=short --format='%h%x09%ad%x09%s'"),
        sh('git rev-parse --abbrev-ref HEAD'),
        sh("git --no-optional-locks log -1 --date=iso-strict --format='%h%x09%ad%x09%s'"),
        sh('git --no-optional-locks status --porcelain'),
    ]);

    const commits = log.ok
        ? log.stdout.trim().split('\n').filter(Boolean).map((l) => {
            const [hash, date, ...subject] = l.split('\t');
            return { hash, date, subject: subject.join('\t') };
        })
        : missing(`git log failed: ${log.error}`);

    let current = missing(`git log -1 failed: ${head.error}`);
    if (head.ok) {
        const [hash, date, ...subject] = head.stdout.trim().split('\t');
        current = { hash, date, subject: subject.join('\t'), branch: branch.ok ? branch.stdout.trim() : missing('branch unknown') };
    }

    const changes = status.ok
        ? status.stdout.split('\n').filter(Boolean)
        : missing(`git status failed: ${status.error}`);

    return {
        phases: phases(readText(repoPath(progressFile)), progressFile),
        progressSource: progressFile,
        current,
        commits,
        uncommitted: isMissing(changes) ? changes : { count: changes.length, files: changes.slice(0, 40) },
    };
}

module.exports = { collect: () => safe('build', collect) };
