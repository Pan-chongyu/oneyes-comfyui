import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, mkdir, rename, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url), { createRuntime } = require('../desktop/runtime.cjs');
const directory = process.env.ONEYES_SMOKE_DIR || await mkdtemp(path.join(os.tmpdir(), 'oneyes-comfy-smoke-'));
await mkdir('.runtime', { recursive: true });
const packaged = process.env.ONEYES_SMOKE_RESOURCES;
const resources = packaged ? path.resolve(packaged) : await mkdtemp(path.join(path.resolve('.runtime'), '离线 安装-'));
const moved = [];
// Relocate the distribution, including native libraries, just as a user installation does.
// No uv binary or system virtualenv is available at the installed resources path.
const originalResources = path.resolve('desktop');
process.env.UV_OFFLINE = process.env.HF_HUB_OFFLINE = process.env.TRANSFORMERS_OFFLINE = '1';
process.env.HTTP_PROXY = process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
process.env.NO_PROXY = '127.0.0.1,localhost,::1';
process.env.PYTHONHOME = process.env.PYTHONPATH = process.env.VIRTUAL_ENV = path.join(directory, 'not-a-python');
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
    if path == '/models': return {'data': [{'id': value} for value in ['test-image', 'test-text', 'gpt-image-2', 'gpt-6.1-sol', 'claude-opus-4-6']]}, 1
    if path == '/chat/completions': return {'choices': [{'message': {'content': 'OneYes local test'}}]}, 1
    if path == '/responses': return {'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': 'Native OpenAI workflow'}]}]}, 1
    if path == '/messages': return {'content': [{'type': 'text', 'text': 'Native Claude workflow'}]}, 1
    if path.endswith('/async'): return {'task_id': 'test-receipt', 'status': 'processing'}, 1
    assert path == '/images/tasks/test-receipt'
    return {'task_id': 'test-receipt', 'status': 'completed', 'result': {'data': [{'b64_json': encoded}]}}, 1
