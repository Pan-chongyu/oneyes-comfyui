const { app, BrowserWindow, Menu, Tray, ipcMain, shell, nativeImage, net, session, dialog, clipboard } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRuntime } = require('./runtime.cjs');
const { createVault, createEncryptedStore } = require('./vault.cjs');
const { createAccount } = require('./account.cjs');
const { createWebsiteLogin } = require('./website-login.cjs');
const { createUpdater } = require('./updater.cjs');
const { updateTarget } = require('./update-platform.cjs');
const { prepareInstall } = require('./update-install.cjs');
const { attachNativeUI } = require('./native-ui.cjs');

app.setName('OneYes ComfyUI');
if (!app.requestSingleInstanceLock()) app.quit();
else {
    let viewer, nativeUI, tray, runtime, vault, account, updater, pendingSection, canvasLoading, shutdown, quitting = false, stopped = false;
    const bootURL = pathToFileURL(path.join(__dirname, 'boot.html')).href;
    const send = () => { if (viewer && !viewer.isDestroyed()) viewer.webContents.send('oneyes:state', state()); };
    const state = () => ({ runtime: runtime.state(), update: updater.state(), account: account.state(), version: app.getVersion(), platform: process.platform, arch: process.arch });
    function canvasURL(url) {
        try { const value = new URL(url); return value.origin === runtime.state().url && value.pathname === '/'; } catch { return false; }
    }
    async function settings(section = 'account') {
        pendingSection = ['account', 'models', 'tasks', 'updates'].includes(section) ? section : 'account';
        showWindow();
        await launch();
        if (canvasURL(viewer.webContents.getURL()) && !viewer.webContents.isLoadingMainFrame()) openPendingSettings();
    }
    function openPendingSettings() {
        if (!pendingSection) return;
        viewer.webContents.send('oneyes:open-settings', pendingSection);
        pendingSection = undefined;
    }
    function showWindow() {
        if (quitting) return;
        if (!viewer || viewer.isDestroyed()) {
            viewer = new BrowserWindow({ width: 1440, height: 960, minWidth: 740, minHeight: 620, backgroundColor: '#18181a', title: 'OneYes ComfyUI', icon: path.join(__dirname, 'resources/icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
            nativeUI = attachNativeUI(viewer, () => canvasURL(viewer.webContents.getURL()));
            viewer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            viewer.webContents.on('will-navigate', (event, url) => { if (url !== bootURL && !canvasURL(url)) event.preventDefault(); });
            viewer.webContents.on('did-finish-load', () => { if (canvasURL(viewer.webContents.getURL())) openPendingSettings(); });
            viewer.webContents.on('will-prevent-unload', event => {
                if (!quitting) return;
                const choice = dialog.showMessageBoxSync(viewer, {
                    type: 'question', title: '退出 OneYes ComfyUI',
                    message: '工作流有未保存的修改，是否退出？',
                    detail: '选择“返回保存”可继续编辑并先保存工作流。',
                    buttons: ['返回保存', '退出'], defaultId: 0, cancelId: 0,
                });
                if (choice === 1) event.preventDefault();
                else { quitting = false; showWindow(); }
            });
            viewer.on('close', event => { if (!quitting) { event.preventDefault(); viewer.hide(); } });
            void viewer.loadURL(bootURL);
        }
        viewer.show(); viewer.focus();
    }
    async function launch() {
        try {
            await runtime.launch();
            if (quitting || viewer.isDestroyed()) return;
            if (runtime.state().status === 'ready' && !canvasURL(viewer.webContents.getURL())) {
                canvasLoading ||= viewer.loadURL(runtime.state().url).finally(() => { canvasLoading = undefined; });
                await canvasLoading;
            }
        } catch {
            if (quitting || viewer.isDestroyed()) return;
            if (viewer.webContents.getURL() !== bootURL) await viewer.loadURL(bootURL);
        }
    }
    async function connect(operation, args) {
        const result = await account.call(operation, args);
        if (['restore', 'reuse', 'login', 'login-2fa', 'website-login'].includes(operation) && result.connected && !result.requires_2fa) return account.call('auto-configure', { account_id: result.user.id });
        return result;
    }
    function authorize(event, requiresCanvas = false) {
        const url = event.senderFrame?.url;
        if (event.sender !== viewer?.webContents || event.senderFrame !== event.sender.mainFrame || (!canvasURL(url) && (requiresCanvas || url !== bootURL))) throw new Error('请求来源无效');
    }
    function handle(name, action, requiresCanvas = false) {
        ipcMain.handle('oneyes:' + name, async (event, ...args) => { authorize(event, requiresCanvas); return action(...args); });
    }
    async function localRequest(route) {
        if (runtime.state().status !== 'ready') throw new Error('请先启动 ComfyUI，再刷新模型或任务列表');
        const response = await net.fetch(runtime.state().url + '/oneyes/' + route, { headers: { 'X-OneYes-Session': runtime.token() } });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || '暂时无法读取，请稍后重试');
        return value;
    }
    app.on('second-instance', () => { if (runtime) showWindow(); });
    app.whenReady().then(async () => {
        app.setAppUserModelId('ai.oneyes.comfyui');
        const directory = app.getPath('userData');
        const resources = app.isPackaged ? process.resourcesPath : __dirname;
        runtime = createRuntime({ resources, directory, changed: send });
        vault = createVault(directory);
        account = createAccount({ store: createEncryptedStore(directory, 'account.json'), vault, fetcher: (url, init) => net.fetch(url, init), websiteLogin: createWebsiteLogin(() => viewer) });
        updater = createUpdater({ currentVersion: app.getVersion(), directory, target: () => updateTarget(), enabled: app.isPackaged, fetcher: (url, init) => net.fetch(url, init), changed: send, install: async plan => {
            const start = await prepareInstall(plan);
            await start();
            quitting = true;
            app.quit();
        } });
        session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
            if (runtime.state().url && ['/oneyes/', '/api/oneyes/'].some(prefix => details.url.startsWith(runtime.state().url + prefix)) && viewer?.webContents.id === details.webContentsId) details.requestHeaders['X-OneYes-Session'] = runtime.token();
            callback({ requestHeaders: details.requestHeaders });
        });
        session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(permission === 'fullscreen' && details.isMainFrame && contents.mainFrame.url.startsWith(runtime.state().url + '/')));
        session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => permission === 'fullscreen' && details.isMainFrame && Boolean(runtime.state().url) && contents?.mainFrame.url.startsWith(runtime.state().url + '/'));
        handle('state', async () => ({ ...state(), configured: await vault.status() }));
        handle('settings', settings, true);
        handle('save-keys', async changes => { await vault.save(changes); return vault.status(); }, true);
        handle('account', async (operation, args) => {
            try {
                return await connect(operation, args);
            }
            finally { send(); }
        }, true);
        handle('launch', launch);
        handle('keys', () => shell.openExternal('https://oneyes.ai/keys'), true);
        handle('account-page', page => {
            if (!['register', 'forgot-password'].includes(page)) throw new Error('账户页面无效');
            return shell.openExternal('https://oneyes.ai/' + page);
        }, true);
        handle('data', () => shell.openPath(directory));
        handle('native-confirm', options => nativeUI.confirm(options), true);
        handle('copy-text', value => { if (typeof value !== 'string') throw new Error('复制内容无效'); clipboard.writeText(value); }, true);
        handle('models', profile => { if (!['default', 'image', 'text', 'claude', 'gemini', 'grok', 'video'].includes(profile)) throw new Error('Key 类型无效'); return localRequest('models/' + profile); }, true);
        handle('tasks', () => localRequest('tasks'), true);
        handle('update-check', () => updater.check(), true);
        handle('update-install', () => updater.apply(), true);
        const menu = [
            { label: 'OneYes', submenu: [{ label: 'OneYes 账户与 Key', accelerator: 'CmdOrCtrl+,', click: () => void settings() }, { label: '打开画布', click: showWindow }, { label: '检查更新', click: () => { void settings('updates'); void updater.check(); } }, { type: 'separator' }, { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } }] },
            { label: '编辑', submenu: [
                { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
                { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' },
                { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' }, { role: 'delete', label: '删除' }, { role: 'selectAll', label: '全选' },
            ] },
            { label: '视图', submenu: [
                { role: 'reload', label: '重新加载' }, { role: 'forceReload', label: '强制重新加载' }, { role: 'toggleDevTools', label: '开发者工具' }, { type: 'separator' },
                { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { type: 'separator' }, { role: 'togglefullscreen', label: '切换全屏' },
            ] },
            { role: 'windowMenu', label: '窗口', submenu: [
                { role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放窗口' },
                ...(process.platform === 'darwin' ? [{ type: 'separator' }, { role: 'front', label: '全部置于前面' }] : [{ role: 'close', label: '关闭窗口' }]),
            ] },
        ];
        Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
        let icon = nativeImage.createFromPath(path.join(__dirname, 'resources', process.platform === 'darwin' ? 'trayTemplate.png' : 'icon.png'));
        if (process.platform === 'darwin') icon.setTemplateImage(true);
        else icon = icon.resize({ width: 18, height: 18 });
        tray = new Tray(icon);
        tray.setToolTip('OneYes ComfyUI');
        tray.setContextMenu(Menu.buildFromTemplate(menu[0].submenu));
        tray.on('click', showWindow);
        showWindow();
        void launch();
        void connect('restore').finally(send).catch(() => {});
        await fs.mkdir(path.join(directory, 'ota'), { recursive: true });
        await fs.writeFile(path.join(directory, 'ota', `installed-${app.getVersion()}.ok`), 'ready');
        void updater.start();
    });
    app.on('activate', () => { if (runtime) showWindow(); });
    app.on('window-all-closed', () => {});
    app.on('before-quit', () => { quitting = true; });
    app.on('will-quit', event => {
        if (stopped) return;
        event.preventDefault();
        if (shutdown) return;
        updater?.close();
        shutdown = (runtime ? runtime.stop() : Promise.resolve())
            .catch(error => console.error('无法停止 ComfyUI 引擎：', error))
            .finally(() => { stopped = true; tray?.destroy(); app.quit(); });
    });
}
