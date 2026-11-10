'use strict';

// Panel 13 (Figures and tables) and the status bar's screenshot count.
// Expected screenshot names come from data/figures.json (fig5-01.png to
// fig5-21.png, per DASHBOARD_PLAN.md section 5); presence is checked in
// evidence/screenshots/. "Source updated" is the newest mtime under each
// figure's file-based source paths.

const fs = require('fs');
const path = require('path');
const {
    missing, isMissing, repoPath, readJSON, mtimeISO, newestMtime, exists, safe, DASH,
} = require('../lib/util');

const SHOT_DIR = 'evidence/screenshots';

async function collect() {
    const figures = readJSON(path.join(DASH, 'data', 'figures.json'));
    if (isMissing(figures)) return { figures, expected: 0, present: 0 };
    if (!Array.isArray(figures)) return { figures: missing('dashboard/data/figures.json is not an array'), expected: 0, present: 0 };

    let onDisk = [];
    try { onDisk = fs.readdirSync(repoPath(SHOT_DIR)).sort(); } catch { /* dir absent: every screenshot MISSING */ }

    const rows = figures.map((f) => {
        const row = { item: f.item, content: f.content, source: f.source, paths: f.paths || [] };
        if (f.screenshot) {
            const rel = `${SHOT_DIR}/${f.screenshot}`;
            row.screenshot = rel;
            row.screenshotTaken = exists(repoPath(rel)) ? mtimeISO(repoPath(rel)) : missing(`${rel} not captured yet`);
        } else {
            row.screenshot = null;
        }
        const dated = row.paths.map((p) => newestMtime(repoPath(p))).filter(Boolean).sort();
        row.sourceUpdated = row.paths.length ? (dated.length ? dated[dated.length - 1] : missing(`none of ${row.paths.join(', ')} exist`)) : null;
        return row;
    });

    const expectedNames = new Set(rows.filter((r) => r.screenshot).map((r) => path.basename(r.screenshot)));
    const withShots = rows.filter((r) => r.screenshot);
    return {
        directory: SHOT_DIR,
        figures: rows,
        expected: withShots.length,
        present: withShots.filter((r) => !isMissing(r.screenshotTaken)).length,
        otherFiles: onDisk.filter((n) => !expectedNames.has(n)),
    };
}

module.exports = { collect: () => safe('screenshots', collect) };
