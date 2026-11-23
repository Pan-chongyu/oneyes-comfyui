export async function mountAboutPanel(root, bridge = window.oneYesDesktop) {
    if (!bridge) { root.textContent = '请在 OneYes ComfyUI 桌面版中检查软件更新。'; return () => {}; }
    if (!document.querySelector('link[data-oneyes-panel]')) {
        const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = new URL('account-panel.css', import.meta.url).href; style.dataset.oneyesPanel = 'true'; document.head.append(style);
    }
    const response = await fetch(new URL('about-panel.html', import.meta.url));
    if (!response.ok) throw new Error('关于页面加载失败');
    const template = await response.text();
    if (!root.isConnected) return () => {};
    root.innerHTML = template;
    const $ = id => root.querySelector('#' + id);
    let current, busy = false;
    function render(state) {
        if (!root.isConnected) return;
        current = state;
        const update = state.update;
        $('update-version').textContent = `版本 v${state.version} · ${state.arch}`;
        $('macos-signing').hidden = state.platform !== 'darwin';
        $('update-label').textContent = ({ idle: '尚未检查更新', checking: '正在检查更新…', downloading: `正在下载 v${update.version} · ${Math.round(update.progress)}%`, ready: `v${update.version} 已准备好`, current: '当前已是最新版本', error: '更新未完成', installing: '正在安装并重新打开…' })[update.status] || update.status;
        $('update-detail').textContent = update.error || update.notes || '更新包经过签名和完整性校验。';
        $('update-progress').hidden = !['downloading', 'installing'].includes(update.status);
        $('update-progress').value = update.progress;
        $('install-update').hidden = update.status !== 'ready';
        $('install-update').disabled = busy;
        $('check-update').disabled = busy || ['checking', 'downloading', 'installing'].includes(update.status) || !update.supported;
    }
    async function action(callback) {
        if (busy) return;
        busy = true; $('update-message').textContent = '';
        if (current) render(current);
        try { await callback(); }
        catch (error) { if (root.isConnected) $('update-message').textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
        finally { busy = false; if (current) render(current); }
    }
    $('check-update').onclick = () => action(async () => { await bridge.checkUpdate(); render(await bridge.state()); });
    $('install-update').onclick = () => action(() => bridge.installUpdate());
    $('about-open-data').onclick = () => action(() => bridge.openData());
    const unsubscribe = bridge.onState(render);
    await bridge.state().then(render).catch(error => { if (root.isConnected) $('update-message').textContent = error.message; });
    return () => { unsubscribe(); root.replaceChildren(); };
}
