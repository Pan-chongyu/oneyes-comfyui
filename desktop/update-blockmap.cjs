const fs = require('node:fs/promises');
const { gunzip } = require('node:zlib');
const { promisify } = require('node:util');
const { downloadRanges } = require('./update-download.cjs');
const { computeOperations, OperationKind } = require('electron-updater/out/differentialDownloader/downloadPlanBuilder');

async function readBlockmap(file, size) {
    const map = JSON.parse((await promisify(gunzip)(await fs.readFile(file))).toString('utf8'));
    const entry = map.files?.[0];
    if (map.version !== '2' || !Array.isArray(map.files) || map.files.length !== 1 || entry?.name !== 'file' || entry.offset !== 0 || !Array.isArray(entry.sizes) || !entry.sizes.length || !Array.isArray(entry.checksums) || entry.checksums.length !== entry.sizes.length || entry.sizes.some(n => !Number.isSafeInteger(n) || n <= 0) || entry.checksums.some(s => typeof s !== 'string' || !s) || entry.sizes.reduce((a, b) => a + b, 0) !== size) throw new Error('更新包分块索引无效');
    return map;
}

function planBlocks(oldMap, newMap, size) {
    const operations = computeOperations(oldMap, newMap, { info() {}, warn() {} });
    const total = operations.filter(op => op.kind === OperationKind.DOWNLOAD).reduce((n, op) => n + op.end - op.start, 0);
    if (operations.reduce((n, op) => n + op.end - op.start, 0) !== size) throw new Error('更新分块计划无效');
    return { operations, total, reused: size - total };
}

// Electron's tested block matching, with our signed metadata, proxy transport,
// cancellation and durable partial file. No installer is executed until the
// reconstructed file has passed the signed full-file SHA-256 check.
async function downloadBlocks({ baseFile, oldMapFile, newMapFile, base, entry, outputFile, fetcher, signal, changed = () => {} }) {
    const [oldMap, newMap] = await Promise.all([readBlockmap(oldMapFile, base.size), readBlockmap(newMapFile, entry.size)]);
    const { operations, total } = planBlocks(oldMap, newMap, entry.size);
    if (total >= entry.size) throw new Error('此版本无法复用本机安装包');
    const result = await downloadRanges({
        baseFile, entry, outputFile, fetcher, signal,
        identity: JSON.stringify([base.sha256, entry.sha256, base.blockmap.sha256, entry.blockmap.sha256]),
        operations: operations.map(op => ({ start: op.start, end: op.end, copy: op.kind === OperationKind.COPY })),
        changed: state => changed({ ...state, mode: 'delta', reused: entry.size - total }),
    });
    return { ...result, reused: entry.size - total };
}

module.exports = { readBlockmap, planBlocks, downloadBlocks };
