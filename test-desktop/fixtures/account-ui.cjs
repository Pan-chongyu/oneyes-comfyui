const { app, BrowserWindow, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-account-ui-'));
app.setPath('userData', directory);
app.disableHardwareAcceleration();
// Keep this test independent of an installed copy running under the same user.
app.requestSingleInstanceLock = () => true;
const modelFixture = path.join(directory, 'comfy/custom_nodes/oneyes_test_models');
fs.mkdirSync(modelFixture, { recursive: true });
fs.writeFileSync(path.join(modelFixture, '__init__.py'), `
from oneyes.routes import client
async def request(origin, path, key, payload=None, multipart=None):
    assert path == '/models' and payload is None and multipart is None
    return {'data': [{'id':'gpt-6.2-sol'}, {'id':'gpt-image-2.5'}, {'id':'claude-opus-4-6'}]}, 1
client.request = request
NODE_CLASS_MAPPINGS = {}
`);
console.log('Starting isolated account UI test.');
const openedPages = [];
shell.openExternal = async url => { openedPages.push(url); };
const runtime = require('../../desktop/runtime.cjs'), createRuntime = runtime.createRuntime;
runtime.createRuntime = options => createRuntime({ ...options, changed: state => {
    options.changed(state);
    if (state.status === 'error') { console.error('Engine startup failed:', state.message); app.quit(); }
} });
const service = require('../../desktop/account.cjs'), createAccount = service.createAccount;
let shared = false, identity = 17, passed = false;
const rendererErrors = [];
const user = () => ({ id: identity, email: 'creator@example.test', username: '创作者', balance: 12.34 });
const groups = [{ id: 5, name: 'SVIP', platform: 'OpenAI' }, { id: 6, name: 'DeepSeek', platform: 'DeepSeek' }];
const keys = [{ id: 8, name: '图片工作流', group_id: 5, group: groups[0], key: 'sk-image-test-secret', status: 'active' }, { id: 9, name: '文字工作流', group_id: 6, group: groups[1], key: 'sk-text-test-secret', status: 'active' }];
const json = data => Promise.resolve(new Response(JSON.stringify({ code: 0, data })));
service.createAccount = options => createAccount({ ...options,
    fetcher: (url, init) => {
        const route = new URL(url).pathname.replace('/api/v1', '');
        if (route === '/settings/public') return json({});
        if (route === '/auth/login') return json({ requires_2fa: true, temp_token: 'challenge-test-secret' });
        if (route === '/auth/login/2fa') {
            assert.deepEqual(JSON.parse(init.body), { temp_token: 'challenge-test-secret', totp_code: '123456' });
            return json({ access_token: 'access-test-secret', refresh_token: 'refresh-test-secret', user: user() });
        }
        if (route === '/groups/available') return json(groups);
        if (route === '/keys') return json({ items: keys, total: keys.length });
        if (route === '/keys/8' || route === '/keys/9') return json(keys.find(k => route === '/keys/' + k.id));
        if (route === '/auth/logout') return json({});
        throw new Error('Unexpected test route ' + route);
    },
    broker: async (operation, args, accountId) => {
        if (!shared) throw new Error('No desktop in test');
        if (operation === 'profile') return user();
        assert.equal(accountId, identity);
        if (operation === 'groups') return groups;
        if (operation === 'keys') return { items: keys, total: keys.length };
        if (operation === 'key') return keys.find(key => key.id === args.id);
        throw new Error('Unexpected test operation');
    },
});

async function waitFor(window, expression) {
    const end = Date.now() + 15000;
    do {
        if (await window.webContents.executeJavaScript(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 40));
    } while (Date.now() < end);
    throw new Error('UI did not reach: ' + expression);
}
app.on('browser-window-created', (_event, window) => {
    window.webContents.on('render-process-gone', (_event, details) => { console.error('Renderer stopped:', details.reason); app.quit(); });
    window.webContents.on('console-message', event => { if (event.level === 'error') { rendererErrors.push(event.message); console.error('Renderer:', event.message); } });
    window.webContents.on('did-finish-load', async () => {
        if (!window.webContents.getURL().startsWith('http://127.0.0.1:') || window.accountTestStarted) return;
        window.accountTestStarted = true;
        const js = async code => {
            try { return await window.webContents.executeJavaScript(code); }
            catch (error) { throw new Error('UI step failed: ' + code, { cause: error }); }
        };
        try {
            await waitFor(window, `Boolean(document.querySelector('#graph-canvas') && window.comfyAPI?.app?.app?.graph)`);
            assert.equal(BrowserWindow.getAllWindows().length, 1, 'Startup must open only the canvas window');
            assert.equal(await js(`Boolean(document.querySelector('[data-testid="settings-dialog"]'))`), false, 'Startup must not require a settings screen');
            assert.deepEqual((await js(`window.oneYesDesktop.state()`)).configured, { default: false, image: false, text: false, claude: false, gemini: false, grok: false, video: false });
            await waitFor(window, `Boolean(document.querySelector('[data-testid="oneyes-account-button"]'))`);
            await waitFor(window, `Boolean(document.querySelector('link[data-oneyes-account-button]')?.sheet)`);
            await waitFor(window, `(()=>{const b=document.querySelector('[data-testid="oneyes-account-button"]');const r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`);
            const button = await js(`(()=>{const b=document.querySelector('[data-testid="oneyes-account-button"]');const r=b.getBoundingClientRect();return {label:b.textContent,title:b.title,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
            assert.match(button.label, /OneYes 登录/);
            assert.equal(button.title, '登录 OneYes，使用云端模型');
            window.focus();
            window.webContents.focus();
            window.webContents.sendInputEvent({ type: 'mouseMove', x: button.x, y: button.y });
            window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: button.x, y: button.y });
            window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: button.x, y: button.y });
            await waitFor(window, `Boolean(document.querySelector('[data-testid="settings-dialog"] #login-form'))`);
            assert.equal(await js(`Boolean(document.querySelector('.oneyes-panel'))`), true);
            assert.doesNotMatch(await js(`document.querySelector('[data-testid="settings-dialog"]').textContent`), /Comfy 账户|登录您的帐户/);
            assert.equal(await js(`document.querySelector('#account-entry').hidden`), false);
            assert.equal(await js(`document.querySelector('#manual-key-section').open`), false);
            assert.doesNotMatch(await js(`document.querySelector('[data-testid="settings-dialog"]').textContent`), /使用 SSO|Google登录|Github登录|Comfy API/);
            await js(`document.querySelector('#register-account').click();document.querySelector('#forgot-password').click()`);
            await waitFor(window, `!document.querySelector('#register-account').disabled && !document.querySelector('#forgot-password').disabled`);
            assert.deepEqual(openedPages, ['https://oneyes.ai/register', 'https://oneyes.ai/forgot-password']);
            assert.match(await js(`window.oneYesDesktop.openAccountPage('https://invalid.test').then(()=>'',e=>e.message)`), /账户页面无效/);
            await js(`document.querySelector('#login-email').value='creator@example.test';document.querySelector('#login-password').value='password-test-secret';document.querySelector('#login-form').requestSubmit(document.querySelector('#login-submit'))`);
            await waitFor(window, `!document.querySelector('#totp-fields').hidden && !document.querySelector('#login-submit').disabled`);
            assert.equal(await js(`document.querySelector('#login-password').value`), '');
            await js(`document.querySelector('#login-code').value='123456';document.querySelector('#login-form').requestSubmit(document.querySelector('#login-submit'))`);
            await waitFor(window, `!document.querySelector('#account-summary').hidden && document.querySelector('#account-image').options.length===3 && !document.querySelector('#use-account-keys').disabled`);
            assert.equal(await js(`document.querySelector('#account-image').value`), '8');
            assert.equal(await js(`document.querySelector('#account-text').value`), '9');
            await waitFor(window, `document.querySelector('[data-testid="oneyes-account-button"]').dataset.connection==='connected'`);
            assert.match(await js(`document.querySelector('[data-testid="oneyes-account-button"]').title`), /OneYes · 创作者 · 余额 \$12.34/);
            assert.deepEqual((await js(`window.oneYesDesktop.state()`)).configured, { default: true, image: true, text: true, claude: false, gemini: false, grok: false, video: false }, 'Login must configure usable keys before manual confirmation');
            await js(`document.querySelector('#account-keys').requestSubmit(document.querySelector('#use-account-keys'))`);
            await waitFor(window, `document.querySelector('#message').textContent.includes('已配置') && !document.querySelector('#use-account-keys').disabled`);
            const state = await js(`window.oneYesDesktop.state()`);
            assert.deepEqual(state.configured, { default: true, image: true, text: true, claude: false, gemini: false, grok: false, video: false });
            assert.equal(state.runtime.status, 'ready', 'The real engine must start before login');
            assert.doesNotMatch(JSON.stringify(state), /test-secret/);
            assert.doesNotMatch(await js(`document.body.textContent`), /test-secret/);
            if (process.env.COMFY_UI_SCREENSHOT) fs.writeFileSync(process.env.COMFY_UI_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
            await js(`window.confirm=()=>true;document.querySelector('#logout-account').click()`);
            await waitFor(window, `!document.querySelector('#account-entry').hidden && !document.querySelector('#reuse-account').disabled`);
            shared = true;
            await js(`document.querySelector('#reuse-account').click()`);
            await waitFor(window, `document.querySelector('#account-source').textContent==='已复用客户端登录' && !document.querySelector('#refresh-account').disabled`);
            assert.equal(await js(`document.querySelector('#create-key-section').hidden`), true);
            identity = 18;
            await js(`document.querySelector('#refresh-account').click()`);
            await waitFor(window, `!document.querySelector('#reconnect-account').hidden && !document.querySelector('#reconnect-account').disabled`);
            await js(`document.querySelector('#reconnect-account').click()`);
            await waitFor(window, `(async()=>{const state=await window.oneYesDesktop.state();return state.account.user.id===18&&state.account.connected})()`);
            await js(`document.querySelector('#oneyes-tab-models').click()`);
            assert.equal(await js(`document.querySelector('#models').hidden`), false);
            await js(`window.oneYesDesktop.openSettings('updates')`);
            await waitFor(window, `document.querySelector('#updates')?.hidden===false`);
            assert.equal(BrowserWindow.getAllWindows().length, 1, 'Menus must reuse the native settings dialog');
            window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
            window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
            await waitFor(window, `!document.querySelector('.oneyes-panel')`);
            await js(`window.oneYesDesktop.openSettings('account')`);
            await waitFor(window, `Boolean(document.querySelector('#account-summary')&&!document.querySelector('#account-summary').hidden)`);
            assert.equal(await js(`document.querySelectorAll('.oneyes-panel').length`), 1);
            assert.equal(await js(`(async()=>{const receipt=await fetch('/oneyes-frontend.json').then(r=>r.json());const {t:useAuthDialogs}=await import('/assets/'+receipt.authModule);return useAuthDialogs().showSignInDialog()})()`), false, 'OneYes sign-in must not authorize upstream Comfy Org API nodes');
            await waitFor(window, `document.querySelectorAll('.oneyes-panel').length===1`);
            assert.equal(await js(`Boolean(document.querySelector('[data-testid="login-button"]'))`), false);
            window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
            window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
            await waitFor(window, `!document.querySelector('.oneyes-panel')`);
            await js(`(()=>{const node=LiteGraph.createNode('OpenAIChatNode');window.nativeModelNode=node;window.comfyAPI.app.app.graph.add(node);node.widgets.find(w=>w.name==='选择 OneYes 模型').callback()})()`);
            await waitFor(window, `Boolean([...document.querySelectorAll('.oneyes-models button')].find(b=>b.textContent==='gpt-6.2-sol'))`);
            assert.deepEqual(await js(`[...document.querySelectorAll('.oneyes-models button')].map(b=>b.textContent)`), ['gpt-6.2-sol'], 'Native text picker must exclude image and Claude models');
            await js(`[...document.querySelectorAll('.oneyes-models button')].find(b=>b.textContent==='gpt-6.2-sol').click()`);
            assert.equal(await js(`window.nativeModelNode.widgets.find(w=>w.name==='model').value`), 'gpt-6.2-sol');
            assert.doesNotMatch(await js(`JSON.stringify(window.nativeModelNode.serialize())`), /test-secret/);
            await js(`(()=>{const node=LiteGraph.createNode('OpenAIGPTImageNodeV2');window.nativeImageNode=node;window.comfyAPI.app.app.graph.add(node);node.widgets.find(w=>w.name==='选择 OneYes 模型').callback()})()`);
            await waitFor(window, `Boolean([...document.querySelectorAll('.oneyes-models button')].find(b=>b.textContent==='gpt-image-2.5'))`);
            await js(`[...document.querySelectorAll('.oneyes-models button')].find(b=>b.textContent==='gpt-image-2.5').click()`);
            await waitFor(window, `window.nativeImageNode.widgets.find(w=>w.name==='model')?.value==='gpt-image-2.5' && window.nativeImageNode.widgets.some(w=>w.name==='model.quality')`);
            assert.equal(await js(`window.nativeImageNode.serialize().type`), 'OpenAIGPTImageNodeV2');
            // Account IPC is restricted even when called from another main frame.
            const untrusted = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve('desktop/preload.cjs'), sandbox: true, contextIsolation: true } });
            await untrusted.loadURL('about:blank');
            assert.match(await untrusted.webContents.executeJavaScript(`window.oneYesDesktop.account('reuse').then(()=>'',error=>error.message)`), /请求来源无效/);
            untrusted.destroy();
            assert.deepEqual(rendererErrors, [], 'Native OneYes integration must load without renderer errors');
            console.log('Native ComfyUI: direct canvas startup, integrated User settings, login + 2FA, group selection, encrypted keys, desktop reuse, identity change, menu navigation and IPC authorization passed.');
            passed = true;
        } catch (error) {
            console.error(error);
            console.error('Native metadata:', await js(`fetch('/oneyes/native-nodes').then(async r=>({status:r.status,text:(await r.text()).slice(0,200)}))`));
            console.error(await js(`JSON.stringify({buttons:[...document.querySelectorAll('[data-testid="oneyes-account-button"]')].map(b=>({text:b.textContent,rect:b.getBoundingClientRect().toJSON()})),dialogs:[...document.querySelectorAll('[role="dialog"]')].map(e=>e.textContent.slice(0,180))})`));
            if (process.env.COMFY_UI_SCREENSHOT) fs.writeFileSync(process.env.COMFY_UI_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
        }
        finally { app.quit(); }
    });
});
app.on('will-quit', () => {
    process.exitCode = passed ? 0 : 1;
    if (passed && process.env.COMFY_ACCOUNT_TEST_RESULT) fs.writeFileSync(process.env.COMFY_ACCOUNT_TEST_RESULT, 'passed');
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
});
require('../../desktop/main.cjs');
