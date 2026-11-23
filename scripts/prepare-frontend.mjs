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
const about = files.filter(file => /^AboutPanel-[^.]+\.js$/.test(file));
const vue = files.find(file => /^vendor-vue-core-[^.]+\.js$/.test(file));
const dialog = files.find(file => /^dialogService-[^.]+\.js$/.test(file));
const graph = files.find(file => /^GraphView-[^.]+\.js$/.test(file));
const auth = files.filter(file => /^useAuthDialogs-[^.]+\.js$/.test(file));
assert.equal(user.length, 1, 'Pinned frontend user panel has changed; review the integration before publishing');
assert.equal(about.length, 1, 'Pinned frontend about panel has changed; review the update integration before publishing');
assert.ok(vue && dialog && graph);
assert.equal(auth.length, 1, 'Pinned frontend authentication module has changed');
const vueSource = await readFile(path.join(assets, vue), 'utf8'), dialogSource = await readFile(path.join(assets, dialog), 'utf8');
const h = vueSource.match(/\bh as (\w+)/)?.[1], nextTick = vueSource.match(/\bnextTick as (\w+)/)?.[1], settings = dialogSource.match(/\buseSettingsDialog as (\w+)/)?.[1];
assert.ok(h && nextTick && settings, 'Pinned frontend exports have changed');
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
await writeFile(path.join(assets, about[0]), `import {${h} as h} from './${vue}';
export default {
    name: 'OneYesAboutPanel',
    render() { return h('div', { ref: 'host', class: 'oneyes-about-settings' }); },
    async mounted() {
        const host = this.$refs.host;
        try {
            const { mountAboutPanel } = await import('/extensions/oneyes/about-panel.js');
            if (host.isConnected) this.disposeOneYes = await mountAboutPanel(host);
            if (!host.isConnected) this.disposeOneYes?.();
        } catch { host.textContent = '关于页面加载失败，请关闭设置后重新打开。'; }
    },
    beforeUnmount() { this.disposeOneYes?.(); }
};\n`);
await writeFile(path.join(destination, 'oneyes-native.js'), `import {${settings} as useSettingsDialog} from './assets/${dialog}';
import {${nextTick} as nextTick} from './assets/${vue}';
export {${h} as h} from './assets/${vue}';
export let section = 'account';
export async function openSettings(value = 'account') {
    section = ['account', 'models', 'tasks', 'updates'].includes(value) ? value : 'account';
    const panel = section === 'updates' ? 'about' : 'user';
    const settings = useSettingsDialog();
    if (!document.querySelector(panel === 'about' ? '.oneyes-about-settings' : '.oneyes-user-settings')) {
        settings.hide();
        await nextTick();
    }
    settings.show(panel);
    window.dispatchEvent(new CustomEvent('oneyes:panel', { detail: section }));
}\n`);
let graphSource = await readFile(path.join(assets, graph), 'utf8');
const components = [
    /(\w+)=\w+\(\{__name:`CurrentUserButton`,[\s\S]*?\}\}\)(?=,\w+=\{"data-testid":`login-button-popover`\})/g,
    /(\w+)=\w+\(\{__name:`LoginButton`,[\s\S]*?\}\}\)(?=,\w+=\{viewBox:`0 0 16 16`)/g,
];
for (const component of components) {
    assert.equal([...graphSource.matchAll(component)].length, 1, 'Review the native OneYes account button before publishing');
    graphSource = graphSource.replace(component, '$1=OneYesAccountButton');
}
await writeFile(path.join(assets, graph), `import OneYesAccountButton from '/oneyes-account-button.js';\n` + graphSource);
for (const extension of ['js', 'css']) await cp(path.join(root, 'desktop/frontend-src/account-button.' + extension), path.join(destination, 'oneyes-account-button.' + extension));
const authSource = await readFile(path.join(assets, auth[0]), 'utf8');
const authExport = authSource.match(/\buseAuthDialogs as (\w+)/)?.[1];
assert.ok(authExport, 'Pinned frontend authentication export has changed');
await writeFile(path.join(assets, auth[0]), `function useAuthDialogs() {
    async function showSignInDialog() {
        const { openSettings } = await import('/oneyes-native.js');
        openSettings('account');
        // OneYes authentication does not authorize Comfy Org API nodes.
        return false;
    }
    return {
        showSignInDialog,
        showApiNodesSignInDialog: showSignInDialog,
        showUpdatePasswordDialog: () => window.oneYesDesktop.openAccountPage('forgot-password'),
    };
}
export { useAuthDialogs as ${authExport} };\n`);
await writeFile(path.join(destination, 'oneyes-frontend.json'), JSON.stringify({ schema: 1, frontendVersion: frontend.version, userPanel: user[0], aboutPanel: about[0], nativeUserPanel: true, oneYesAccountButton: true, authModule: auth[0] }, null, 2) + '\n');
console.log('Prepared ComfyUI frontend with OneYes account settings and sign-in entry points');
