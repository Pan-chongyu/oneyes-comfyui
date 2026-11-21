import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const { bundledPython } = createRequire(import.meta.url)('../desktop/runtime.cjs');

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
let resources, bundle;
if (process.platform === 'darwin') {
    const folder = (await readdir('dist')).find(value => value === 'mac-arm64');
    assert.ok(folder, 'Missing ARM64 package');
    bundle = path.resolve('dist', folder, 'OneYes ComfyUI.app');
    const plist = path.join(bundle, 'Contents/Info.plist');
    const value = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
    assert.equal(value('CFBundleIdentifier'), 'ai.oneyes.comfyui');
    assert.equal(value('CFBundleExecutable'), 'OneYes ComfyUI');
    assert.equal(value('CFBundleShortVersionString'), version);
    resources = path.join(bundle, 'Contents/Resources');
} else if (process.platform === 'win32') {
    await access('dist/win-unpacked/OneYes ComfyUI.exe');
    resources = path.resolve('dist/win-unpacked/resources');
} else {
    const folder = process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked';
    await access(`dist/${folder}/oneyes-comfyui`);
    resources = path.resolve(`dist/${folder}/resources`);
}
await access(path.join(resources, 'engine/oneyes/extension.py'));
const frontend = JSON.parse(await readFile(path.join(resources, 'frontend/oneyes-frontend.json'), 'utf8'));
assert.equal(frontend.nativeUserPanel, true);
assert.equal(frontend.oneYesAccountButton, true);
assert.match(await readFile(path.join(resources, 'frontend/assets', frontend.authModule), 'utf8'), /openSettings\('account'\)/);
await access(path.join(resources, 'frontend/oneyes-account-button.js'));
assert.match(await readFile(path.join(resources, 'frontend/assets', frontend.userPanel), 'utf8'), /mountAccountPanel/);
await access(path.join(resources, 'engine/oneyes/web/account-panel.html'));
const python = await bundledPython(resources);
const result = JSON.parse(execFileSync(python, ['-I', '-B', '-c', 'import sys,json,torch,torchvision,aiohttp,cryptography,comfyui_frontend_package; print(json.dumps({"prefix":sys.prefix,"torch":torch.__file__,"tensor":int(torch.ones(2).sum().item())}))'], { encoding: 'utf8', windowsHide: true }));
assert.equal(path.resolve(result.prefix), path.join(resources, 'python'));
assert.ok(result.torch.startsWith(path.join(resources, 'python') + path.sep));
assert.equal(result.tensor, 2);
if (process.platform === 'win32') for (const file of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) await access(path.join(resources, 'python', file));
if (bundle) execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
console.log(JSON.stringify({ package: 'OneYes ComfyUI', version, platform: process.platform, arch: process.arch, identity: 'verified', bundledRuntime: 'verified' }));
