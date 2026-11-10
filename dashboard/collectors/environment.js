'use strict';

// Panels 1 (Environment) and 2 (Toolchain). Host spec and locked versions are
// read from MASTER_PLAN.md; everything else is a live read-only probe.

const {
    missing, isMissing, repoPath, readText, readJSON, exists, mtimeISO, sh, shCached,
    stripMd, mdTableAfter, safe,
} = require('../lib/util');

// How to read the live version of each MASTER_PLAN.md A.4 component.
const PROBES = {
    'Ubuntu': { cmd: 'lsb_release -ds' },
    'Docker Engine': { cmd: 'docker --version' },
    'Docker Compose': { cmd: 'docker compose version' },
    'Hyperledger Fabric': { cmd: "peer version 2>&1 | grep 'Version:'" },
    'Fabric CA': { cmd: "fabric-ca-client version 2>&1 | grep 'Version:'" },
    'CouchDB': { cmd: "docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^couchdb:'" },
    'Node.js': { cmd: 'node --version' },
    'fabric-contract-api / fabric-shim': {
        pkgs: ['chaincode/voting/node_modules/fabric-contract-api', 'chaincode/voting/node_modules/fabric-shim'],
    },
    '@hyperledger/fabric-gateway': {
        pkgs: ['test/node_modules/@hyperledger/fabric-gateway', 'client-app/node_modules/@hyperledger/fabric-gateway',
            'verification-dashboard/node_modules/@hyperledger/fabric-gateway'],
    },
    'Express': { pkgs: ['client-app/node_modules/express', 'verification-dashboard/node_modules/express'] },
    'better-sqlite3': { pkgs: ['client-app/node_modules/better-sqlite3'] },
    'Python': { cmd: 'python3 --version' },
    'Faker': { cmd: "python3 -c 'import faker; print(faker.VERSION)'" },
    'Git': { cmd: 'git --version' },
    'jq, curl, tmux, htop': {
        multi: { jq: 'jq --version', curl: 'curl --version | head -1', tmux: 'tmux -V', htop: 'htop --version' },
    },
};
// Listed in A.4 but not part of the running system, so not probed.
const NOT_PROBED = { 'Go': 'not needed (Node.js chaincode)' };

const VERSION_RE = /(\d+\.\d+(?:\.\d+)?)/;

function versionOf(text) {
    const m = VERSION_RE.exec(String(text));
    return m ? m[1] : null;
}

// A locked value pins a version only when it starts with a number:
// "27.x (current stable…)" pins 27, "latest" / "system" / "v2 plugin" do not.
function pinnedPrefix(locked) {
    const m = /^(\d+(?:\.\d+)*)/.exec(stripMd(locked));
    return m ? m[1] : null;
}

function matches(live, prefix) {
    return live === prefix || live.startsWith(`${prefix}.`);
}

function pkgVersion(relDir) {
    const pj = readJSON(repoPath(relDir, 'package.json'));
    if (isMissing(pj)) return pj;
    return pj.version || missing(`no version in ${relDir}/package.json`);
}

async function probeLive(probe) {
    if (probe.cmd) {
        const out = await shCached(probe.cmd);
        if (isMissing(out)) return { display: out, versions: [] };
        const v = versionOf(out);
        return { display: out.split('\n')[0], versions: v ? [v] : [] };
    }
    if (probe.pkgs) {
        const parts = probe.pkgs.map((p) => ({ where: p.split('/')[0], v: pkgVersion(p) }));
        const found = parts.filter((p) => !isMissing(p.v));
        if (!found.length) return { display: missing(`not installed in any of: ${probe.pkgs.join(', ')}`), versions: [] };
        return {
            display: found.map((p) => `${p.v} (${p.where})`).join(', '),
            versions: found.map((p) => p.v),
        };
    }
    const entries = await Promise.all(Object.entries(probe.multi).map(async ([name, cmd]) => {
        const out = await shCached(cmd);
        return { name, out };
    }));
    const display = entries.map((e) => `${e.name} ${isMissing(e.out) ? 'MISSING' : versionOf(e.out) || e.out}`).join(', ');
    return { display, versions: [] };
}

async function tools(lockedRows, devTitles) {
    if (isMissing(lockedRows)) return lockedRows;
    return Promise.all(lockedRows.map(async ([componentCell, lockedCell]) => {
        const component = stripMd(componentCell);
        const locked = stripMd(lockedCell);
        if (NOT_PROBED[component]) {
            return { component, locked, live: null, status: 'not probed', note: NOT_PROBED[component] };
        }
        const probe = PROBES[component];
        if (!probe) {
            return { component, locked, live: missing(`no probe defined for '${component}'`), status: 'unknown' };
        }
        const live = await probeLive(probe);
        const prefix = pinnedPrefix(lockedCell);
        let status = 'unpinned';
        let deviation = null;
        if (prefix && isMissing(live.display)) {
            status = 'unknown';
        } else if (prefix && live.versions.length) {
            status = live.versions.every((v) => matches(v, prefix)) ? 'matches' : 'differs';
            if (status === 'differs') {
                const dev = devTitles.find((d) => d.title.includes(component));
                deviation = dev ? dev.id : null;
            }
        } else if (prefix) {
            status = 'unknown';
        }
        return { component, locked, live: live.display, pinned: prefix, status, deviation };
    }));
}

