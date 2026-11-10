'use strict';

// Panel 5 (Deviations, Table 5.3): DEV entries from docs/DEVIATIONS.md and
// blockers from docs/BLOCKERS.md. Status and consequence are taken only from
// explicit "Status:" and "Impact assessment:" text; absent means MISSING.

const { missing, isMissing, repoPath, readText, stripMd, safe } = require('../lib/util');

const DEV_HEADING_RE = /^## (DEV-\d+)\s*[—-]\s*(.+)$/gm;
const STATUS_RE = /Status:\s*\**\s*([^*.(\n]+?)\s*(?:\*\*)?\s*(?:\((\d{4}-\d{2}-\d{2})\))?\s*[.\n]/i;
const IMPACT_RE = /\*\*Impact assessment:\*\*\s*([^\n]+)/;

function firstSentence(s) {
    const m = /^(.+?[.!?])(\s|$)/.exec(s);
    return stripMd(m ? m[1] : s);
}

function deviations(text, file) {
    if (isMissing(text)) return text;
    const heads = [...text.matchAll(DEV_HEADING_RE)];
    if (!heads.length) return missing(`no '## DEV-NNN' headings in ${file}`);
    return heads.map((h, i) => {
        const body = text.slice(h.index + h[0].length, i + 1 < heads.length ? heads[i + 1].index : text.length);
        const status = STATUS_RE.exec(body);
        const impact = IMPACT_RE.exec(body);
        return {
            id: h[1],
            title: stripMd(h[2]),
            status: status ? status[1].trim() : missing(`${h[1]} in ${file} has no 'Status:' line`),
            statusDate: status && status[2] ? status[2] : null,
            consequence: impact ? firstSentence(impact[1]) : missing(`${h[1]} in ${file} has no 'Impact assessment' paragraph`),
        };
    });
}

function blockers(text, file) {
    if (isMissing(text)) return text;
    const heads = [...text.matchAll(/^## (.+)$/gm)];
    return heads.map((h) => ({
        title: stripMd(h[1]),
        resolved: /RESOLVED/i.test(h[1]),
    }));
}

async function collect() {
    const devFile = 'docs/DEVIATIONS.md';
    const blkFile = 'docs/BLOCKERS.md';
    const devs = deviations(readText(repoPath(devFile)), devFile);
    const blks = blockers(readText(repoPath(blkFile)), blkFile);
    return {
        deviations: devs,
        blockers: blks,
        openBlockers: isMissing(blks) ? blks : blks.filter((b) => !b.resolved).length,
        sources: [devFile, blkFile],
    };
}

module.exports = { collect: () => safe('deviations', collect) };
