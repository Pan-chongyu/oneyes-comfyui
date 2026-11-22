import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
const { createAccount } = require('../desktop/account.cjs');
const { brokerCall } = require('../desktop/account-broker.cjs');
const { createVault, createEncryptedStore } = require('../desktop/vault.cjs');
const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=';
const user = { id: 17, email: 'creator@example.test', username: '创作者', balance: 12.3, avatar_url: avatar, access_token: 'must-not-leak' };
const group = { id: 5, name: 'SVIP', platform: 'OpenAI', internal: 'private' };
const key = { id: 8, name: 'ComfyUI_工作流', key: 'sk-never-render-this', status: 'active', group_id: 5, group };
const json = (data, status = 200) => new Response(JSON.stringify({ code: status === 200 ? 0 : status, data }), { status });

async function fixture(t, overrides = {}) {
    const directory = await mkdtemp(path.join(tmpdir(), 'comfy-account-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const vault = createVault(directory), store = createEncryptedStore(directory, 'account.json'), requests = [];
    let token = 0;
    const fetcher = async (url, init) => {
        const pathname = new URL(url).pathname.replace('/api/v1', '');
        requests.push({ url, init, pathname });
        if (overrides.fetcher) return overrides.fetcher(pathname, init, url);
        if (pathname === '/settings/public') return json({});
        if (pathname === '/auth/login') return json({ access_token: 'access-secret', refresh_token: 'refresh-secret', user });
        if (pathname === '/auth/refresh') return json({ access_token: `access-${++token}`, refresh_token: `rotated-refresh-${token}` });
        if (pathname === '/auth/me') return json(user);
        if (pathname === '/auth/logout') return json({});
        if (pathname === '/groups/available') return json([group]);
        if (pathname === '/keys' && init.method === 'GET') return json({ items: [key], total: 1 });
        if (pathname === '/keys/8') return json(key);
        throw new Error('Unexpected route: ' + pathname);
    };
    const dependencies = { store, vault, fetcher, broker: overrides.broker || (async () => { throw new Error('No desktop'); }), websiteLogin: overrides.websiteLogin };
    const account = createAccount(dependencies);
    const login = () => account.call('login', { email: ' creator@example.test ', password: 'password-secret' });
    return { directory, account, login, requests, dependencies, vault, store };
}

test('fresh standalone restore does not contact the primary client', async t => {
    let brokerCalls = 0;
    const f = await fixture(t, { broker: async () => { brokerCalls++; throw new Error('Not installed'); } });
    const state = await f.account.call('restore');
    assert.equal(state.user, null);
    assert.equal(state.error, '');
    await f.vault.save({ default: 'manual-secret' });
    await createAccount(f.dependencies).call('restore');
    assert.equal((await f.vault.status()).default, true);
    assert.equal(brokerCalls, 0);
    assert.equal(f.requests.length, 0);
});

test('website login verifies identity server-side and restores independently', async t => {
    let websiteCalls = 0;
    const f = await fixture(t, { websiteLogin: async () => { websiteCalls++; return { access_token: 'website-access-secret', refresh_token: 'website-refresh-secret' }; } });
    const state = await f.account.call('website-login', { access_token: 'untrusted-renderer-value', user: { id: 99 } });
    assert.equal(state.user.id, user.id);
    assert.equal(state.user.avatar_url, avatar);
    assert.equal(state.source, 'login');
    assert.equal(state.connected, true);
    assert.equal(websiteCalls, 1);
    assert.equal(f.requests[0].pathname, '/auth/me');
    assert.equal(f.requests[0].init.headers.Authorization, 'Bearer website-access-secret');
    assert.doesNotMatch(JSON.stringify(state), /secret|token/);
    await f.account.call('auto-configure', { account_id: user.id });
    assert.equal((await createAccount(f.dependencies).call('restore')).connected, true);
    assert.equal((await f.vault.status()).image, true);
    assert.doesNotMatch(await readFile(path.join(f.directory, 'account.json'), 'utf8'), /website-refresh-secret/);
});

test('website cancellation or invalid tokens leave existing local keys intact', async t => {
    const f = await fixture(t, { websiteLogin: async () => { throw new Error('已取消网站登录'); } });
    await f.vault.save({ image: 'manual-key' });
    await assert.rejects(f.account.call('website-login'), /已取消/);
    const invalid = createAccount({ ...f.dependencies, websiteLogin: async () => ({ access_token: 'expired', refresh_token: 'invalid' }), fetcher: async () => json({}, 401) });
    await assert.rejects(invalid.call('website-login'), /登录已过期/);
    assert.equal((await f.vault.status()).image, true);
    assert.equal(invalid.state().user, null);
});

test('direct login, safe catalog, selected keys and encrypted restart/refresh', async t => {
    const f = await fixture(t);
    const view = await f.login();
    assert.equal(view.user.username, '创作者');
    assert.equal(view.user.avatar_url, avatar);
    assert.equal(view.connected, true);
    assert.doesNotMatch(JSON.stringify(view), /secret|must-not-leak/);
    const catalog = await f.account.call('catalog', { account_id: user.id });
    assert.deepEqual(catalog.groups, [{ id: 5, name: 'SVIP', platform: 'OpenAI' }]);
    assert.doesNotMatch(JSON.stringify(catalog), /never-render|private|secret/);
    await f.account.call('configure', { account_id: user.id, image_id: key.id, text_id: key.id });
    assert.deepEqual(await f.vault.status(), { default: true, image: true, text: true, claude: false, gemini: false, grok: false, video: false });
    assert.equal(f.requests.filter(r => r.pathname === '/keys/8').length, 1);
    for (const file of ['account.json', 'vault.json']) assert.doesNotMatch(await readFile(path.join(f.directory, file), 'utf8'), /secret|creator@example|sk-never/);
    assert.ok(!(await readFile(path.join(f.directory, 'account.json'), 'utf8')).includes(avatar), 'Avatar data must be encrypted with the cached identity');
    assert.doesNotMatch(JSON.stringify(await f.store.read()), /password-secret|access-secret/);
    const restored = createAccount(f.dependencies);
    assert.equal((await restored.call('restore')).connected, true);
    assert.equal(restored.state().user.avatar_url, avatar);
    assert.equal((await f.store.read()).refresh_token, 'rotated-refresh-1');
    assert.deepEqual(await f.vault.status(), { default: true, image: true, text: true, claude: false, gemini: false, grok: false, video: false });
    assert.ok(f.requests.every(r => r.url.startsWith('https://oneyes.ai/api/v1/')));
    await f.vault.save({ text: 'manual-secret' });
    await restored.call('logout');
    assert.deepEqual(await f.vault.status(), { default: false, image: false, text: true, claude: false, gemini: false, grok: false, video: false });
    assert.equal((await createAccount(f.dependencies).call('restore')).user, null);
});

test('avatars refresh, clear and reject non-image or local executable sources', async t => {
    let avatar_url = avatar;
    const f = await fixture(t, { broker: async () => ({ ...user, avatar_url }) });
    assert.equal((await f.account.call('reuse')).user.avatar_url, avatar);
    for (const [input, expected] of [
        ['https://cdn.example.test/avatar.png', 'https://cdn.example.test/avatar.png'],
        ['/uploads/avatar.png', 'https://oneyes.ai/uploads/avatar.png'],
        ['', ''], [null, ''], ['file:///tmp/avatar.png', ''], ['javascript:alert(1)', ''],
        ['data:image/svg+xml;base64,PHN2Zy8+', ''], ['https://name:password@example.test/avatar.png', ''],
    ]) {
        avatar_url = input;
        const state = await f.account.call('restore');
        assert.equal(state.user.avatar_url, expected);
        assert.equal((await f.store.read()).user.avatar_url, expected);
    }
});

test('two-factor challenge stays in main process and can complete login', async t => {
    const payloads = [];
    const f = await fixture(t, { fetcher: (route, init) => {
        if (route === '/settings/public') return json({});
        payloads.push(JSON.parse(init.body));
        if (route === '/auth/login') return json({ requires_2fa: true, temp_token: 'challenge-secret' });
        assert.equal(route, '/auth/login/2fa');
        return json({ access_token: 'access-secret', refresh_token: 'refresh-secret', user });
    } });
    const pending = await f.login();
    assert.equal(pending.requires_2fa, true);
    assert.equal(pending.user, null);
    assert.doesNotMatch(JSON.stringify(pending), /challenge-secret/);
    assert.equal((await f.account.call('login-2fa', { code: '123456' })).user.id, user.id);
    assert.deepEqual(payloads[1], { temp_token: 'challenge-secret', totp_code: '123456' });
});

test('first connection configures image and text without exposing keys; manual choices survive', async t => {
    const f = await fixture(t);
    await f.login();
    const state = await f.account.call('auto-configure', { account_id: user.id });
    assert.deepEqual(state.profiles, { image: 8, text: 8 });
    assert.deepEqual(await f.vault.status(), { default: true, image: true, text: true, claude: false, gemini: false, grok: false, video: false });
    assert.doesNotMatch(JSON.stringify(state), /never-render|secret/);
    const count = f.requests.length;
    await f.vault.save({ default: 'manual-key' });
    await f.account.call('auto-configure', { account_id: user.id });
    assert.equal(f.requests.length, count, 'A configured account must not fetch or rewrite keys on every launch');
    await f.account.call('logout');
    assert.deepEqual(await f.vault.status(), { default: true, image: false, text: false, claude: false, gemini: false, grok: false, video: false });
});

test('empty direct account creates one workflow key; desktop reuse stays read-only', async t => {
    let created = false, writes = 0;
    const f = await fixture(t, { fetcher: (route, init) => {
        if (route === '/settings/public') return json({});
        if (route === '/auth/login') return json({ access_token: 'access-secret', refresh_token: 'refresh-secret', user });
        if (route === '/groups/available') return json([group]);
        if (route === '/keys' && init.method === 'GET') return json({ items: created ? [key] : [], total: created ? 1 : 0 });
        if (route === '/keys' && init.method === 'POST') { writes++; assert.deepEqual(JSON.parse(init.body), { name: 'ComfyUI_工作流', group_id: 5 }); created = true; return json(key); }
        if (route === '/keys/8') return json(key);
        throw new Error('Unexpected route ' + route);
    } });
    await f.login();
    await f.account.call('auto-configure', { account_id: user.id });
    assert.deepEqual(await f.vault.status(), { default: true, image: true, text: true, claude: false, gemini: false, grok: false, video: false });
    await f.account.call('auto-configure', { account_id: user.id });
    assert.equal(writes, 1);
    const unavailable = await fixture(t, { broker: async operation => {
        if (operation === 'profile') return user;
        if (operation === 'groups') return [group];
        if (operation === 'keys') return { items: [], total: 0 };
        throw new Error('Reuse must not create keys');
    } });
    await unavailable.account.call('reuse');
    const state = await unavailable.account.call('auto-configure', { account_id: user.id });
    assert.equal(state.connected, true);
    assert.match(state.error, /暂无可用/);
    assert.deepEqual(await unavailable.vault.status(), { default: false, image: false, text: false, claude: false, gemini: false, grok: false, video: false });
});

test('official verification requirements are respected before password submission', async t => {
    const f = await fixture(t, { fetcher: () => json({ turnstile_enabled: true }) });
    await assert.rejects(f.login(), /官网验证/);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].init.method, 'GET');
});

