import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat, access } from 'node:fs/promises';
import path from 'node:path';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
if (process.platform === 'darwin') {
    const folder = (await readdir('dist')).find(value => value === 'mac-arm64');
    assert.ok(folder, 'Missing ARM64 package');
    const bundle = path.resolve('dist', folder, 'OneYes ComfyUI.app');
    const plist = path.join(bundle, 'Contents/Info.plist');
    const value = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
    assert.equal(value('CFBundleIdentifier'), 'ai.oneyes.comfyui');
    assert.equal(value('CFBundleExecutable'), 'OneYes ComfyUI');
    assert.equal(value('CFBundleShortVersionString'), version);
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    await access(path.join(bundle, 'Contents/Resources/engine/oneyes/extension.py'));
    await access(path.join(bundle, 'Contents/Resources/bin/uv'));
} else if (process.platform === 'win32') {
    await access('dist/win-unpacked/OneYes ComfyUI.exe');
    await access('dist/win-unpacked/resources/bin/uv.exe');
    await access('dist/win-unpacked/resources/engine/oneyes/extension.py');
} else {
    const folder = process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked';
    await access(`dist/${folder}/oneyes-comfyui`);
    await access(`dist/${folder}/resources/bin/uv`);
    await access(`dist/${folder}/resources/engine/oneyes/extension.py`);
}
console.log(JSON.stringify({ package: 'OneYes ComfyUI', version, platform: process.platform, arch: process.arch, identity: 'verified' }));
