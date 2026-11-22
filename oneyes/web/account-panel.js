export async function mountAccountPanel(root, bridge = window.oneYesDesktop) {
    if (!bridge) { root.textContent = '请在 OneYes ComfyUI 桌面版中登录，浏览器使用可通过节点中的 OneYes 设置填写 Key。'; return () => {}; }
    if (!document.querySelector('link[data-oneyes-panel]')) {
        const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = new URL('account-panel.css', import.meta.url).href; style.dataset.oneyesPanel = 'true'; document.head.append(style);
    }
    const response = await fetch(new URL('account-panel.html', import.meta.url));
    if (!response.ok) throw new Error('OneYes 设置加载失败');
    const template = await response.text();
    if (!root.isConnected) return () => {};
    root.innerHTML = template;
    const { section: initialSection } = await import('/oneyes-native.js');
    const $ = id => root.querySelector('#' + id);
    const profiles = ['default', 'image', 'text', 'claude', 'gemini', 'grok', 'video'];
    let current, modelValues = [], accountBusy = false, catalogFor = '', twoFactor = false;
    let avatarIdentity = '';
    const avatar = $('account-avatar'), avatarFallback = $('account-avatar-fallback');
    avatar.onload = () => { avatar.hidden = false; avatarFallback.style.display = 'none'; };
    avatar.onerror = () => { avatar.hidden = true; avatarFallback.style.display = ''; };
    const message = value => { if ($('message')) $('message').textContent = value; };
    const action = (id, callback) => {
        const button = $(id);
        button.addEventListener('click', async () => { button.disabled = true; message(''); try { await callback(); } catch (error) { message(error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); } finally { button.disabled = false; } });
    };
    function navigate(event) {
        const selected = typeof event === 'string' ? event : event.detail;
        for (const button of root.querySelectorAll('nav button')) {
            const active = button.dataset.tab === selected;
            button.classList.toggle('selected', active);
            button.setAttribute('aria-selected', String(active));
            button.tabIndex = active ? 0 : -1;
        }
        root.querySelectorAll('.page').forEach(page => page.hidden = page.id !== selected);
        message('');
    }
    for (const button of root.querySelectorAll('nav button')) {
        button.onclick = () => navigate(button.dataset.tab);
        button.onkeydown = event => {
            const buttons = [...root.querySelectorAll('nav button')];
            let index = buttons.indexOf(button);
            if (event.key === 'ArrowRight') index = (index + 1) % buttons.length;
            else if (event.key === 'ArrowLeft') index = (index + buttons.length - 1) % buttons.length;
            else if (event.key === 'Home') index = 0;
            else if (event.key === 'End') index = buttons.length - 1;
            else return;
            event.preventDefault(); buttons[index].focus(); navigate(buttons[index].dataset.tab);
        };
    }
    window.addEventListener('oneyes:panel', navigate);
    navigate(initialSection);
    function configured(values) { for (const name of profiles) $(name + '-configured').textContent = values[name] ? '已保存' : ''; }
    function render(state) {
        if (!root.isConnected) return;
        current = state;
        $('version').textContent = 'v' + state.version;
        $('update-version').textContent = `当前版本 v${state.version} · ${state.arch}`;
        if (state.platform === 'darwin') root.classList.add('macos');
        if (state.configured) configured(state.configured);
        renderAccount(state.account);
        const update = state.update;
        $('update-label').textContent = ({ idle: '尚未检查更新', checking: '正在检查更新…', downloading: `正在下载 v${update.version} · ${Math.round(update.progress)}%`, ready: `v${update.version} 已准备好`, current: '当前已是最新版本', error: '更新未完成', installing: '正在安装并重新打开…' })[update.status] || update.status;
        $('update-detail').textContent = update.error || update.notes || '更新清单采用独立 Ed25519 签名，下载后校验 SHA-256。';
        $('update-progress').hidden = !['downloading', 'installing'].includes(update.status);
        $('update-progress').value = update.progress;
        $('install-update').hidden = update.status !== 'ready';
        $('check-update').disabled = ['checking', 'downloading', 'installing'].includes(update.status) || !update.supported;
    }
    function renderAccount(account) {
        if (!root.isConnected) return;
        const user = account?.user;
        const identity = `${user?.id || ''}:${user?.avatar_url || ''}`;
        if (avatarIdentity !== identity) {
            avatarIdentity = identity;
            avatar.hidden = true; avatarFallback.style.display = '';
            if (user?.avatar_url) avatar.src = user.avatar_url;
            else avatar.removeAttribute('src');
        }
        $('account-entry').hidden = Boolean(user);
        $('account-summary').hidden = !user;
        twoFactor = Boolean(account?.requires_2fa);
        $('login-fields').hidden = twoFactor;
        $('totp-fields').hidden = !twoFactor;
        $('cancel-totp').hidden = !twoFactor;
        $('login-email').required = $('login-password').required = !twoFactor;
        $('login-code').required = twoFactor;
        $('login-submit').textContent = accountBusy ? '正在连接…' : twoFactor ? '验证并登录' : '登录 OneYes';
        $('account-panel').setAttribute('aria-busy', String(accountBusy));
        for (const button of $('account-panel').querySelectorAll('button')) button.disabled = accountBusy;
        const selected = Boolean($('account-image').value && $('account-text').value);
        const changed = profiles.slice(1).some(role => Number($('account-' + role).value) !== Number(account?.profiles?.[role] || 0));
        $('use-account-keys').disabled = accountBusy || !account?.connected || !selected;
        $('use-account-keys').textContent = accountBusy ? '正在处理…' : selected && !changed ? '重新应用 Key' : '应用所选 Key';
        $('key-selection-state').textContent = accountBusy ? '正在同步配置…' : !account?.connected ? '等待连接' : !selected ? '请选择可用 Key' : changed ? '有更改，应用后生效' : '选择已保存';
        $('key-selection-state').dataset.state = !accountBusy && account?.connected && selected && !changed ? 'saved' : 'pending';
        for (const select of $('account-keys').querySelectorAll('select')) {
            select.disabled = accountBusy || !account?.connected;
            select.title = select.selectedOptions[0]?.textContent || '';
        }
        $('refresh-account').classList.toggle('busy', accountBusy);
        $('create-account-key').disabled = accountBusy || !account?.connected || !$('new-key-group').value;
        $('account-status').textContent = account?.error || (user && !account.connected ? '暂未连接，已保存的 Key 仍可用于原工作流。请刷新重试。' : '');
        $('account-status').hidden = !$('account-status').textContent;
        $('account-source').dataset.connected = String(Boolean(account?.connected));
        if (!user) { catalogFor = ''; $('account-image').replaceChildren(); $('account-text').replaceChildren(); return; }
        $('account-name').textContent = user.username || user.email || 'OneYes 用户';
        $('account-email').textContent = user.email;
        $('account-source').textContent = account.source === 'desktop' ? '已复用客户端登录' : 'OneYes 账号登录';
        $('account-balance').textContent = '$' + Number(user.balance || 0).toLocaleString('zh-CN', { maximumFractionDigits: 4 });
        $('reconnect-account').hidden = account.source !== 'desktop' || account.connected;
        $('create-key-section').hidden = account.source !== 'login';
        const catalogIdentity = `${user.id}:${account.source}`;
        if (!accountBusy && account.connected && catalogFor !== catalogIdentity) { catalogFor = catalogIdentity; void loadCatalog().catch(error => message(error.message)); }
    }
    async function runAccount(callback) {
        if (accountBusy) return;
        accountBusy = true; message(''); renderAccount(current?.account);
        try { await callback(); }
        catch (error) { message(error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); }
        finally { accountBusy = false; render(await bridge.state()); }
    }
    async function loadCatalog(preferredId) {
        const user = current?.account?.user;
        if (!user) return;
        const identity = `${user.id}:${current.account.source}`;
        const data = await bridge.account('catalog', { account_id: user.id });
        if (!root.isConnected) return;
        if (!current.account?.connected || `${current.account.user?.id}:${current.account.source}` !== identity) return;
        const available = data.keys.filter(key => key.usable);
        const groupFor = key => data.groups.find(group => group.id === key.group_id) || key.group || {};
        function platformScore(key, role) {
            const group = groupFor(key), platform = group.platform?.toLowerCase(), name = group.name?.trim().toLowerCase();
            if (role === 'video') return platform === 'grok' && name === 'video' ? 30 : 0;
            if (role === 'grok') return platform === 'grok' && name !== 'video' ? 30 : 0;
            if (role === 'claude') return /^(anthropic|claude)$/.test(platform) ? 30 : 0;
            if (role === 'gemini') return /^(google|gemini)$/.test(platform) ? 30 : 0;
            if (role === 'text' && platform === 'deepseek') return 20;
            return platform === 'openai' ? name === 'svip' ? 15 : name === 'vip' ? 10 : 5 : 0;
        }
        for (const role of ['image', 'text', 'claude', 'gemini', 'grok', 'video']) {
            const select = $('account-' + role), old = select.value;
            const native = !['image', 'text'].includes(role);
            select.replaceChildren(new Option(native ? '使用默认 Key' : available.length ? '请选择 Key' : '暂无可用 Key', ''));
            for (const key of data.keys) {
                const group = groupFor(key), option = new Option(`${key.name || 'Key ' + key.id} · ${group.platform || '平台'} / ${group.name || key.group_id}${key.usable ? '' : '（不可用）'}`, String(key.id));
                option.disabled = !key.usable; select.add(option);
            }
            const ranked = available.slice().sort((a, b) => {
                return platformScore(b, role) - platformScore(a, role) || a.id - b.id;
            });
            const saved = current.account.profiles?.[role];
            const preferred = available.find(key => key.id === preferredId && platformScore(key, role));
            select.value = preferred ? String(preferred.id) : available.some(key => key.id === saved) ? String(saved) : available.some(key => String(key.id) === old) ? old : ranked[0] && platformScore(ranked[0], role) ? String(ranked[0].id) : '';
        }
        $('new-key-group').replaceChildren(new Option('请选择分组', ''));
        for (const group of data.groups) $('new-key-group').add(new Option(`${group.platform} / ${group.name}`, String(group.id)));
        $('account-key-hint').textContent = !available.length ? current.account.source === 'desktop' ? '还没有可用 Key。请在 OneYes 客户端新建后刷新，或退出后直接登录本软件创建。' : '还没有可用 Key。可在下方为所需分组新建，再应用所选 Key。' : '';
        $('account-key-hint').hidden = Boolean(available.length);
        renderAccount(current.account);
    }
    $('login-form').addEventListener('submit', event => {
        event.preventDefault();
        void runAccount(async () => {
            const args = twoFactor ? { code: $('login-code').value } : { email: $('login-email').value, password: $('login-password').value };
            try {
                const account = await bridge.account(twoFactor ? 'login-2fa' : 'login', args);
                render({ ...current, account });
                if (account.requires_2fa) $('login-code').focus();
                else message(account.error || '登录成功，已自动配置可用 Key，可以关闭设置开始创作。');
            } finally { $('login-password').value = ''; $('login-code').value = ''; }
        });
    });
    $('reuse-account').onclick = () => void runAccount(async () => { const account = await bridge.account('reuse'); render({ ...current, account }); message(account.error || '已复用登录态，自动配置可用 Key，可以开始创作。'); });
    $('website-login').onclick = () => void runAccount(async () => { const account = await bridge.account('website-login'); render({ ...current, account }); message(account.error || '已独立登录并配置可用 Key，可以开始创作。'); });
    $('reconnect-account').onclick = $('reuse-account').onclick;
    $('logout-account').onclick = () => void runAccount(async () => {
        if (!window.confirm('退出本软件并清除从该账号导入的 Key？不会退出 OneYes 客户端。原图片任务取回仍需要原 Key。')) return;
        await bridge.account('logout'); message('已退出本软件，手动填写的 Key 保持不变。');
    });
    $('cancel-totp').onclick = () => void runAccount(async () => { await bridge.account('logout'); $('login-code').value = ''; });
    $('refresh-account').onclick = () => void runAccount(async () => { const account = await bridge.account('restore'); render({ ...current, account }); if (account.connected) await loadCatalog(); });
    $('account-keys').addEventListener('submit', event => {
        event.preventDefault();
        void runAccount(async () => {
            const result = await bridge.account('configure', { account_id: current.account.user.id, ...Object.fromEntries(profiles.filter(name => name !== 'default').map(name => [name + '_id', Number($('account-' + name).value)])) });
            configured(result.configured); message('已配置节点与平台 Key，可以关闭设置开始创作。');
        });
    });
    $('create-account-key').onclick = () => void runAccount(async () => {
        const key = await bridge.account('create-key', { account_id: current.account.user.id, group_id: Number($('new-key-group').value) });
        await loadCatalog(key.id); message('Key 已准备好，请确认用途并点击“应用所选 Key”。');
    });
    for (const id of ['account-image', 'account-text', 'account-claude', 'account-gemini', 'account-grok', 'account-video', 'new-key-group']) $(id).onchange = () => renderAccount(current.account);
    $('key-form').addEventListener('submit', async event => {
        event.preventDefault(); const button = event.submitter; button.disabled = true;
        try {
            const changes = {};
            for (const name of profiles) if ($(name + '-key').value.trim()) changes[name] = $(name + '-key').value.trim();
            if (!Object.keys(changes).length) { message('请填写要保存的 Key；留空会保留现有设置。'); return; }
            configured(await bridge.saveKeys(changes));
            for (const name of profiles) $(name + '-key').value = '';
            message('Key 已保存，可以关闭设置开始创作。');
        } catch (error) { message(error.message); } finally { button.disabled = false; }
    });
    action('clear-keys', async () => { if (window.confirm('清除本机已保存的全部 OneYes Key？原任务取回需要重新填写原 Key。')) { configured(await bridge.saveKeys(Object.fromEntries(profiles.map(name => [name, ''])))); message('已清除本机 Key'); } });
    $('toggle-key').onclick = () => { const hidden = $('default-key').type === 'password'; $('default-key').type = hidden ? 'text' : 'password'; $('toggle-key').textContent = hidden ? '隐藏' : '显示'; };
    action('register-account', () => bridge.openAccountPage('register'));
    action('forgot-password', () => bridge.openAccountPage('forgot-password'));
    action('open-data', () => bridge.openData());
    action('check-update', () => bridge.checkUpdate());
    action('install-update', () => bridge.installUpdate());
    function renderModels() {
        $('model-list').replaceChildren();
        const values = modelValues.filter(value => value.toLowerCase().includes($('model-search').value.toLowerCase()));
        if (!values.length) $('model-list').textContent = '没有匹配的模型，请检查 Key 分组或搜索条件。';
        for (const model of values) { const button = document.createElement('button'); button.textContent = model; button.onclick = async () => { await navigator.clipboard.writeText(model); message('已复制模型 ID，可粘贴到节点的模型输入框。'); }; $('model-list').append(button); }
    }
    action('refresh-models', async () => { const data = await bridge.models($('model-profile').value); modelValues = data.models; renderModels(); message(`已读取 ${modelValues.length} 个模型`); });
    $('model-search').oninput = renderModels;
    action('refresh-tasks', async () => {
        const { tasks } = await bridge.tasks(); $('task-list').replaceChildren();
        if (!tasks.length) $('task-list').textContent = '还没有云端任务。运行异步图片或 Grok 视频节点后，会在这里保存记录。';
        const labels = {submitting:'提交结果待核对',unknown:'提交结果待核对',processing:'生成中，可取回',completed:'已完成',failed:'原任务失败',cancelled:'已取消'};
        for (const task of tasks) {
            const row = document.createElement('div'); row.className = 'task-item';
            const title = document.createElement('strong'); title.textContent = `${task.model} · ${labels[task.status] || task.status}`;
            const details = document.createElement('p'); details.textContent = `${new Date(task.created).toLocaleString()}　${task.remote_id || '未收到服务端回执，请先在官网核对'} `;
            const copy = document.createElement('button'); copy.className='quiet'; copy.textContent='复制本地任务编号'; copy.onclick=async () => { await navigator.clipboard.writeText(task.id); message(task.kind === 'video' ? '已复制。视频请保持原参数和种子，重新运行原视频节点取回，不会重复生成。' : '已复制，粘贴到“取回原图片任务”节点即可。'); };
            row.append(title, details, copy); $('task-list').append(row);
        }
    });
    const unsubscribe = bridge.onState(render);
    await bridge.state().then(render).catch(error => message(error.message));
    return () => { unsubscribe(); window.removeEventListener('oneyes:panel', navigate); root.replaceChildren(); };

}
