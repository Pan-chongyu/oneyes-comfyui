import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url), { createRuntime } = require('../desktop/runtime.cjs');
const directory = process.env.ONEYES_SMOKE_DIR || await mkdtemp(path.join(os.tmpdir(), 'oneyes-comfy-smoke-'));
const fixture = path.join(directory, 'comfy/custom_nodes/oneyes_test_transport');
await mkdir(fixture, { recursive: true });
// The fake transport lives exclusively in the disposable test profile, never in the shipped engine.
await writeFile(path.join(fixture, '__init__.py'), `
import base64
from io import BytesIO
from PIL import Image
from oneyes.routes import client
buffer = BytesIO()
Image.new('RGB', (17, 23), 'blue').save(buffer, 'PNG')
encoded = base64.b64encode(buffer.getvalue()).decode()
async def request(origin, path, key, payload=None, multipart=None):
    assert key == 'test-only-do-not-call'
    if path == '/models': return {'data': [{'id': 'test-image'}, {'id': 'test-text'}]}, 1
    if path == '/chat/completions': return {'choices': [{'message': {'content': 'OneYes local test'}}]}, 1
    if path.endswith('/async'): return {'task_id': 'test-receipt', 'status': 'processing'}, 1
    assert path == '/images/tasks/test-receipt'
    return {'task_id': 'test-receipt', 'status': 'completed', 'result': {'data': [{'b64_json': encoded}]}}, 1
client.request = request
NODE_CLASS_MAPPINGS = {}
`);
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
    const image = { class_type: 'OneYesImage', inputs: { model: 'test-image', prompt: 'test', size: 'auto', quality: 'auto', seed: 1 } };
    async function execute(prompt) {
        const reply = await fetch(origin + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) }).then(r => r.json());
        assert.ok(reply.prompt_id, JSON.stringify(reply));
        let result;
        while (!result?.[reply.prompt_id]) { await new Promise(resolve => setTimeout(resolve, 250)); result = await fetch(origin + '/history/' + reply.prompt_id).then(r => r.json()); }
        assert.equal(result[reply.prompt_id].status.status_str, 'success', JSON.stringify(result[reply.prompt_id].status));
        return result[reply.prompt_id];
    }
    await execute({ 1: image, 2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'OneYes-test-image' } } });
    const { tasks: [task] } = await fetch(origin + '/oneyes/tasks', { headers }).then(r => r.json());
    assert.equal(task.status, 'completed');
    await execute({ 1: { class_type: 'OneYesRecoverImage', inputs: { task_id: task.id } }, 2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'OneYes-test-recover' } } });
    await execute({ 1: image, 2: { class_type: 'OneYesImageEdit', inputs: { ...image.inputs, images: ['1', 0], seed: 2 } }, 3: { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'OneYes-test-edit' } } });
    await execute({ 1: { class_type: 'OneYesText', inputs: { model: 'test-text', prompt: 'test', system: '', temperature: 0.7 } }, 2: { class_type: 'PreviewAny', inputs: { source: ['1', 0] } } });
    console.log(JSON.stringify({ engine: 'ComfyUI', oneYesNodes: 4, oneYesGraphs: 'success with test-only transport; no paid requests', localGraph: 'success', localAuth: 'verified', native: process.platform + '-' + process.arch }));
    await writeFile(path.resolve('desktop-smoke-result.json'), JSON.stringify({ nodes: 4, oneYesGraphs: 'success', localGraph: 'success', platform: process.platform, arch: process.arch }));
} finally {
    await runtime.stop();
    if (!process.env.ONEYES_SMOKE_DIR) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