client.request = request
NODE_CLASS_MAPPINGS = {}
`);
await writeFile(path.join(fixture, 'native_cloud.py'), await readFile('test-desktop/fixtures/native-cloud.py'));
await writeFile(path.join(fixture, 'builtin_nodes.py'), await readFile('test-desktop/fixtures/builtin-nodes.py'));
await writeFile(path.join(fixture, 'elevenlabs.py'), await readFile('test-desktop/fixtures/elevenlabs.py'));
await writeFile(path.join(fixture, '__init__.py'), (await readFile(path.join(fixture, '__init__.py'), 'utf8')) + '\nfrom . import native_cloud, builtin_nodes, elevenlabs\n');
const runtime = createRuntime({ resources, directory, changed: state => console.log(JSON.stringify({ status: state.status, phase: state.phase, message: state.message })) });
try {
    if (!packaged) for (const name of ['python', 'engine', 'frontend']) { await rename(path.join(originalResources, name), path.join(resources, name)); moved.push(name); }
    await runtime.launch();
    const origin = runtime.state().url;
    const page = await fetch(origin + '/');
    assert.equal(page.status, 200, 'Bundled frontend must be served offline');
    const html = await page.text(), script = html.match(/<script[^>]+src="([^"]+)"/);
    assert.ok(script, 'Bundled frontend entry is missing');
    const entry = new URL(script[1], origin);
    assert.equal(entry.origin, origin, 'Frontend must be loaded locally');
    assert.equal((await fetch(entry)).status, 200);
    const frontend = await fetch(origin + '/oneyes-frontend.json').then(r => r.json());
    assert.equal(frontend.nativeUserPanel, true);
    assert.equal(frontend.oneYesAccountButton, true);
    assert.match(await fetch(origin + '/assets/' + frontend.authModule).then(r => r.text()), /openSettings\('account'\)/);
    assert.equal((await fetch(origin + '/oneyes-account-button.js')).status, 200);
    assert.match(await fetch(origin + '/assets/' + frontend.userPanel).then(r => r.text()), /mountAccountPanel/);
    assert.match(await fetch(origin + '/oneyes-native.js').then(r => r.text()), /useSettingsDialog/);
    assert.equal((await fetch(origin + '/extensions/oneyes/account-panel.html')).status, 200);
    const nodes = await fetch(origin + '/object_info').then(r => r.json());
    for (const name of ['OneYesImage', 'OneYesImageEdit', 'OneYesRecoverImage', 'OneYesText', 'KSampler', 'SaveImage', 'LoadImage', 'ElevenLabsVoiceSelector', 'ElevenLabsTextToSpeech', 'ElevenLabsInstantVoiceClone']) assert.ok(nodes[name], `Missing actual ComfyUI node ${name}`);
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
    await execute({ 1: { class_type: 'ElevenLabsVoiceSelector', inputs: { voice: 'Roger (male, american)' } }, 2: { class_type: 'PreviewAny', inputs: { source: ['1', 0] } } });
    const image = { class_type: 'OneYesImage', inputs: { model: 'test-image', prompt: 'test', size: 'auto', quality: 'auto', seed: 1 } };
    async function execute(prompt, status = 'success') {
        const reply = await fetch(origin + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) }).then(r => r.json());
        assert.ok(reply.prompt_id, JSON.stringify(reply));
        let result;
        while (!result?.[reply.prompt_id]) { await new Promise(resolve => setTimeout(resolve, 250)); result = await fetch(origin + '/history/' + reply.prompt_id).then(r => r.json()); }
        assert.equal(result[reply.prompt_id].status.status_str, status, JSON.stringify(result[reply.prompt_id].status));
        return result[reply.prompt_id];
    }
    await execute({ 1: image, 2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'OneYes-test-image' } } });
    const { tasks: [task] } = await fetch(origin + '/oneyes/tasks', { headers }).then(r => r.json());
    assert.equal(task.status, 'completed');
    await execute({ 1: { class_type: 'OneYesRecoverImage', inputs: { task_id: task.id } }, 2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'OneYes-test-recover' } } });
    await execute({ 1: image, 2: { class_type: 'OneYesImageEdit', inputs: { ...image.inputs, images: ['1', 0], seed: 2 } }, 3: { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'OneYes-test-edit' } } });
    await execute({ 1: { class_type: 'OneYesText', inputs: { model: 'test-text', prompt: 'test', system: '', temperature: 0.7 } }, 2: { class_type: 'PreviewAny', inputs: { source: ['1', 0] } } });
    await execute({ 1: { class_type: 'OpenAIGPTImage1', inputs: { model: 'gpt-image-2', prompt: 'native original node', seed: 35, quality: 'high', background: 'transparent', n: 1, size: '1024x1024' } }, 2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'native-original-image' } } });
    await execute({ 1: { class_type: 'OpenAIChatNode', inputs: { model: 'gpt-6.1-sol', prompt: 'native workflow', persist_context: false } }, 2: { class_type: 'PreviewAny', inputs: { source: ['1', 0] } } });
    await execute({ 1: { class_type: 'ClaudeNode', inputs: { prompt: 'native workflow', model: 'Opus 4.6', 'model.max_tokens': 5000, 'model.reasoning_effort': 'off', 'model.temperature': 1, seed: 2, system_prompt: '' } }, 2: { class_type: 'PreviewAny', inputs: { source: ['1', 0] } } });
    const unavailable = await execute({ 1: { class_type: 'ElevenLabsVoiceSelector', inputs: { voice: 'Roger (male, american)' } }, 2: { class_type: 'ElevenLabsTextToSpeech', inputs: { voice: ['1', 0], text: 'test', stability: .5, apply_text_normalization: 'auto', model: 'eleven_multilingual_v2', 'model.speed': 1, 'model.similarity_boost': .75, 'model.use_speaker_boost': false, 'model.style': 0, language_code: '', seed: 1, output_format: 'mp3_44100_192' } }, 3: { class_type: 'PreviewAny', inputs: { source: ['2', 0] } } }, 'error');
    assert.match(JSON.stringify(unavailable.status.messages), /OneYes 当前尚未接入 ElevenLabs/);
    const native = await fetch(origin + '/oneyes-test/native');
    const verification = await native.text();
    assert.equal(native.status, 200, verification);
    assert.equal(JSON.parse(verification).nativeNodes, 19);
    const builtins = await fetch(origin + '/oneyes-test/builtins');
    const builtinVerification = await builtins.text();
    assert.equal(builtins.status, 200, builtinVerification);
    const builtinContracts = JSON.parse(builtinVerification);
    assert.equal(builtinContracts.offline, true);
    const elevenlabs = await fetch(origin + '/oneyes-test/elevenlabs');
    const elevenlabsVerification = await elevenlabs.text();
    assert.equal(elevenlabs.status, 200, elevenlabsVerification);
    const elevenlabsContracts = JSON.parse(elevenlabsVerification);
    assert.equal(elevenlabsContracts.registered.length, 8);
    console.log(JSON.stringify({ engine: 'ComfyUI', oneYesNodes: 23, elevenlabsContracts, nativeContracts: JSON.parse(verification), builtinContracts, oneYesGraphs: 'success with test-only transport; no paid requests', localGraph: 'success', localAuth: 'verified', native: process.platform + '-' + process.arch }));
    assert.ok(!(await readdir(directory)).some(name => ['runtime', 'python', 'uv-cache'].includes(name)), 'Fresh launch must not create/download a Python environment');
    await writeFile(path.resolve('desktop-smoke-result.json'), JSON.stringify({ nodes: 23, elevenlabsContracts, nativeContracts: JSON.parse(verification), builtinContracts, oneYesGraphs: 'success', localGraph: 'success', relocatedOfflineRuntime: true, platform: process.platform, arch: process.arch }));
} catch (error) {
    try { console.error(await readFile(path.join(directory, 'engine-error.log'), 'utf8')); } catch {}
    throw error;
} finally {
    await runtime.stop();
    for (const name of moved.reverse()) await rename(path.join(resources, name), path.join(originalResources, name));
    if (!packaged) await rm(resources, { recursive: true, force: true });
    if (!process.env.ONEYES_SMOKE_DIR) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
