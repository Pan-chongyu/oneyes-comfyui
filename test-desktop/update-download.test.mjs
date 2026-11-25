import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { downloadRanges, CHUNK_SIZE, CONNECTIONS } = require('../desktop/update-download.cjs');
const { createUpdater, validateFile } = require('../desktop/updater.cjs');
const { downloadBlocks } = require('../desktop/update-blockmap.cjs');
const { filename, platformKey, FEED, RELEASE_ROOT } = require('../desktop/update-policy.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = Buffer.alloc(CHUNK_SIZE * 5 + 321);
for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + Math.floor(i / CHUNK_SIZE)) % 251;

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'comfy-ranges-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const target = { platform: 'win32', arch: 'x64', format: 'nsis' }, version = '0.1.24';
    const file = filename(version, target.platform, target.arch, target.format);
    const entry = { file, url: `${RELEASE_ROOT}/download/oneyes-v${version}/${file}`, size: bytes.length, sha256: hash(bytes) };
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const text = JSON.stringify({ schema: 1, version, notes: '', platforms: { [platformKey(target)]: entry } });
    const signature = sign(null, Buffer.from(text), privateKey).toString('base64');
    const outputFile = join(directory, 'installer.part');
    function reply(init, data = bytes) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
        assert.ok(match);
        const start = Number(match[1]), end = Number(match[2]);
        return new Response(data.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}`, etag: '"signed-installer"' } });
    }
    function updater(fetcher, other = {}) {
        const updater = createUpdater({ currentVersion: '0.1.23', directory, target: async () => target, publicKey, install: async () => {}, ...other, fetcher: async (url, init) => {
            if (url === FEED || url === FEED + '.sig') return new Response(url === FEED ? text : signature);
            assert.equal(url, entry.url);
            return fetcher(init);
        } });
        t.after(() => updater.close());
        return updater;
    }
    return { directory, entry, outputFile, reply, updater, text, signature };
}

test('real HTTP ranges run in parallel, finish out of order and reconstruct the signed full installer', async t => {
    const f = await fixture(t), waiting = [], ranges = [], completed = [], events = [];
    let active = 0, peak = 0;
    const server = createServer((request, response) => {
        const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range);
        assert.ok(match, 'Every data request is a bounded range');
        const start = Number(match[1]), end = Number(match[2]);
        ranges.push({ start, end }); active++; peak = Math.max(peak, active);
        const finish = () => {
            response.writeHead(206, { 'content-range': `bytes ${start}-${end}/${bytes.length}`, etag: '"signed-installer"' });
            response.end(bytes.subarray(start, end + 1)); completed.push(start); active--;
        };
        if (ranges.length === 1) finish();
        else {
            waiting.push(finish);
            if (waiting.length === CONNECTIONS || ranges.length === Math.ceil(bytes.length / CHUNK_SIZE)) waiting.splice(0).reverse().forEach(done => done());
        }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    await downloadRanges({ entry: { ...f.entry, url: `http://127.0.0.1:${server.address().port}/installer` }, outputFile: f.outputFile, fetcher: fetch, changed: state => events.push(state) });
    assert.equal(peak, CONNECTIONS);
    assert.notDeepEqual(completed, ranges.map(range => range.start), 'Completion order must differ from request order');
    assert.equal(ranges.length, Math.ceil(bytes.length / CHUNK_SIZE));
    assert.ok(ranges.every(({ start, end }) => end - start + 1 <= CHUNK_SIZE));
    await validateFile(f.outputFile, f.entry);
    assert.equal(events.at(-1).downloaded, bytes.length);
    assert.equal(events.at(-1).chunks, ranges.length);
    assert.equal(events.at(-1).completedChunks, ranges.length);
    assert.ok(events.every((state, i) => !i || state.downloaded >= events[i - 1].downloaded));
});

