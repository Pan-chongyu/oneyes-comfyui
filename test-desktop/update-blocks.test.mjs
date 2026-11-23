import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, readdir, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { prepareBlockmap } from '../scripts/prepare-ota-blockmaps.mjs';
const require = createRequire(import.meta.url);
const { downloadBlocks, readBlockmap, planBlocks } = require('../desktop/update-blockmap.cjs');
const { createUpdater } = require('../desktop/updater.cjs');
const { filename, platformKey, readManifest, FEED, RELEASE_ROOT } = require('../desktop/update-policy.cjs');
const { normalizeDirectory } = require('../scripts/normalize-resources.cjs');
const targets = [
    { platform: 'win32', arch: 'x64', format: 'nsis' },
    { platform: 'darwin', arch: 'arm64', format: 'zip' },
    ...['x64', 'arm64'].flatMap(arch => ['AppImage', 'deb', 'rpm'].map(format => ({ platform: 'linux', arch, format }))),
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, target = targets[0]) {
    const directory = await mkdtemp(join(tmpdir(), 'comfy-blocks-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const original = Buffer.concat(Array.from({ length: 65536 }, (_, n) => createHash('sha256').update(String(n)).digest()));
    const next = Buffer.concat([original.subarray(0, 150000), Buffer.alloc(4096, 0x7b), original.subarray(150000)]);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    async function entry(version, bytes) {
        const file = filename(version, target.platform, target.arch, target.format), disk = join(directory, file);
        await writeFile(disk, bytes);
        const mapFile = await prepareBlockmap(disk), map = await readFile(mapFile);
        const value = { file, url: `${RELEASE_ROOT}/download/oneyes-v${version}/${file}`, size: bytes.length, sha256: hash(bytes), blockmap: { file: file + '.blockmap', url: `${RELEASE_ROOT}/download/oneyes-v${version}/${file}.blockmap`, size: map.length, sha256: hash(map) } };
        const text = JSON.stringify({ schema: 1, version, notes: '', platforms: { [platformKey(target)]: value } });
        return { ...value, disk, mapFile, text, signature: sign(null, Buffer.from(text), privateKey).toString('base64') };
    }
    const base = await entry('0.1.17', original), current = await entry('0.1.18', next);
    const requests = [];
    async function fetcher(url, init = {}) {
        requests.push({ url, range: init.headers?.Range });
        if (url === FEED || url === FEED + '.sig') return new Response(url === FEED ? current.text : current.signature);
        if (url === base.blockmap.url) return new Response(await readFile(base.mapFile));
        if (url === current.blockmap.url) return new Response(await readFile(current.mapFile));
        assert.equal(url, current.url);
        const range = /^bytes=(\d+)-(\d+)$/.exec(init.headers?.Range || '');
        if (!range) return new Response(next);
        const start = Number(range[1]), end = Number(range[2]);
        return new Response(next.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${next.length}`, etag: '"package-18"' } });
    }
    async function cacheBase() {
        const folder = join(directory, 'ota', '0.1.17');
        await mkdir(folder, { recursive: true });
        await copyFile(base.disk, join(folder, base.file));
        await writeFile(join(folder, 'comfy-latest.json'), base.text);
        await writeFile(join(folder, 'comfy-latest.json.sig'), base.signature);
    }
    return { directory, original, next, publicKey, base, current, requests, fetcher, cacheBase };
}

test('all eight signed OTA formats reuse blocks, reconstruct exact installers and prune older caches', async t => {
    for (const target of targets) await t.test(platformKey(target), async t => {
        const f = await fixture(t, target);
        assert.equal(readManifest(f.current.text, f.current.signature, target, f.publicKey).blockmap.file, f.current.blockmap.file);
        await f.cacheBase();
        await mkdir(join(f.directory, 'ota', 'base-0.1.1'));
        await mkdir(join(f.directory, 'ota', '0.1.2'));
        const updater = createUpdater({ currentVersion: '0.1.17', directory: f.directory, target: async () => target, publicKey: f.publicKey, fetcher: f.fetcher, install: async () => {} });
        t.after(() => updater.close());
        await updater.check();
        assert.equal(updater.state().status, 'ready', updater.state().error);
        assert.equal(updater.state().mode, 'delta');
        assert.ok(updater.state().reused > f.current.size * 0.8);
        assert.ok(f.requests.filter(x => x.url === f.current.url).every(x => x.range));
        assert.deepEqual(await readFile(join(f.directory, 'ota', '0.1.18', f.current.file)), f.next);
        assert.deepEqual((await readdir(join(f.directory, 'ota'))).sort(), ['0.1.18', 'base-0.1.17']);
    });
});

test('interrupted block download resumes from its durable offset', async t => {
    const f = await fixture(t);
    const outputFile = join(f.directory, 'resume.blocks.part');
    const options = { baseFile: f.base.disk, oldMapFile: f.base.mapFile, newMapFile: f.current.mapFile, base: f.base, entry: f.current, outputFile };
    let attempted, resumeStart;
    await assert.rejects(downloadBlocks({ ...options, fetcher: async (url, init) => {
        attempted = Number(/^bytes=(\d+)-/.exec(init.headers.Range)[1]);
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(f.next.subarray(attempted, attempted + 1024)); }, pull(controller) { controller.error(new Error('connection interrupted')); } }), { status: 206, headers: { 'content-range': `bytes ${init.headers.Range.slice(6)}/${f.next.length}` } });
    } }), error => error.resumableDownload === true);
    const offset = (await stat(outputFile)).size;
    assert.equal(offset, attempted + 1024);
    await downloadBlocks({ ...options, fetcher: async (url, init) => { resumeStart ??= Number(/^bytes=(\d+)-/.exec(init.headers.Range)[1]); return f.fetcher(url, init); } });
    assert.equal(resumeStart, offset);
    assert.deepEqual(await readFile(outputFile), f.next);
});

test('unsupported Range falls back to a verified full download, while 503 preserves the partial update', async t => {
    for (const status of [200, 503]) await t.test(String(status), async t => {
        const f = await fixture(t);
        await f.cacheBase();
        let full = 0;
        const updater = createUpdater({ currentVersion: '0.1.17', directory: f.directory, target: async () => targets[0], publicKey: f.publicKey, install: async () => {}, fetcher: async (url, init = {}) => {
            if (url === f.current.url && init.headers?.Range) return new Response(status === 200 ? f.next : 'unavailable', { status });
            if (url === f.current.url) full++;
            return f.fetcher(url, init);
        } });
        t.after(() => updater.close());
        await updater.check();
        assert.equal(updater.state().status, status === 200 ? 'ready' : 'error');
        assert.equal(full, status === 200 ? 1 : 0);
        if (status === 200) assert.deepEqual(await readFile(join(f.directory, 'ota', '0.1.18', f.current.file)), f.next);
    });
});

test('a damaged cached base cannot be used or installed', async t => {
    const f = await fixture(t);
    await f.cacheBase();
    await writeFile(join(f.directory, 'ota', '0.1.17', f.base.file), Buffer.alloc(f.original.length));
    let installed = false;
    const updater = createUpdater({ currentVersion: '0.1.17', directory: f.directory, target: async () => targets[0], publicKey: f.publicKey, fetcher: f.fetcher, install: async () => { installed = true; } });
    t.after(() => updater.close());
    await updater.check();
    assert.equal(updater.state().status, 'ready');
    assert.equal(updater.state().mode, 'full');
    await writeFile(join(f.directory, 'ota', '0.1.18', f.current.file), Buffer.alloc(f.next.length));
    await updater.apply();
    assert.equal(installed, false);
    assert.equal(updater.state().status, 'error');
});

test('a temporary blockmap error never starts a full installer download, and retry resumes incremental mode', async t => {
    const f = await fixture(t);
    await f.cacheBase();
    let unavailable = true;
    const updater = createUpdater({ currentVersion: '0.1.17', directory: f.directory, target: async () => targets[0], publicKey: f.publicKey, install: async () => {}, fetcher: async (url, init = {}) => {
        if (unavailable && url === f.current.blockmap.url) return new Response('unavailable', { status: 503 });
        return f.fetcher(url, init);
    } });
    t.after(() => updater.close());
    await updater.check();
    assert.equal(updater.state().status, 'error');
    assert.equal(f.requests.some(x => x.url === f.current.url), false);
    unavailable = false;
    await updater.check();
    assert.equal(updater.state().status, 'ready');
    assert.equal(updater.state().mode, 'delta');
    assert.deepEqual(await readFile(join(f.directory, 'ota', '0.1.18', f.current.file)), f.next);
});

test('blockmap parser rejects incomplete installers', async t => {
    const f = await fixture(t);
    await assert.rejects(readBlockmap(f.base.mapFile, f.base.size + 1), /分块索引/);
    const oldMap = await readBlockmap(f.base.mapFile, f.base.size), nextMap = await readBlockmap(f.current.mapFile, f.current.size);
    assert.equal(planBlocks(oldMap, nextMap, f.current.size).reused > 0, true);
});

test('build timestamps stay stable across resource copies without changing their bytes', async t => {
    const root = await mkdtemp(join(tmpdir(), 'comfy-timestamps-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const [name, date] of [['a', '2025-01-01'], ['b', '2026-01-01']]) {
        const directory = join(root, name);
        await mkdir(directory);
        await writeFile(join(directory, 'module.py'), 'unchanged module');
        await utimes(join(directory, 'module.py'), new Date(date), new Date(date));
        await normalizeDirectory(directory);
    }
    assert.equal((await stat(join(root, 'a/module.py'))).mtimeMs, (await stat(join(root, 'b/module.py'))).mtimeMs);
    assert.equal(await readFile(join(root, 'a/module.py'), 'utf8'), 'unchanged module');
});
