import { cp, readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const root = process.cwd(), prefix = path.join(root, 'desktop/python');
const python = path.join(prefix, process.platform === 'win32' ? 'python.exe' : 'bin/python3.12');
const frontend = JSON.parse(execFileSync(python, ['-I', '-c', 'import pathlib,json,importlib.metadata,comfyui_frontend_package;print(json.dumps({"source":str(pathlib.Path(comfyui_frontend_package.__file__).parent/"static"),"version":importlib.metadata.version("comfyui-frontend-package")}))'], { encoding: 'utf8', windowsHide: true }));
assert.equal(frontend.version, '1.59.10', 'Review the OneYes user panel before upgrading the frontend');
const source = frontend.source;
assert.ok(source.startsWith(prefix + path.sep), 'Frontend must come from the bundled Python distribution');
const destination = path.join(root, 'desktop/frontend');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, filter: file => !file.endsWith('.map') });
const assets = path.join(destination, 'assets'), files = await readdir(assets);
const user = files.filter(file => /^UserPanel-[^.]+\.js$/.test(file));
const vue = files.find(file => /^vendor-vue-core-[^.]+\.js$/.test(file));
const dialog = files.find(file => /^dialogService-[^.]+\.js$/.test(file));
assert.equal(user.length, 1, 'Pinned frontend user panel has changed; review the integration before publishing');
assert.ok(vue && dialog);
const vueSource = await readFile(path.join(assets, vue), 'utf8'), dialogSource = await readFile(path.join(assets, dialog), 'utf8');
const h = vueSource.match(/\bh as (\w+)/)?.[1], settings = dialogSource.match(/\buseSettingsDialog as (\w+)/)?.[1];
assert.ok(h && settings, 'Pinned frontend exports have changed');
await writeFile(path.join(assets, user[0]), `import {${h} as h} from './${vue}';
export default {
    name: 'OneYesUserPanel',
    render() { return h('div', { ref: 'host', class: 'oneyes-user-settings' }); },
    async mounted() {
        const host = this.$refs.host;
        try {
            const { mountAccountPanel } = await import('/extensions/oneyes/account-panel.js');
            if (host.isConnected) this.disposeOneYes = await mountAccountPanel(host);
            if (!host.isConnected) this.disposeOneYes?.();
        } catch { host.textContent = 'OneYes 设置加载失败，请关闭设置后重新打开。'; }
    },
    beforeUnmount() { this.disposeOneYes?.(); }
};\n`);
await writeFile(path.join(destination, 'oneyes-native.js'), `import {${settings} as useSettingsDialog} from './assets/${dialog}';
export let section = 'account';
export function openSettings(value = 'account') {
    section = ['account', 'models', 'tasks', 'updates'].includes(value) ? value : 'account';
    useSettingsDialog().show('user');
    window.dispatchEvent(new CustomEvent('oneyes:panel', { detail: section }));
}\n`);
await writeFile(path.join(destination, 'oneyes-frontend.json'), JSON.stringify({ schema: 1, frontendVersion: frontend.version, userPanel: user[0], nativeUserPanel: true }, null, 2) + '\n');
console.log('Prepared ComfyUI frontend with an integrated OneYes user panel');
