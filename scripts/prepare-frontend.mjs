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
let locale;
for (const file of files.filter(file => /^i18n-[^.]+\.js$/.test(file))) if ((await readFile(path.join(assets, file), 'utf8')).includes('function getDefaultLocale()')) {
    assert.equal(locale, undefined, 'Pinned frontend has multiple locale modules');
    locale = file;
}
assert.equal(user.length, 1, 'Pinned frontend user panel has changed; review the integration before publishing');
assert.equal(about.length, 1, 'Pinned frontend about panel has changed; review the update integration before publishing');
assert.ok(vue && dialog && graph);
assert.equal(auth.length, 1, 'Pinned frontend authentication module has changed');
assert.ok(locale, 'Pinned frontend locale module has changed');
let localeSource = await readFile(path.join(assets, locale), 'utf8');
assert.ok(localeSource.includes('function getDefaultLocale(){return resolveSupportedLocale(navigator.languages)}'), 'Review the default language before upgrading the frontend');
localeSource = localeSource.replace('function getDefaultLocale(){return resolveSupportedLocale(navigator.languages)}', 'function getDefaultLocale(){return`zh`}');
assert.ok(localeSource.includes('await loadLocale(n),y.global.locale.value=n,n'), 'Review language switching before upgrading the frontend');
await writeFile(path.join(assets, locale), localeSource.replace('await loadLocale(n),y.global.locale.value=n,n', 'await loadLocale(n),document.documentElement.lang=n===`zh`?`zh-CN`:n,y.global.locale.value=n,n'));
const setLocale = localeSource.match(/\bsetActiveLocale as (\w+)/)?.[1];
assert.ok(setLocale, 'Pinned frontend language loader export has changed');
const workflows = files.find(file => /^workflowStore-[^.]+\.js$/.test(file));
assert.ok(workflows, 'Pinned frontend workflow store has changed');
const workflowSource = await readFile(path.join(assets, workflows), 'utf8');
assert.equal([...workflowSource.matchAll(/`Unsaved Workflow\.json`/g)].length, 2, 'Review default workflow naming before upgrading the frontend');
await writeFile(path.join(assets, workflows), `import {d as oneYesTranslate} from './${locale}';\n` + workflowSource.replaceAll('`Unsaved Workflow.json`', '(oneYesTranslate("g.untitled")+".json")'));
const htmlFile = path.join(destination, 'index.html');
const html = await readFile(htmlFile, 'utf8');
assert.ok(html.includes('<html lang="en">') && html.includes('aria-label="Loading ComfyUI"'), 'Review the frontend startup translation before upgrading');
await writeFile(htmlFile, html.replace('<html lang="en">', '<html lang="zh-CN">').replace('aria-label="Loading ComfyUI"', 'aria-label="正在加载 OneYes ComfyUI"').replace('<title>ComfyUI</title>', '<title>OneYes ComfyUI</title>'));
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
export {${setLocale} as setLocale} from './assets/${locale}';
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
