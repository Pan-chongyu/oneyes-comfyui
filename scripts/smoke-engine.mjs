import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url), { createRuntime } = require('../desktop/runtime.cjs');
const directory = process.env.ONEYES_SMOKE_DIR || await mkdtemp(path.join(os.tmpdir(), 'oneyes-comfy-smoke-'));
const runtime = createRuntime({ resources: path.resolve('desktop'), directory, changed: state => console.log(JSON.stringify({ status: state.status, phase: state.phase, message: state.message })) });
try {
    await runtime.launch();
    const origin = runtime.state().url;
    const nodes = await fetch(origin + '/object_info').then(r => r.json());
    for (const name of ['OneYesImage', 'OneYesImageEdit', 'OneYesRecoverImage', 'OneYesText', 'KSampler', 'SaveImage', 'LoadImage']) assert.ok(nodes[name], `Missing actual ComfyUI node ${name}`);
    const denied = await fetch(origin + '/oneyes/settings'); assert.equal(denied.status, 403);
    const headers = { 'X-OneYes-Session': runtime.token() };
    const status = await fetch(origin + '/oneyes/settings', { headers }).then(r => r.json()); assert.equal(status.configured.default, false);
    const saved = await fetch(origin + '/oneyes/settings', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ default: 'test-only-do-not-call' }) }); assert.equal(saved.status, 200);
    const tasks = await fetch(origin + '/oneyes/tasks', { headers }).then(r => r.json()); assert.deepEqual(tasks.tasks, []);
    const graph = { prompt: { 1: { class_type: 'StringConcatenate', inputs: { string_a: 'OneYes ', string_b: 'ComfyUI', delimiter: '' } }, 2: { class_type: 'PreviewAny', inputs: { source: ['1', 0] } } } };
    const submitted = await fetch(origin + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(graph) }).then(r => r.json());
    assert.ok(submitted.prompt_id, JSON.stringify(submitted));
    let history;
    while (!history?.[submitted.prompt_id]) { await new Promise(resolve => setTimeout(resolve, 250)); history = await fetch(origin + '/history/' + submitted.prompt_id).then(r => r.json()); }
    assert.equal(history[submitted.prompt_id].status.status_str, 'success');
    console.log(JSON.stringify({ engine: 'ComfyUI', oneYesNodes: 4, localGraph: 'success', localAuth: 'verified', native: process.platform + '-' + process.arch }));
    await writeFile(path.resolve('desktop-smoke-result.json'), JSON.stringify({ nodes: 4, localGraph: 'success', platform: process.platform, arch: process.arch }));
} finally {
    await runtime.stop();
    if (!process.env.ONEYES_SMOKE_DIR) await rm(directory, { recursive: true, force: true });
}