test('native providers select separate platform keys and Video never uses the Grok text group', async t => {
    const groups = [group, { id: 6, name: 'Claude', platform: 'anthropic' }, { id: 7, name: 'Gemini', platform: 'gemini' }, { id: 8, name: 'grok', platform: 'grok' }, { id: 9, name: 'Video', platform: 'grok' }];
    const keys = groups.map((item, index) => ({ ...key, id: index + 20, group_id: item.id, group: item, key: 'sk-native-secret-' + index }));
    const f = await fixture(t, { fetcher: (route, init) => {
        if (route === '/settings/public') return json({});
        if (route === '/auth/login') return json({ access_token: 'access-secret', refresh_token: 'refresh-secret', user });
        if (route === '/groups/available') return json(groups);
        if (route === '/keys' && init.method === 'GET') return json({ items: keys, total: keys.length });
        if (/^\/keys\/\d+$/.test(route)) return json(keys.find(key => key.id === Number(route.split('/').at(-1))));
        throw new Error('Unexpected provider request');
    } });
    await f.login();
    const state = await f.account.call('auto-configure', { account_id: user.id });
    assert.deepEqual(state.profiles, { image: 20, text: 20, claude: 21, gemini: 22, grok: 23, video: 24 });
    assert.doesNotMatch(JSON.stringify(state), /sk-native/);
    const count = f.requests.length;
    await f.account.call('auto-configure', { account_id: user.id });
    assert.equal(f.requests.length, count);
    await f.vault.save({ gemini: 'manual-gemini-secret' });
    await f.account.call('logout');
    assert.deepEqual(await f.vault.status(), { default: false, image: false, text: false, claude: false, gemini: true, grok: false, video: false });
});

