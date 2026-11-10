'use strict';

const { execSync } = require('child_process');
const fs = require('fs');

// Free disk space on the filesystem containing `path`, in whole GB.
function diskFreeGB(path = '/') {
    const out = execSync(`df --output=avail -BG "${path}" | tail -1`, { encoding: 'utf8' });
    return parseInt(out.trim().replace('G', ''), 10);
}

function dockerStatsSnapshot() {
    const out = execSync('docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}}"', {
        encoding: 'utf8',
        maxBuffer: 5 * 1024 * 1024,
    });
    return out.trim().split('\n').filter(Boolean);
}

// Samples `docker stats --no-stream` every `intervalMs` and appends rows to
// csvPath (timestamp,container,cpuPct,memUsage). Returns { stop() }.
function startDockerStatsSampler(csvPath, intervalMs = 5000) {
    fs.writeFileSync(csvPath, 'timestamp,container,cpuPct,memUsage\n');
    const timer = setInterval(() => {
        try {
            const ts = new Date().toISOString();
            const lines = dockerStatsSnapshot();
            const rows = lines.map((l) => {
                const [name, cpu, mem] = l.split(',');
                return `${ts},${name},${(cpu || '').replace('%', '')},"${mem || ''}"`;
            });
            fs.appendFileSync(csvPath, rows.join('\n') + '\n');
        } catch (err) {
            fs.appendFileSync(csvPath, `${new Date().toISOString()},ERROR,,"${(err.message || '').replace(/\n/g, ' ')}"\n`);
        }
    }, intervalMs);
    return { stop: () => clearInterval(timer) };
}

module.exports = { diskFreeGB, dockerStatsSnapshot, startDockerStatsSampler };
