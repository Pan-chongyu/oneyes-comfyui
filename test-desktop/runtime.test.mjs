import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { bundledPython, createRuntime } = createRequire(import.meta.url)('../desktop/runtime.cjs');

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