test('desktop reuse pins identity and never copies account tokens or creates Canvas keys', async t => {
    let active = user;
    const f = await fixture(t, { broker: async (operation, args, id) => {
        if (operation === 'profile') return active;
        assert.equal(id, active.id);
        if (operation === 'groups') return [group];
        if (operation === 'keys') return { items: [key], total: 1 };
        if (operation === 'key') { assert.equal(args.id, key.id); return key; }
        throw new Error('Unexpected write');
    } });
    assert.equal((await f.account.call('reuse')).source, 'desktop');
    assert.doesNotMatch(JSON.stringify(await f.store.read()), /token|must-not-leak/);
    await assert.rejects(f.account.call('configure', { account_id: 99, image_id: 8, text_id: 8 }), /账号已变更/);
    await f.account.call('configure', { account_id: user.id, image_id: 8, text_id: 8 });
    await assert.rejects(f.account.call('create-key', { account_id: user.id, group_id: 5 }), /客户端新建/);
    active = { ...user, id: 18 };
    const stale = await f.account.call('restore');
    assert.equal(stale.connected, false);
    assert.match(stale.error, /账号已切换/);
    assert.deepEqual(await f.vault.status(), { default: false, image: false, text: false, claude: false, gemini: false, grok: false, video: false });
    assert.equal((await f.account.call('reuse')).user.id, 18);
    await f.account.call('logout');
    assert.equal(active.id, 18);
    assert.equal(f.requests.length, 0);
});