// The `check "label" "cmd" "want"` lines of 00-prereqs.sh, re-evaluated with
// the script's own rule: first line of output must contain `want`.
async function prereqs() {
    const file = 'network/scripts/00-prereqs.sh';
    const text = readText(repoPath(file));
    if (isMissing(text)) return { source: file, checks: text };
    const re = /^check\s+"([^"]*)"\s+"([^"]*)"\s+"([^"]*)"\s*$/gm;
    const defs = [];
    for (let m = re.exec(text); m; m = re.exec(text)) defs.push({ label: m[1], cmd: m[2], want: m[3] });
    if (!defs.length) return { source: file, checks: missing(`no check lines parsed from ${file}`) };
    const checks = await Promise.all(defs.map(async (d) => {
        const out = await shCached(`(${d.cmd}) 2>/dev/null | head -1`);
        const got = isMissing(out) ? '' : out;
        return { label: d.label, want: d.want, got, pass: got.includes(d.want) };
    }));
    return { source: file, checks, passed: checks.filter((c) => c.pass).length, total: checks.length };
}

// Images referenced by docker-compose.yaml, with ${VARS} from network/.env.
function expectedImages() {
    const compose = readText(repoPath('network/docker-compose.yaml'));
    const env = readText(repoPath('network/.env'));
    if (isMissing(compose)) return compose;
    if (isMissing(env)) return env;
    const vars = {};
    for (const line of env.split('\n')) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m) vars[m[1]] = m[2];
    }
    const images = new Set();
    for (const m of compose.matchAll(/^\s*image:\s*(\S+)/gm)) {
        images.add(m[1].replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => vars[k] ?? `\${${k}}`));
    }
    return [...images].sort();
}

async function guest() {
    const [nproc, free, df, os, kernel] = await Promise.all([
        shCached('nproc'), shCached('free -b', { ttlMs: 15000 }), shCached('df -B1 --output=size,used,avail /', { ttlMs: 15000 }),
        shCached('lsb_release -ds'), shCached('uname -r'),
    ]);
    let memory = free;
    if (!isMissing(free)) {
        const m = /^Mem:\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s+\d+\s+(\d+)/m.exec(free);
        memory = m ? { totalBytes: Number(m[1]), usedBytes: Number(m[2]), availableBytes: Number(m[3]) }
            : missing('could not parse `free -b` output');
    }
    let disk = df;
    if (!isMissing(df)) {
        const nums = df.split('\n').pop().trim().split(/\s+/).map(Number);
        disk = nums.length === 3 && nums.every(Number.isFinite)
            ? { sizeBytes: nums[0], usedBytes: nums[1], freeBytes: nums[2] }
            : missing('could not parse `df` output');
    }
    return {
        vcpu: isMissing(nproc) ? nproc : Number(nproc),
        memory, disk, os, kernel,
    };
}

async function collect() {
    const planFile = 'MASTER_PLAN.md';
    const plan = readText(repoPath(planFile));
    const hostRows = mdTableAfter(plan, '### A.1 Host machine', planFile);
    const lockedRows = mdTableAfter(plan, '### A.4 Software versions', planFile);

    const devText = readText(repoPath('docs/DEVIATIONS.md'));
    const devTitles = isMissing(devText) ? [] : [...devText.matchAll(/^## (DEV-\d+)\s*[—-]\s*(.+)$/gm)]
        .map((m) => ({ id: m[1], title: m[2] }));

    const [guestInfo, toolRows, prereq, binaries, imagesOut] = await Promise.all([
        guest(),
        tools(lockedRows, devTitles),
        prereqs(),
        Promise.all([
            ['peer', "peer version 2>&1 | grep -E 'Version:|Commit SHA:'"],
            ['configtxgen', "configtxgen --version 2>&1 | grep 'Version:'"],
            ['fabric-ca-client', "fabric-ca-client version 2>&1 | grep 'Version:'"],
        ].map(async ([name, cmd]) => ({ name, output: await shCached(cmd) }))),
        shCached("docker images --format '{{.Repository}}:{{.Tag}}'", { ttlMs: 30000 }),
    ]);

    const expected = expectedImages();
    let images;
    if (isMissing(imagesOut)) {
        images = { expected: isMissing(expected) ? expected : expected.map((name) => ({ name, present: imagesOut })), all: imagesOut };
    } else {
        const all = imagesOut.split('\n').map((s) => s.trim()).filter(Boolean).sort();
        images = {
            expected: isMissing(expected) ? expected : expected.map((name) => ({ name, present: all.includes(name) })),
            all,
        };
    }

    const phase0File = 'evidence/screenshots/phase0-testnetwork.txt';
    const phase0Text = readText(repoPath(phase0File));

    return {
        host: isMissing(hostRows) ? hostRows : hostRows.map(([item, value]) => ({ item: stripMd(item), value: stripMd(value) })),
        hostSource: `${planFile} A.1`,
        guest: guestInfo,
        tools: toolRows,
        toolsSource: `${planFile} A.4 (Chapter5.docx Table 5.2 is not in the VM, so A.4 is the reference)`,
        prereqs: {
            lastRun: missing('00-prereqs.sh prints to the terminal only; no stored run output exists under evidence/'),
            live: prereq,
        },
        binaries,
        images,
        phase0Evidence: {
            path: phase0File,
            modified: exists(repoPath(phase0File)) ? mtimeISO(repoPath(phase0File)) : missing(`${phase0File} not found`),
            preview: isMissing(phase0Text) ? phase0Text : phase0Text.split('\n').slice(0, 14).join('\n'),
        },
    };
}

module.exports = { collect: () => safe('environment', collect) };
