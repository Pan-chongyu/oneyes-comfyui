const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-account-ui-'));
app.setPath('userData', directory);
app.disableHardwareAcceleration();
// Keep this test independent of an installed copy running under the same user.
app.requestSingleInstanceLock = () => true;
console.log('Starting isolated account UI test.');
// Account UI runs without preparing the multi-gigabyte engine; the real runtime has its own smoke test.
let startupCount = 0;
require('../../desktop/runtime.cjs').createRuntime = ({ changed }) => {
    const state = { status: 'starting', phase: '启动 ComfyUI', message: '正在加载内置运行环境', url: '' };
    return { state: () => state, token: () => '', async launch() { startupCount++; changed(state); return state; }, async stop() {} };
};
const service = require('../../desktop/account.cjs'), createAccount = service.createAccount;
let shared = false, identity = 17, passed = false;
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
    window.webContents.once('did-finish-load', async () => {
        if (!window.webContents.getURL().endsWith('/desktop/settings.html')) return;
        const js = code => window.webContents.executeJavaScript(code);
        try {
            await waitFor(window, `Boolean(document.querySelector('#login-form'))`);
            assert.equal(await js(`document.querySelector('#account-entry').hidden`), false);
            assert.equal(await js(`document.querySelector('#manual-key-section').open`), false);
            await js(`document.querySelector('#login-email').value='creator@example.test';document.querySelector('#login-password').value='password-test-secret';document.querySelector('#login-form').requestSubmit(document.querySelector('#login-submit'))`);
            await waitFor(window, `!document.querySelector('#totp-fields').hidden && !document.querySelector('#login-submit').disabled`);
            assert.equal(await js(`document.querySelector('#login-password').value`), '');
            await js(`document.querySelector('#login-code').value='123456';document.querySelector('#login-form').requestSubmit(document.querySelector('#login-submit'))`);
            await waitFor(window, `!document.querySelector('#account-summary').hidden && document.querySelector('#account-image').options.length===3 && !document.querySelector('#use-account-keys').disabled`);
            assert.equal(await js(`document.querySelector('#account-image').value`), '8');
            assert.equal(await js(`document.querySelector('#account-text').value`), '9');
            await js(`document.querySelector('#account-keys').requestSubmit(document.querySelector('#use-account-keys'))`);
            await waitFor(window, `document.querySelector('#message').textContent.includes('已配置') && !document.querySelector('#use-account-keys').disabled`);
            const state = await js(`window.oneYesDesktop.state()`);
            assert.deepEqual(state.configured, { default: true, image: true, text: true });
            assert.ok(startupCount > 0, 'The engine must start on a fresh installation');
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
            // Account IPC is restricted even when called from another main frame.
            const untrusted = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve('desktop/preload.cjs'), sandbox: true, contextIsolation: true } });
            await untrusted.loadURL('about:blank');
            assert.match(await untrusted.webContents.executeJavaScript(`window.oneYesDesktop.account('reuse').then(()=>'',error=>error.message)`), /请求来源无效/);
            untrusted.destroy();
            console.log('Native account UI: login + 2FA, group selection, encrypted keys, desktop reuse, identity change and IPC authorization passed.');
            passed = true;
        } catch (error) { console.error(error); }
        finally { app.quit(); }
    });
});
app.on('will-quit', () => {
    process.exitCode = passed ? 0 : 1;
    if (passed && process.env.COMFY_ACCOUNT_TEST_RESULT) fs.writeFileSync(process.env.COMFY_ACCOUNT_TEST_RESULT, 'passed');
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
});
require('../../desktop/main.cjs');