test('restart trusts per-range receipts rather than sparse file length, and resumes each partial chunk', async t => {
    const f = await fixture(t), reached = Promise.withResolvers(), release = Promise.withResolvers();
    let started = 0;
    await assert.rejects(downloadRanges({ ...f, fetcher: async (_url, init) => {
        const start = Number(/^bytes=(\d+)-/.exec(init.headers.Range)[1]);
        if (!start) return f.reply(init);
        started++;
        if (started === CONNECTIONS) reached.resolve();
        if (start === CHUNK_SIZE) {
            await reached.promise; await release.promise;
            return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(start, start + 1234)); }, pull(controller) { controller.error(new Error('offline')); } }), { status: 206, headers: { 'content-range': `bytes ${init.headers.Range.slice(6)}/${bytes.length}`, etag: '"signed-installer"' } });
        }
        const result = f.reply(init);
        // Wait until the other two workers have made their ranges durable.
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(start, start + CHUNK_SIZE)); controller.close(); }, cancel() {} }), { status: 206, headers: result.headers });
    }, changed: state => { if (state.completedChunks >= 3) release.resolve(); } }), error => error.resumableDownload === true);
    const saved = JSON.parse(await readFile(f.outputFile + '.json', 'utf8'));
    assert.equal(saved.offsets[1], 1234);
    assert.equal(saved.offsets[2], CHUNK_SIZE);
    assert.equal(saved.offsets[3], CHUNK_SIZE);
    assert.ok((await stat(f.outputFile)).size > CHUNK_SIZE * 3, 'File length includes completed later ranges');
    const requested = [];
    await downloadRanges({ ...f, fetcher: async (_url, init) => { requested.push(init.headers.Range); return f.reply(init); } });
    assert.equal(requested[0], `bytes=${CHUNK_SIZE + 1234}-${CHUNK_SIZE * 2 - 1}`);
    assert.ok(!requested.some(range => range.startsWith(`bytes=${CHUNK_SIZE * 2}-`) || range.startsWith(`bytes=${CHUNK_SIZE * 3}-`)));
    await validateFile(f.outputFile, f.entry);
});

test('full updater preserves interrupted ranges across process recreation and installs only verified bytes', async t => {
    const f = await fixture(t);
    const first = f.updater(init => {
        if (init.headers.Range === `bytes=0-${CHUNK_SIZE - 1}`) return f.reply(init);
        return new Response('temporarily unavailable', { status: 503 });
    });
    await first.check();
    assert.equal(first.state().status, 'error');
    assert.equal(first.state().mode, 'full');
    first.close();
    const requests = [], installed = [];
    const second = f.updater(init => { requests.push(init.headers.Range); return f.reply(init); }, { install: async plan => installed.push(plan) });
    await second.check();
    assert.equal(second.state().status, 'ready', second.state().error);
    assert.ok(requests.every(range => range && !range.startsWith('bytes=0-')));
    assert.equal(second.state().completedChunks, Math.ceil(bytes.length / CHUNK_SIZE));
    await second.apply();
    assert.equal(installed.length, 1);
    await validateFile(installed[0].file, f.entry);
});

test('confirmed quit waits for durable range progress before the process is allowed to exit', async t => {
    const f = await fixture(t), blocked = Promise.withResolvers();
    const updater = f.updater(init => {
        if (init.headers.Range === `bytes=0-${CHUNK_SIZE - 1}`) return f.reply(init);
        blocked.resolve();
        return new Promise((_resolve, reject) => {
            const abort = () => reject(init.signal.reason);
            if (init.signal.aborted) abort(); else init.signal.addEventListener('abort', abort, { once: true });
        });
    });
    const download = updater.check();
    await blocked.promise;
    await updater.close(); await download;
    const receipt = JSON.parse(await readFile(join(f.directory, 'ota', '0.1.24', f.entry.file + '.part.json'), 'utf8'));
    assert.equal(receipt.schema, 1);
    assert.equal(receipt.offsets[0], CHUNK_SIZE);
    const requested = [];
    const restored = f.updater(init => { requested.push(init.headers.Range); return f.reply(init); });
    await restored.check();
    assert.equal(restored.state().status, 'ready', restored.state().error);
    assert.ok(requested.every(range => range && !range.startsWith('bytes=0-')));
});

