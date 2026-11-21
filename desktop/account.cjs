const { brokerCall } = require('./account-broker.cjs');

const bases = ['https://oneyes.ai/api/v1', 'https://api.oneyes.ai/api/v1'];
const KEY_NAME = 'ComfyUI_工作流';
function safeUser(value) {
    if (!Number.isSafeInteger(value?.id) || value.id <= 0) throw new Error('OneYes 账户资料无效');
    return { id: value.id, email: String(value.email || ''), username: String(value.username || ''), balance: Number(value.balance) || 0 };
}
function usable(key) {
    return key?.status === 'active' && !(key.expires_at && Date.parse(key.expires_at) <= Date.now()) && !(Number(key.quota) > 0 && Number(key.quota_used) >= Number(key.quota));
}
function safeKey(key) {
    return { id: key.id, name: String(key.name || ''), group_id: key.group_id, usable: usable(key), group: key.group ? { id: key.group.id, name: String(key.group.name || ''), platform: String(key.group.platform || '') } : null };
}
function createAccount({ store, vault, fetcher, broker = brokerCall }) {
    let session, access, challenge, connected = false, error = '', queue = Promise.resolve();
    const view = () => ({ user: session?.user || null, source: session?.source, profiles: session?.profiles, connected, error, requires_2fa: Boolean(challenge) });
    async function raw(method, path, payload, token) {
        for (let index = 0; index < bases.length; index++) {
            let response;
            try {
                response = await fetcher(bases[index] + path, {
                    method, redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json', 'Accept-Language': 'zh-CN', ...(token ? { Authorization: 'Bearer ' + token, 'X-User-UI-Request': '1' } : {}) },
                    ...(method === 'GET' ? {} : { body: JSON.stringify(payload || {}) }),
                });
            } catch {
                if (method === 'GET' && index + 1 < bases.length) continue;
                throw new Error(method === 'GET' ? '无法连接 OneYes，请检查网络后刷新' : '未能确认请求结果，请检查网络后重试；新建 Key 前请先刷新列表');
            }
            if (response.status >= 300 && response.status < 400) throw new Error('OneYes 接口发生重定向，已停止请求');
            if (method === 'GET' && index + 1 < bases.length && (response.status === 408 || response.status >= 500)) continue;
            const body = await response.json().catch(() => null);
            if (!response.ok || !body || (body.code !== undefined && body.code !== 0)) {
                const failure = new Error(response.status === 401 ? '登录已过期或邮箱、密码不正确，请重新登录' : response.status === 403 ? '账户或操作受到限制，请在官网确认' : response.status === 429 ? '操作过于频繁，请稍后重试' : `OneYes 请求未完成（${response.status}），请检查输入或在官网确认`);
                failure.status = response.status;
                throw failure;
            }
            return body.code !== undefined ? body.data : body;
        }
    }
    async function save(next) { await store.write(next); session = next; }
    async function accept(next, token) {
        if (next.user.id === session?.user?.id && session.profiles) next.profiles = session.profiles;
        await vault.clearAccount(next.user.id);
        await save(next);
        access = token; challenge = null; connected = true; error = '';
        return view();
    }
    async function refresh() {
        if (!session.refresh_token) throw new Error('请重新登录 OneYes');
        try {
            const data = await raw('POST', '/auth/refresh', { refresh_token: session.refresh_token });
            if (!data?.access_token) throw new Error('登录响应缺少令牌，请重新登录');
            await save({ ...session, refresh_token: data.refresh_token || session.refresh_token });
            access = data.access_token;
        } catch (failure) {
            connected = false;
            if ([401, 403].includes(failure.status)) { access = null; await vault.clearAccount(); await save({ disabled: true }); }
            throw failure;
        }
    }
    async function request(method, path, payload) {
        if (!access) await refresh();
        try { return await raw(method, path, payload, access); }
        catch (failure) {
            if (failure.status !== 401) throw failure;
            await refresh();
            return raw(method, path, payload, access);
        }
    }
    async function shared() { return accept({ source: 'desktop', user: safeUser(await broker('profile')) }); }
    async function listKeys() {
        const items = [], ids = new Set();
        for (let page = 1; ; page++) {
            const data = session.source === 'desktop' ? await broker('keys', { page }, session.user.id) : await request('GET', `/keys?page=${page}&page_size=100`);
            if (!Array.isArray(data?.items) || !Number.isSafeInteger(data.total) || data.total < 0) throw new Error('Key 列表格式无效，请刷新');
            for (const item of data.items) {
                if (!Number.isSafeInteger(item.id) || item.id <= 0 || ids.has(item.id)) throw new Error('Key 列表发生变化，请刷新');
                ids.add(item.id); items.push(item);
            }
            if (items.length >= data.total) return items;
            if (!data.items.length) throw new Error('Key 列表未读取完整，请刷新');
        }
    }
    async function groups() {
        const values = session.source === 'desktop' ? await broker('groups', {}, session.user.id) : await request('GET', '/groups/available');
        if (!Array.isArray(values)) throw new Error('分组列表格式无效，请刷新');
        return values.map(group => ({ id: group.id, name: String(group.name || ''), platform: String(group.platform || '') }));
    }
    async function key(id) {
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('请选择有效的 Key');
        const value = session.source === 'desktop' ? await broker('key', { id }, session.user.id) : await request('GET', `/keys/${id}`);
        if (value?.id !== id || !usable(value) || typeof value.key !== 'string' || !value.key.trim() || /[\r\n\0]/.test(value.key)) throw new Error('Key 已删除、停用、过期或额度耗尽，请刷新列表');
        return value.key;
    }
    async function call(operation, args = {}) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('账户参数无效');
        session ||= await store.read();
        if (operation === 'restore') {
            try {
                if (session.source === 'desktop') {
                    const user = safeUser(await broker('profile'));
                    if (user.id !== session.user?.id) { await vault.clearAccount(); connected = false; throw new Error('主客户端账号已切换，请点击重新连接'); }
                    return await accept({ ...session, user });
                }
                if (session.source === 'login') {
                    await refresh();
                    const user = safeUser(await request('GET', '/auth/me'));
                    if (user.id !== session.user?.id) { await vault.clearAccount(); access = null; await save({ disabled: true }); throw new Error('登录账号已变化，请重新登录'); }
                    return await accept({ ...session, user }, access);
                }
                if (!session.disabled) { try { return await shared(); } catch { /* Standalone login is available. */ } }
                return view();
            } catch (failure) { connected = false; error = failure.message; return view(); }
        }
        if (operation === 'reuse') return shared();
        if (operation === 'login' || operation === 'login-2fa') {
            let payload;
            if (operation === 'login') {
                challenge = null;
                if (typeof args.email !== 'string' || typeof args.password !== 'string' || !args.email.trim() || !args.password) throw new Error('请输入邮箱和密码');
                const settings = await raw('GET', '/settings/public');
                if (settings.turnstile_enabled || settings.tencent_captcha_enabled || settings.aliyun_captcha_enabled || settings.login_agreement_enabled) throw new Error('登录需要官网验证，请在 OneYes 客户端完成登录后复用登录态');
                payload = { email: args.email.trim(), password: args.password };
            } else {
                if (!challenge || typeof args.code !== 'string' || !args.code.trim()) throw new Error('请输入二次验证码，或重新登录');
                payload = { temp_token: challenge, totp_code: args.code.trim() };
            }
            const data = await raw('POST', operation === 'login' ? '/auth/login' : '/auth/login/2fa', payload);
            if (data?.requires_2fa && data.temp_token) { challenge = data.temp_token; return view(); }
            if (!data?.access_token || !data.refresh_token) throw new Error('登录响应不完整，请重新登录');
            return accept({ source: 'login', user: safeUser(data.user), refresh_token: data.refresh_token }, data.access_token);
        }
        if (operation === 'logout') {
            const old = session, token = access;
            await vault.clearAccount();
            await save({ disabled: true }); access = null; challenge = null; connected = false; error = '';
            if (old.source === 'login' && old.refresh_token) {
                try { await raw('POST', '/auth/logout', { refresh_token: old.refresh_token }, token); } catch { /* Local logout is durable even offline. */ }
            }
            return view();
        }
        if (!session.user || args.account_id !== session.user.id) throw new Error('登录账号已变更，请重新连接');
        if (operation === 'catalog') return { groups: await groups(), keys: (await listKeys()).map(safeKey) };
        if (operation === 'auto-configure') {
            const configured = await vault.status();
            if (configured.default || (configured.image && configured.text)) return view();
            try {
                if (!connected) return view();
                const availableGroups = await groups(), keys = (await listKeys()).filter(usable);
                const groupFor = value => availableGroups.find(group => group.id === value.group_id) || value.group || {};
                const rank = value => { const group = groupFor(value); return (/^svip$/i.test(group.name) ? 20 : /^vip$/i.test(group.name) ? 10 : 0) + (value.name === KEY_NAME ? 1 : 0); };
                let image = keys.filter(value => /^openai$/i.test(groupFor(value).platform)).sort((a, b) => rank(b) - rank(a) || a.id - b.id)[0];
                if (!image && !configured.image && session.source === 'login') {
                    const group = availableGroups.filter(value => /^openai$/i.test(value.platform) && /^(s?vip)$/i.test(value.name)).sort((a, b) => Number(/^svip$/i.test(b.name)) - Number(/^svip$/i.test(a.name)) || a.id - b.id)[0];
                    if (group) image = await call('create-key', { account_id: session.user.id, group_id: group.id });
                }
                const text = keys.find(value => /^deepseek$/i.test(groupFor(value).platform) && /^deepseek$/i.test(groupFor(value).name)) || image;
                const changes = {}, profiles = { ...session.profiles };
                if (!configured.image && image) { changes.image = await key(image.id); changes.default = changes.image; profiles.image = image.id; }
                if (!configured.text && text) { changes.text = image?.id === text.id && changes.image ? changes.image : await key(text.id); profiles.text = text.id; }
                if (Object.keys(changes).length) { await vault.saveAccount(session.user.id, changes); await save({ ...session, profiles }); }
                error = !configured.image && !image ? '已登录，暂无可用的图片 Key；请选择或新建 Key，也可直接打开本地画布。' : '';
            } catch (failure) { error = `已登录，自动配置未完成：${failure.message}。可在下方选择 Key。`; }
            return view();
        }
        if (operation === 'configure') {
            const image = await key(args.image_id), text = args.text_id === args.image_id ? image : await key(args.text_id);
            await vault.saveAccount(session.user.id, { default: image, image, text });
            await save({ ...session, profiles: { image: args.image_id, text: args.text_id } });
            connected = true; error = '';
            return { configured: await vault.status() };
        }
        if (operation === 'create-key') {
            if (session.source !== 'login') throw new Error('复用模式请在 OneYes 客户端新建 Key 后刷新，或退出后在本软件直接登录创建');
            if (!Number.isSafeInteger(args.group_id) || !(await groups()).some(group => group.id === args.group_id)) throw new Error('所选分组已不可用，请刷新');
            const matches = (await listKeys()).filter(item => item.name === KEY_NAME && item.group_id === args.group_id).sort((a, b) => a.id - b.id);
            if (matches.length) {
                const existing = matches.find(usable);
                if (!existing) throw new Error('该分组的 ComfyUI Key 已停用、过期或额度耗尽，请先在官网处理');
                return safeKey(existing);
            }
            const created = await request('POST', '/keys', { name: KEY_NAME, group_id: args.group_id });
            if (!Number.isSafeInteger(created?.id) || created.group_id !== args.group_id || !usable(created)) throw new Error('新建 Key 结果待确认，请先刷新列表');
            return safeKey(created);
        }
        throw new Error('不支持的账户操作');
    }
    return {
        state: view,
        call(operation, args) {
            const next = queue.then(() => call(operation, args));
            queue = next.catch(() => {});
            return next;
        },
    };
}
module.exports = { createAccount, usable };
