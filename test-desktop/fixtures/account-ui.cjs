const { app, BrowserWindow, shell, Menu, dialog, session, nativeImage } = require('electron');
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
import base64
from io import BytesIO
from PIL import Image
from oneyes.routes import client
buffer = BytesIO()
Image.new('RGB', (17, 23), 'blue').save(buffer, 'PNG')
async def request(origin, path, key, payload=None, multipart=None):
    if path == '/models':
        assert payload is None and multipart is None
        return {'data': [{'id':'gpt-6.2-sol'}, {'id':'gpt-image-2.5'}, {'id':'claude-opus-4-6'}]}, 1
    assert key == 'sk-image-test-secret'
    if path.endswith('/async'):
        assert payload['model'] == 'gpt-image-2.5'
        return {'task_id': 'standalone-original-task'}, 1
    assert path == '/images/tasks/standalone-original-task'
    return {'id': 'standalone-original-task', 'status': 'completed', 'result': {'data': [{'b64_json': base64.b64encode(buffer.getvalue()).decode()}]}}, 1
client.request = request
NODE_CLASS_MAPPINGS = {}
`);
console.log('Starting isolated account UI test.');
const openedPages = [];
shell.openExternal = async url => { openedPages.push(url); };
const fromPartition = session.fromPartition.bind(session);
session.fromPartition = (...args) => {
    const isolated = fromPartition(...args);
    if (args[0].startsWith('oneyes-login-')) isolated.protocol.handle('https', request => {
        assert.equal(new URL(request.url).origin, 'https://oneyes.ai');
        return new Response('<!doctype html><title>OneYes test login</title><button id="complete-login" onclick="localStorage.setItem(\'auth_token\',\'website-access-test-secret\');localStorage.setItem(\'refresh_token\',\'website-refresh-test-secret\')">登录</button>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    });
    return isolated;
};
const runtime = require('../../desktop/runtime.cjs'), createRuntime = runtime.createRuntime;
let engine, stopCalls = 0;
runtime.createRuntime = options => {
    engine = createRuntime({ ...options, changed: state => {
        options.changed(state);
        if (state.status === 'error') { console.error('Engine startup failed:', state.message); app.quit(); }
    } });
    const stop = engine.stop;
    engine.stop = () => { stopCalls++; return stop(); };
    return engine;
};
const service = require('../../desktop/account.cjs'), createAccount = service.createAccount;
const updateService = require('../../desktop/updater.cjs');
let updateChanged, finishUpdateCheck, checkCalls = 0, installCalls = 0;
let updateState = { status: 'idle', supported: true, version: '', progress: 0, error: '', notes: '' };
const pushUpdate = value => { updateState = { ...updateState, ...value }; updateChanged(); };
updateService.createUpdater = options => {
    updateChanged = options.changed;
    return {
        state: () => updateState,
        check: () => { checkCalls++; pushUpdate({ status: 'checking' }); return new Promise(resolve => { finishUpdateCheck = resolve; }); },
        apply: async () => { installCalls++; pushUpdate({ status: 'installing' }); },
        start: async () => {}, close: () => {},
    };
};
let shared = false, identity = 17, passed = false;
const portrait = nativeImage.createFromPath(path.resolve('desktop/resources/icon.png'));
const avatars = [portrait.resize({ width: 96, height: 48 }).toDataURL(), portrait.resize({ width: 48, height: 96 }).toDataURL()];
let avatar = avatars[0];
const rendererErrors = [];
const user = () => ({ id: identity, email: 'creator@example.test', username: '创作者', balance: 12.34, avatar_url: avatar });
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
        if (route === '/auth/me') {
            assert.equal(init.headers.Authorization, 'Bearer website-access-test-secret');
            return json(user());
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
            await waitFor(window, `document.hasFocus()`);
            window.webContents.sendInputEvent({ type: 'mouseMove', x: button.x, y: button.y });
            window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: button.x, y: button.y });
            window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: button.x, y: button.y });
            await waitFor(window, `Boolean(document.querySelector('[data-testid="settings-dialog"] #login-form'))`);
            assert.equal(await js(`Boolean(document.querySelector('.oneyes-panel'))`), true);
            assert.equal(await js(`Boolean(document.querySelector('#oneyes-tab-updates') || document.querySelector('#check-update'))`), false, 'The account page must not keep a second update entry');
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
            await waitFor(window, `!document.querySelector('#account-summary').hidden && document.querySelector('#account-image').options.length===3 && document.querySelector('#key-selection-state').textContent==='选择已保存'`);
            assert.equal(await js(`document.querySelector('#account-image').value`), '8');
            assert.equal(await js(`document.querySelector('#account-text').value`), '9');
            await waitFor(window, `document.querySelector('[data-testid="oneyes-account-button"]').dataset.connection==='connected'`);
            assert.match(await js(`document.querySelector('[data-testid="oneyes-account-button"]').title`), /OneYes · 创作者 · 余额 \$12.34/);
            const avatarReady = `(()=>{const panel=document.querySelector('#account-avatar'),button=document.querySelector('.oneyes-account-avatar img');return panel&&!panel.hidden&&panel.naturalWidth>0&&button?.dataset.loaded==='true'&&button.naturalWidth>0})()`;
            await waitFor(window, avatarReady);
            assert.equal(await js(`getComputedStyle(document.querySelector('.oneyes-account-avatar>i')).visibility`), 'hidden', 'Transparent avatars must not show the fallback glyph underneath');
            assert.deepEqual(await js(`['#account-avatar','.oneyes-account-avatar img'].map(selector=>{const image=document.querySelector(selector);return {fit:getComputedStyle(image).objectFit,round:getComputedStyle(image.parentElement).borderRadius}})`), [{ fit: 'cover', round: '50%' }, { fit: 'cover', round: '50%' }], 'Both account surfaces must crop rectangular avatars consistently');
            assert.deepEqual((await js(`window.oneYesDesktop.state()`)).configured, { default: true, image: true, text: true, claude: false, gemini: false, grok: false, video: false }, 'Login must configure usable keys before manual confirmation');
            assert.equal(await js(`document.querySelector('#use-account-keys').textContent`), '重新应用 Key', 'Saved selections should remain available after a manual Key override');
            await js(`document.querySelector('#account-text').value='8';document.querySelector('#account-text').dispatchEvent(new Event('change'))`);
            assert.equal(await js(`document.querySelector('#use-account-keys').disabled`), false);
            assert.match(await js(`document.querySelector('#key-selection-state').textContent`), /有更改/);
            await js(`document.querySelector('#account-keys').requestSubmit(document.querySelector('#use-account-keys'))`);
            await waitFor(window, `document.querySelector('#message').textContent.includes('已配置') && document.querySelector('#key-selection-state').textContent==='选择已保存'`);
            assert.equal((await js(`window.oneYesDesktop.state()`)).account.profiles.text, 8, 'Applied status must reflect the saved choice');
            await js(`window.oneYesDesktop.saveKeys({text:'manual-ui-override'})`);
            await js(`document.querySelector('#account-keys').requestSubmit(document.querySelector('#use-account-keys'))`);
            await waitFor(window, `!document.querySelector('#use-account-keys').disabled`);
            assert.equal((await require('../../desktop/vault.cjs').createEncryptedStore(directory, 'vault.json').read()).text, 'sk-image-test-secret', 'Unchanged account selections can replace a manual override');
            const state = await js(`window.oneYesDesktop.state()`);
            assert.deepEqual(state.configured, { default: true, image: true, text: true, claude: false, gemini: false, grok: false, video: false });
            assert.equal(state.runtime.status, 'ready', 'The real engine must start before login');
            assert.doesNotMatch(JSON.stringify(state), /test-secret/);
            assert.doesNotMatch(await js(`document.body.textContent`), /test-secret/);
            const standalone = await js(`(async()=>{
                await window.oneYesDesktop.models('image');
                const response=await fetch('/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:{
                    '1':{class_type:'OpenAIGPTImageNodeV2',inputs:{prompt:'standalone test',model:'gpt-image-2.5','model.size':'auto','model.custom_width':1024,'model.custom_height':1024,'model.background':'opaque','model.quality':'low','model.complexity':'low',n:1,seed:7}},
                    '2':{class_type:'SaveImage',inputs:{images:['1',0],filename_prefix:'standalone-gpt'}}
                }})});return {status:response.status,body:await response.json()};
            })()`);
            assert.equal(standalone.status, 200, JSON.stringify(standalone.body));
            await waitFor(window, `(async()=>{const history=await fetch('/history/${standalone.body.prompt_id}').then(r=>r.json());return history['${standalone.body.prompt_id}']?.status.completed})()`);
            assert.equal(await js(`(async()=>{const history=await fetch('/history/${standalone.body.prompt_id}').then(r=>r.json());return history['${standalone.body.prompt_id}'].status.status_str})()`), 'success', 'GPT image node must execute without a primary client');
            if (process.env.COMFY_UI_SCREENSHOT) fs.writeFileSync(process.env.COMFY_UI_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
            window.setContentSize(740, 800);
            await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
            const narrow = await js(`(()=>{const panel=document.querySelector('.oneyes-panel'),grid=document.querySelector('.primary-profiles');return {width:panel.clientWidth,scrollWidth:panel.scrollWidth,columns:getComputedStyle(grid).gridTemplateColumns}})()`);
            assert.ok(narrow.width < 650 && narrow.scrollWidth <= narrow.width + 1, 'Account settings must fit the narrow native dialog: ' + JSON.stringify(narrow));
            assert.equal(narrow.columns.trim().split(/\s+/).length, 1, 'Key fields should stack based on panel width');
            if (process.env.COMFY_UI_SCREENSHOT) fs.writeFileSync(process.env.COMFY_UI_SCREENSHOT.replace(/\.png$/, '-narrow.png'), (await window.webContents.capturePage()).toPNG());
            window.setContentSize(1440, 960);
            await js(`window.confirm=()=>true;document.querySelector('#logout-account').click()`);
            await waitFor(window, `!document.querySelector('#account-entry').hidden && !document.querySelector('#reuse-account').disabled`);
            await waitFor(window, `!document.querySelector('.oneyes-account-avatar img') && !document.querySelector('#account-avatar').hasAttribute('src')`);
            await js(`document.querySelector('#website-login').click()`);
            await waitFor(window, `document.querySelector('#website-login').disabled`);
            let loginWindow;
            const loginDeadline = Date.now() + 15000;
            while (!(loginWindow = BrowserWindow.getAllWindows().find(item => item !== window && item.webContents.getURL() === 'https://oneyes.ai/login'))) {
                if (Date.now() > loginDeadline) throw new Error('Website login window did not open');
                await new Promise(resolve => setTimeout(resolve, 40));
            }
            await waitFor(loginWindow, `Boolean(document.querySelector('#complete-login'))`);
            assert.equal(loginWindow.webContents.getLastWebPreferences().sandbox, true);
            assert.equal(loginWindow.webContents.getLastWebPreferences().nodeIntegration, false);
            assert.equal(await loginWindow.webContents.executeJavaScript(`typeof window.oneYesDesktop`), 'undefined', 'Website login must not have the canvas bridge');
            await loginWindow.webContents.executeJavaScript(`document.querySelector('#complete-login').click()`);
            await waitFor(window, `!document.querySelector('#account-summary').hidden && !document.querySelector('#logout-account').disabled`);
            assert.equal(loginWindow.isDestroyed(), true);
            assert.equal((await js(`window.oneYesDesktop.state()`)).account.source, 'login');
            assert.doesNotMatch(JSON.stringify(await js(`window.oneYesDesktop.state()`)), /website-access-test-secret|website-refresh-test-secret/);
            await js(`document.querySelector('#logout-account').click()`);
            await waitFor(window, `!document.querySelector('#account-entry').hidden && !document.querySelector('#reuse-account').disabled`);
            shared = true;
            await js(`document.querySelector('#reuse-account').click()`);
            await waitFor(window, `document.querySelector('#account-source').textContent==='已复用客户端登录' && !document.querySelector('#refresh-account').disabled`);
            assert.equal(await js(`document.querySelector('#create-key-section').hidden`), true);
            await waitFor(window, avatarReady);
            avatar = 'data:image/png;base64,AAAA';
            await js(`document.querySelector('#refresh-account').click()`);
            await waitFor(window, `document.querySelector('#account-avatar').hidden && getComputedStyle(document.querySelector('#account-avatar-fallback')).display!=='none' && !document.querySelector('.oneyes-account-avatar img') && !document.querySelector('#refresh-account').disabled`);
            assert.equal(await js(`getComputedStyle(document.querySelector('.oneyes-account-avatar>i')).visibility`), 'visible', 'A failed avatar must restore the fallback glyph');
            avatar = avatars[1];
            await js(`document.querySelector('#refresh-account').click()`);
            await waitFor(window, avatarReady);
            assert.equal(await js(`document.querySelector('#account-avatar').src`), avatar, 'Refreshing must replace a failed avatar with the new image');
            avatar = '';
            await js(`document.querySelector('#refresh-account').click()`);
            await waitFor(window, `!document.querySelector('#account-avatar').hasAttribute('src') && !document.querySelector('.oneyes-account-avatar img') && !document.querySelector('#refresh-account').disabled`);
            avatar = avatars[0];
            await js(`document.querySelector('#refresh-account').click()`);
            await waitFor(window, avatarReady);
            identity = 18;
            await js(`document.querySelector('#refresh-account').click()`);
            await waitFor(window, `!document.querySelector('#reconnect-account').hidden && !document.querySelector('#reconnect-account').disabled`);
            await js(`document.querySelector('#reconnect-account').click()`);
            await waitFor(window, `(async()=>{const state=await window.oneYesDesktop.state();return state.account.user.id===18&&state.account.connected})()`);
            await js(`document.querySelector('#oneyes-tab-models').click()`);
            assert.equal(await js(`document.querySelector('#models').hidden`), false);
            await js(`window.oneYesDesktop.openSettings('updates')`);
            await waitFor(window, `Boolean(document.querySelector('.oneyes-about-settings #check-update'))`);
            assert.equal(await js(`Boolean(document.querySelector('.oneyes-user-settings'))`), false, 'Update shortcuts must select About even when User settings is already open');
            assert.equal(BrowserWindow.getAllWindows().length, 1, 'Menus must reuse the native settings dialog');
            assert.match(await js(`document.querySelector('#update-version').textContent`), new RegExp(app.getVersion()));
            assert.equal(await js(`document.querySelector('.oneyes-component-info').open`), false, 'Keep the original component and system information folded');
            await js(`document.querySelector('#check-update').click()`);
            await waitFor(window, `document.querySelector('#update-label').textContent==='正在检查更新…' && document.querySelector('#check-update').disabled`);
            assert.equal(checkCalls, 1);
            pushUpdate({ status: 'downloading', version: '9.9.9', progress: 42 });
            await waitFor(window, `document.querySelector('#update-progress').value===42 && !document.querySelector('#update-progress').hidden`);
            pushUpdate({ status: 'ready', progress: 100 }); finishUpdateCheck();
            await waitFor(window, `!document.querySelector('#install-update').hidden && !document.querySelector('#install-update').disabled`);
            if (process.env.COMFY_UI_SCREENSHOT) fs.writeFileSync(process.env.COMFY_UI_SCREENSHOT.replace(/\.png$/, '-about.png'), (await window.webContents.capturePage()).toPNG());
            await js(`document.querySelector('#install-update').click()`);
            await waitFor(window, `document.querySelector('#update-label').textContent==='正在安装并重新打开…'`);
            assert.equal(installCalls, 1, 'The About action must invoke the installer');
            pushUpdate({ status: 'error', error: '测试更新失败，可重试' });
            await waitFor(window, `document.querySelector('#update-detail').textContent==='测试更新失败，可重试' && !document.querySelector('#check-update').disabled`);
            await js(`window.oneYesDesktop.openSettings('account')`);
            await waitFor(window, `Boolean(document.querySelector('#account-summary')&&!document.querySelector('#account-summary').hidden)`);
            await js(`[...document.querySelectorAll('[data-testid="settings-dialog"] span')].find(label=>label.textContent.trim()==='关于').click()`);
            await waitFor(window, `Boolean(document.querySelector('.oneyes-about-settings #check-update'))`);
            pushUpdate({ status: 'current', error: '' });
            await waitFor(window, `document.querySelector('#update-label').textContent==='当前已是最新版本'`);
            assert.equal(await js(`document.querySelectorAll('#updates').length`), 1, 'Sidebar About must own the single update surface');
            await js(`[...document.querySelectorAll('[data-testid="settings-dialog"] [role="button"]')].find(item=>item.textContent.trim()==='用户').click()`);
            await waitFor(window, `Boolean(document.querySelector('#account-summary')&&!document.querySelector('#account-summary').hidden)`);
            assert.equal(await js(`document.querySelector('#account').hidden`), false, 'Returning through the native User item must not select the removed update tab');
            Menu.getApplicationMenu().items[0].submenu.items.find(item=>item.label==='检查更新').click();
            await waitFor(window, `Boolean(document.querySelector('.oneyes-about-settings #check-update'))`);
            await waitFor(window, `document.querySelector('#update-label').textContent==='正在检查更新…'`);
            assert.equal(checkCalls, 2, 'The system menu must reach About and request a check');
            pushUpdate({ status: 'current' }); finishUpdateCheck();
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
            const imported = await js(`(async()=>{
                const app=window.comfyAPI.app.app;
                app.graph.clear();
                const voice=LiteGraph.createNode('ElevenLabsVoiceSelector'), clone=LiteGraph.createNode('ElevenLabsInstantVoiceClone'), tts=LiteGraph.createNode('ElevenLabsTextToSpeech');
                for(const node of [voice,clone,tts])app.graph.add(node);
                voice.widgets.find(w=>w.name==='voice').value='Sarah (female, american)';
                tts.widgets.find(w=>w.name==='text').value='保留原工作流语音参数';
                voice.connect(0,tts,tts.inputs.findIndex(i=>i.name==='voice'));
                const workflow=app.graph.serialize();
                await app.loadGraphData(workflow);
                const restored=app.graph._nodes;
                window.elevenlabsTts=restored.find(n=>n.type==='ElevenLabsTextToSpeech');
                return {types:restored.map(n=>n.type).sort(),voice:restored.find(n=>n.type==='ElevenLabsVoiceSelector').widgets.find(w=>w.name==='voice').value,text:window.elevenlabsTts.widgets.find(w=>w.name==='text').value,connected:window.elevenlabsTts.inputs.find(i=>i.name==='voice').link!=null,widgets:window.elevenlabsTts.widgets.map(w=>w.name)};
            })()`);
            assert.deepEqual(imported.types, ['ElevenLabsInstantVoiceClone', 'ElevenLabsTextToSpeech', 'ElevenLabsVoiceSelector']);
            assert.equal(imported.voice, 'Sarah (female, american)');
            assert.equal(imported.text, '保留原工作流语音参数');
            assert.equal(imported.connected, true, 'Original ElevenLabs voice connection must survive workflow import');
            assert.ok(imported.widgets.includes('OneYes 暂未接入 · 查看原因'));
            assert.ok(!imported.widgets.includes('选择 OneYes 模型'), 'Unavailable APIs must not look like usable model integrations');
            await js(`window.elevenlabsTts.widgets.find(w=>w.name==='OneYes 暂未接入 · 查看原因').callback()`);
            await waitFor(window, `Boolean(document.querySelector('.oneyes-unavailable[open]'))`);
            assert.match(await js(`document.querySelector('.oneyes-unavailable').textContent`), /OneYes 当前尚未接入 ElevenLabs/);
            await js(`document.querySelector('.oneyes-unavailable .oneyes-close').click()`);
            // Account IPC is restricted even when called from another main frame.
            const untrusted = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve('desktop/preload.cjs'), sandbox: true, contextIsolation: true } });
            await untrusted.loadURL('about:blank');
            assert.match(await untrusted.webContents.executeJavaScript(`window.oneYesDesktop.account('reuse').then(()=>'',error=>error.message)`), /请求来源无效/);
            untrusted.destroy();
            assert.deepEqual(rendererErrors, [], 'Native OneYes integration must load without renderer errors');
            console.log('Native ComfyUI: standalone GPT workflow, direct login + 2FA, isolated website login, encrypted keys, optional desktop reuse, identity change, native settings and IPC authorization passed.');
            window.close();
            assert.equal(window.isDestroyed(), false, 'The window close button must keep the app running in the tray');
            assert.equal(window.isVisible(), false);
            assert.equal(engine.state().status, 'ready');
            const menu = Menu.getApplicationMenu().items[0].submenu.items;
            menu.find(item => item.label === '打开画布').click();
            assert.equal(window.isVisible(), true);
            await js(`window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = ''; })`);
            let choice = 0, confirmations = 0;
            dialog.showMessageBoxSync = (parent, options) => {
                assert.equal(parent, window);
                assert.deepEqual(options.buttons, ['返回保存', '退出']);
                assert.equal(options.cancelId, 0);
                confirmations++;
                return choice;
            };
            const prevented = new Promise(resolve => window.webContents.once('will-prevent-unload', resolve));
            menu.find(item => item.label === '退出').click();
            await prevented;
            assert.equal(confirmations, 1, 'An unsaved workflow must offer an actionable native confirmation');
            assert.equal(stopCalls, 0, 'Cancelling quit must leave the engine and updater running');
            assert.equal(engine.state().status, 'ready');
            assert.equal((await js(`fetch('/object_info/OneYesImage').then(r=>r.status)`)), 200);
            window.close();
            assert.equal(window.isDestroyed(), false, 'Cancelling quit must restore ordinary close-to-tray behavior');
            menu.find(item => item.label === '打开画布').click();
            choice = 1;
            passed = true;
            app.quit();
        } catch (error) {
            console.error(error);
            console.error('Native metadata:', await js(`fetch('/oneyes/native-nodes').then(async r=>({status:r.status,text:(await r.text()).slice(0,200)}))`));
            console.error(await js(`JSON.stringify({buttons:[...document.querySelectorAll('[data-testid="oneyes-account-button"]')].map(b=>({text:b.textContent,rect:b.getBoundingClientRect().toJSON()})),dialogs:[...document.querySelectorAll('[role="dialog"]')].map(e=>e.textContent.slice(0,180))})`));
            if (process.env.COMFY_UI_SCREENSHOT) fs.writeFileSync(process.env.COMFY_UI_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
        }
        finally { if (!passed) { window.destroy(); app.quit(); } }
    });
});
app.on('quit', () => {
    if (passed) {
        assert.equal(engine.state().status, 'idle', 'The engine must stop before the application exits');
        assert.equal(stopCalls, 1, 'A confirmed quit must stop the engine exactly once');
        console.log('Native quit: close to tray, reopen, unsaved-workflow cancellation and confirmed quit with engine cleanup passed.');
    }
    process.exitCode = passed ? 0 : 1;
    if (passed && process.env.COMFY_ACCOUNT_TEST_RESULT) fs.writeFileSync(process.env.COMFY_ACCOUNT_TEST_RESULT, 'passed');
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
});
require('../../desktop/main.cjs');