test('incremental copies and parallel changed ranges share one exact output with bounded requests', async t => {
    const f = await fixture(t), baseBytes = bytes.subarray(0, CHUNK_SIZE * 2), chunks = [];
    for (const fill of [61, 62, 63, 64]) chunks.push(Buffer.alloc(CHUNK_SIZE, fill));
    const source = [baseBytes.subarray(CHUNK_SIZE), ...chunks.slice(0, 2), baseBytes.subarray(0, CHUNK_SIZE), ...chunks.slice(2)];
    const current = Buffer.concat(source), baseFile = join(f.directory, 'base.exe'), oldMapFile = baseFile + '.blockmap', newMapFile = f.outputFile + '.blockmap';
    const map = parts => gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, sizes: parts.map(part => part.length), checksums: parts.map(hash) }] }));
    const oldMap = map([baseBytes.subarray(0, CHUNK_SIZE), baseBytes.subarray(CHUNK_SIZE)]), newMap = map(source);
    await writeFile(baseFile, baseBytes); await writeFile(oldMapFile, oldMap); await writeFile(newMapFile, newMap);
    const base = { size: baseBytes.length, sha256: hash(baseBytes), blockmap: { sha256: hash(oldMap) } };
    const entry = { ...f.entry, size: current.length, sha256: hash(current), blockmap: { sha256: hash(newMap) } };
    const requests = [], waiting = [], events = [];
    let active = 0, peak = 0;
    await downloadBlocks({ baseFile, oldMapFile, newMapFile, base, entry, outputFile: f.outputFile, changed: state => events.push(state), fetcher: async (_url, init) => {
        const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range), start = Number(match[1]), end = Number(match[2]);
        requests.push(start); active++; peak = Math.max(peak, active);
        const reply = () => { active--; return new Response(current.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${current.length}` } }); };
        if (requests.length === 1) return reply();
        return new Promise(resolve => { waiting.push(() => resolve(reply())); if (waiting.length === CONNECTIONS) waiting.splice(0).reverse().forEach(done => done()); });
    } });
    assert.equal(peak, CONNECTIONS);
    assert.deepEqual(requests.sort((a, b) => a - b), [CHUNK_SIZE, CHUNK_SIZE * 2, CHUNK_SIZE * 4, CHUNK_SIZE * 5]);
    await validateFile(f.outputFile, entry);
    assert.equal(events.at(-1).downloaded, CHUNK_SIZE * 4);
    assert.equal(events.at(-1).reused, CHUNK_SIZE * 2);
    assert.equal(events.at(-1).mode, 'delta');
});

test('ignored or malformed ranges fall back once, while a partial sequential fallback can also resume', async t => {
    for (const malformed of [false, true]) await t.test(String(malformed), async t => {
        const f = await fixture(t), requests = [];
        let interrupted = true;
        const updater = f.updater(init => {
            requests.push(init.headers.Range || 'full');
            if (/^bytes=\d+-\d+$/.test(init.headers.Range || '')) return malformed ? new Response(bytes.subarray(0, 1024), { status: 206, headers: { 'content-range': `bytes 1-1024/${bytes.length}` } }) : new Response(bytes);
            if (init.headers.Range) {
                const start = Number(/^bytes=(\d+)-$/.exec(init.headers.Range)[1]);
                return new Response(bytes.subarray(start), { status: 206, headers: { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } });
            }
            if (interrupted) return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 1234)); }, pull(controller) { controller.error(new Error('offline')); } }));
            return new Response(bytes);
        });
        await updater.check();
        assert.equal(updater.state().status, 'error');
        interrupted = false;
        await updater.check();
        assert.equal(updater.state().status, 'ready', updater.state().error);
        assert.deepEqual(requests, [`bytes=0-${CHUNK_SIZE - 1}`, 'full', 'bytes=1234-']);
        await validateFile(join(f.directory, 'ota', '0.1.24', f.entry.file), f.entry);
    });
});

test('abort cancels peers and keeps ranges; mismatched package bytes can never reach install', async t => {
    const f = await fixture(t), controller = new AbortController();
    await assert.rejects(downloadRanges({ ...f, signal: controller.signal, fetcher: async (_url, init) => f.reply(init), changed: state => { if (state.completedChunks === 1) controller.abort(); } }), { name: 'AbortError' });
    const saved = JSON.parse(await readFile(f.outputFile + '.json', 'utf8'));
    assert.equal(saved.offsets[0], CHUNK_SIZE);
    await downloadRanges({ ...f, fetcher: async (_url, init) => f.reply(init) });
    await validateFile(f.outputFile, f.entry);
    let installed = false;
    const updater = f.updater(init => f.reply(init, Buffer.alloc(bytes.length)), { install: async () => { installed = true; } });
    await updater.check(); await updater.apply();
    assert.equal(updater.state().status, 'error');
    assert.match(updater.state().error, /校验失败/);
    assert.equal(installed, false);
    await assert.rejects(stat(join(f.directory, 'ota', '0.1.24', f.entry.file + '.part')), { code: 'ENOENT' });
});

test('legacy serial partial files migrate into per-range progress without redownloading the prefix', async t => {
    const f = await fixture(t), folder = join(f.directory, 'ota', '0.1.24'), prefix = CHUNK_SIZE + 4321;
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, f.entry.file + '.part'), bytes.subarray(0, prefix));
    await writeFile(join(folder, f.entry.file + '.part.json'), JSON.stringify({ url: f.entry.url, size: bytes.length, sha256: f.entry.sha256, validator: '"signed-installer"' }));
    await writeFile(join(folder, 'comfy-latest.json'), f.text);
    await writeFile(join(folder, 'comfy-latest.json.sig'), f.signature);
    const requested = [];
    const updater = f.updater(init => { requested.push(init.headers.Range); return f.reply(init); });
    await updater.check();
    assert.equal(updater.state().status, 'ready', updater.state().error);
    assert.equal(requested[0], `bytes=${prefix}-${CHUNK_SIZE * 2 - 1}`);
    await validateFile(join(folder, f.entry.file), f.entry);
});