test('offline restore keeps cached identity and existing keys for original workflows', async t => {
    const f = await fixture(t);
    await f.login();
    await f.account.call('configure', { account_id: user.id, image_id: 8, text_id: 8 });
    const offline = createAccount({ ...f.dependencies, fetcher: async () => { throw new Error('Network offline'); } });
    const state = await offline.call('restore');
    assert.equal(state.user.id, user.id);
    assert.equal(state.connected, false);
    assert.equal(state.user.avatar_url, avatar, 'Offline restart must keep the last account avatar');
    assert.deepEqual(await f.vault.status(), { default: true, image: true, text: true, claude: false, gemini: false, grok: false, video: false });
    const expired = createAccount({ ...f.dependencies, fetcher: async () => json({}, 401) });
    assert.equal((await expired.call('restore')).user, null);
    assert.deepEqual(await f.vault.status(), { default: false, image: false, text: false, claude: false, gemini: false, grok: false, video: false });
});

test('reads can fall back, writes with uncertain results are not replayed', async t => {
    const f = await fixture(t, { fetcher: (route, _init, url) => {
        if (route === '/settings/public') {
            if (url.startsWith('https://oneyes.ai/')) return json({}, 502);
            return json({});
        }
        throw new Error('Connection lost after write');
    } });
    await assert.rejects(f.login(), /未能确认/);
    assert.equal(f.requests.filter(r => r.pathname === '/settings/public').length, 2);
    assert.equal(f.requests.filter(r => r.pathname === '/auth/login').length, 1);
});

