import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { bundledPython, createRuntime } = createRequire(import.meta.url)('../desktop/runtime.cjs');
const { signingPaths } = createRequire(import.meta.url)('../scripts/sign-macos.cjs');

test('macOS signing selects nested Mach-O code and bundles, leaving Python bytecode and media as resources', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'comfy-sign-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(path.join(directory, 'Helper.app/Contents/MacOS'), { recursive: true });
    await mkdir(path.join(directory, 'python/lib'), { recursive: true });
    const native = path.join(directory, 'Helper.app/Contents/MacOS/Helper'), library = path.join(directory, 'python/lib/python.dylib');
    await writeFile(native, Buffer.from('cffaedfe00000000', 'hex'));
    await writeFile(library, Buffer.from('cafebabe00000002', 'hex'));
    await writeFile(path.join(directory, 'python/lib/module.pyc'), Buffer.from('cb0d0d0a00000000', 'hex'));
    await writeFile(path.join(directory, 'picture.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    const selected = await signingPaths(directory);
    assert.deepEqual(new Set(selected), new Set([native, library, path.join(directory, 'Helper.app')]));
    assert.ok(selected.indexOf(native) < selected.indexOf(path.join(directory, 'Helper.app')));
});

test('missing or mismatched bundles fail locally with a reinstall action, without downloading', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'comfy-bundle-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const runtime = createRuntime({ resources: directory, directory: path.join(directory, 'profile') });
    await assert.rejects(runtime.launch(), /重新下载安装/);
    assert.equal(runtime.state().status, 'error');
    const files = ['requirements.txt', 'oneyes/requirements.txt', 'oneyes/constraints.txt'];
    for (const file of files) { await mkdir(path.dirname(path.join(directory, 'engine', file)), { recursive: true }); await writeFile(path.join(directory, 'engine', file), 'test\n'); }
    const executable = process.platform === 'win32' ? 'python.exe' : 'bin/python3.12';
    await mkdir(path.dirname(path.join(directory, 'python', executable)), { recursive: true });
    await writeFile(path.join(directory, 'python', executable), 'fixture');
    const receipt = { schema: 1, platform: process.platform, arch: process.arch, python: executable, requirements: createHash('sha256').update('test\ntest\ntest\n').digest('hex') };
    const write = value => writeFile(path.join(directory, 'python/oneyes-runtime.json'), JSON.stringify(value));
    await write(receipt);
    assert.equal(await bundledPython(directory), path.join(directory, 'python', executable));
    await write({ ...receipt, python: '../outside/python' });
    await assert.rejects(bundledPython(directory), /不完整/);
    await write({ ...receipt, arch: 'unsupported' });
    await assert.rejects(bundledPython(directory), /不完整/);
    await write(receipt);
    await writeFile(path.join(directory, 'engine/requirements.txt'), 'changed');
    await assert.rejects(bundledPython(directory), /不完整/);
    await runtime.stop();
});

test('quitting during extension setup finishes startup without spawning an orphan engine', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'comfy-cancel-startup-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = process.platform === 'win32' ? 'python.exe' : 'bin/python3.12';
    for (const file of ['engine/requirements.txt', 'engine/oneyes/requirements.txt', 'engine/oneyes/constraints.txt', 'engine/oneyes/custom_node.py', 'python/' + executable]) {
        await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
        await writeFile(path.join(directory, file), '');
    }
    await writeFile(path.join(directory, 'python/oneyes-runtime.json'), JSON.stringify({ schema: 1, platform: process.platform, arch: process.arch, python: executable, requirements: createHash('sha256').update('').digest('hex') }));
    const copying = Promise.withResolvers(), resume = Promise.withResolvers();
    t.mock.method(fs, 'cp', async () => { copying.resolve(); await resume.promise; });
    const states = [];
    const runtime = createRuntime({ resources: directory, directory: path.join(directory, 'profile'), changed: state => states.push(state.status) });
    const launching = runtime.launch();
    await copying.promise;
    const stopping = runtime.stop();
    resume.resolve();
    await Promise.all([launching, stopping]);
    assert.equal(runtime.state().status, 'idle');
    assert.ok(!states.includes('ready') && !states.includes('error'));
});
