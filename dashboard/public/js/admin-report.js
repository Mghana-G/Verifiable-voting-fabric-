'use strict';

// Report companion: the Chapter 5 figure and table map, each entry linking to
// the live panel that is its source. Presentation mode is the toggle in the top bar.
(() => {
    const { esc, $, api, loading, errorBox } = VN;
    VN.views.report = async (el) => {
        el.innerHTML = `<h2>Report companion</h2><p class="dim small">The Chapter 5 figure and table map. Each entry links to the dashboard section that is its source. Turn on <strong>Presentation mode</strong> in the top bar to hide navigation and debug detail and use larger type for screenshots.</p><div id="rbox">${loading('Reading data/figures.json…')}</div>`;
        const r = await api('/api/data/figures.json');
        const box = $('#rbox');
        if (!box) return;
        if (!r.ok || r.data.__missing) { box.innerHTML = errorBox((r.data && r.data.why) || 'figures.json could not be read.'); return; }
        // Where each Chapter 5 item is shown live.
        const LINK = {
            'Table 5.1': ['#records/p1', 'Project records: Environment'], 'Table 5.2': ['#records/p2', 'Project records: Toolchain'],
            'Table 5.3': ['#records/p5', 'Project records: Deviations'], 'Table 5.4': ['#tests', 'Tests and evidence'],
            'Table 5.5': ['#records/p8', 'Project records: Criteria'], 'Table 5.6': ['#records/p9', 'Project records: Performance'],
            'Fig 5.1': ['#records/p1', 'Environment'], 'Fig 5.2': ['#network/prereqs', 'Network control: 00 prerequisites'], 'Fig 5.3': ['#records/p2', 'Toolchain'],
            'Fig 5.4': ['#records/p2', 'Toolchain'], 'Fig 5.5': ['#records/p2', 'Toolchain'], 'Fig 5.6': ['#network', 'Network control: Start nodes'],
            'Fig 5.7': ['#network', 'Network control: Health check'], 'Fig 5.8': ['#records/p6', 'Timing trials'], 'Fig 5.9': ['/evidence/', 'Evidence browser'],
            'Fig 5.18': ['#records/p8', 'Criteria'], 'Fig 5.19': ['#records/p8', 'Criteria'], 'Fig 5.20': ['#records/p10', 'Contention probe'], 'Fig 5.21': ['#records/p11', 'Resources'],
        };
        const testLink = /^Fig 5\.(1[0-7])$/;
        const TEST_OF = { 10: '1a', 11: '1b', 12: '2', 13: '3', 14: '4a', 15: '4b', 16: '5', 17: '6' };
        const rows = r.data.map((f) => {
            let l = LINK[f.item];
            const m = testLink.exec(f.item);
            if (m) l = [`#tests/test-${TEST_OF[m[1]]}`, `Tests: test ${TEST_OF[m[1]]}`];
            const link = l ? `<a href="${esc(l[0])}">${esc(l[1])}</a>` : '<span class="dim">no live panel</span>';
            return `<tr><td><strong>${esc(f.item)}</strong></td><td>${esc(f.content)}</td><td class="small">${esc(f.source)}</td><td>${link}</td><td class="dim small">${esc(f.screenshot || '')}</td></tr>`;
        }).join('');
        box.innerHTML = `<div class="card scroll"><table><thead><tr><th>Item</th><th>Content</th><th>Source</th><th>Live panel</th><th>Screenshot file</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    };
})();