test('new Key reuses existing name/group, rejects inactive keys and unknown groups', async t => {
    const f = await fixture(t);
    await f.login();
    const selected = await f.account.call('create-key', { account_id: user.id, group_id: 5 });
    assert.equal(selected.id, key.id);
    assert.doesNotMatch(JSON.stringify(selected), /never-render/);
    assert.equal(f.requests.filter(r => r.pathname === '/keys' && r.init.method === 'POST').length, 0);
    await assert.rejects(f.account.call('create-key', { account_id: user.id, group_id: 999 }), /不可用/);
    const blocked = await fixture(t, { broker: async operation => operation === 'profile' ? user : operation === 'key' ? { ...key, status: 'disabled' } : null });
    await blocked.account.call('reuse');
    await assert.rejects(blocked.account.call('configure', { account_id: user.id, image_id: 8, text_id: 8 }), /停用/);
    assert.deepEqual(await blocked.vault.status(), { default: false, image: false, text: false, claude: false, gemini: false, grok: false, video: false });
});

test('new Key uses only an available group and a fixed ComfyUI name', async t => {
    let items = [], created = 0;
    const f = await fixture(t, { fetcher: (route, init) => {
        if (route === '/settings/public') return json({});
        if (route === '/auth/login') return json({ access_token: 'access', refresh_token: 'refresh', user });
        if (route === '/groups/available') return json([group]);
        if (route === '/keys' && init.method === 'GET') return json({ items, total: items.length });
        if (route === '/keys') {
            assert.deepEqual(JSON.parse(init.body), { name: 'ComfyUI_工作流', group_id: 5 });
            created++; items = [key]; return json(key);
        }
        throw new Error('Unexpected route');
    } });
    await f.login();
    await Promise.all([f.account.call('create-key', { account_id: user.id, group_id: 5 }), f.account.call('create-key', { account_id: user.id, group_id: 5 })]);
    assert.equal(created, 1);
});

test('authenticated local broker works over real pipe/socket and rejects unsafe endpoints', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'comfy-broker-'));
    const secret = randomBytes(32).toString('base64url');
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\OneYesCanvas-${randomBytes(8).toString('hex')}` : path.join(directory, 'canvas.sock');
    const connection = path.join(directory, 'connection.json');
    const server = net.createServer(socket => {
        socket.setEncoding('utf8');
        let text = '';
        socket.on('data', bytes => {
            text += bytes;
            if (!text.includes('\n')) return;
            const request = JSON.parse(text);
            assert.equal(request.secret, secret);
            assert.equal(request.operation, 'profile');
            socket.end(JSON.stringify({ data: { id: user.id } }) + '\n');
        });
    });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // mkdtemp creates private directories on POSIX.
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
    t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
    await writeFile(connection, JSON.stringify({ endpoint, secret }), { mode: 0o600 });
    assert.deepEqual(await brokerCall('profile', {}, undefined, directory), { id: user.id });
    await assert.rejects(brokerCall('create_key', {}, user.id, directory), /不支持/);
    await writeFile(connection, JSON.stringify({ endpoint: 'https://untrusted.test', secret }));
    await assert.rejects(brokerCall('profile', {}, undefined, directory), /无效/);
});
