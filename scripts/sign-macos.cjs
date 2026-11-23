const { readdir, open } = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { normalizeDirectory } = require('./normalize-resources.cjs');

const magic = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
async function signingPaths(directory) {
    const paths = [];
    // Walk one file at a time: the full Python distribution contains thousands of assets.
    for (const item of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, item.name);
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) {
            paths.push(...await signingPaths(file));
            if (/\.(app|framework)$/.test(item.name)) paths.push(file);
        } else if (item.isFile()) {
            const handle = await open(file, 'r');
            try {
                const buffer = Buffer.alloc(4), { bytesRead } = await handle.read(buffer, 0, 4, 0);
                if (bytesRead === 4 && magic.has(buffer.toString('hex'))) paths.push(file);
            } finally { await handle.close(); }
        }
    }
    return paths;
}

async function sign(options) {
    if (options.identity !== '-') throw new Error('This signing hook is limited to the approved ad-hoc macOS build');
    const paths = await signingPaths(path.join(options.app, 'Contents'));
    for (const file of [...paths, options.app]) execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--preserve-metadata=entitlements,requirements,flags', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    await normalizeDirectory(options.app);
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', options.app], { stdio: 'inherit' });
    console.log(`Signed ${paths.length} native binaries and bundles; resource assets remain sealed by the app signature`);
}
module.exports = sign;
module.exports.signingPaths = signingPaths;
