const { app, BrowserWindow, Menu, Tray, ipcMain, shell, nativeImage, net, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRuntime } = require('./runtime.cjs');
const { createVault, createEncryptedStore } = require('./vault.cjs');
const { createAccount } = require('./account.cjs');
const { createUpdater } = require('./updater.cjs');
const { updateTarget } = require('./update-platform.cjs');
const { prepareInstall } = require('./update-install.cjs');

app.setName('OneYes ComfyUI');
if (!app.requestSingleInstanceLock()) app.quit();
else {
    let viewer, tray, runtime, vault, account, updater, pendingSection, canvasLoading, quitting = false, stopped = false;
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
        if (!viewer || viewer.isDestroyed()) {
            viewer = new BrowserWindow({ width: 1440, height: 960, minWidth: 740, minHeight: 620, backgroundColor: '#18181a', title: 'OneYes ComfyUI', icon: path.join(__dirname, 'resources/icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
            viewer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            viewer.webContents.on('will-navigate', (event, url) => { if (url !== bootURL && !canvasURL(url)) event.preventDefault(); });
            viewer.webContents.on('did-finish-load', () => { if (canvasURL(viewer.webContents.getURL())) openPendingSettings(); });
            viewer.on('close', event => { if (!quitting) { event.preventDefault(); viewer.hide(); } });
            void viewer.loadURL(bootURL);
        }
        viewer.show(); viewer.focus();
    }
    async function launch() {
        try {
            await runtime.launch();
            if (runtime.state().status === 'ready' && !canvasURL(viewer.webContents.getURL())) {
                canvasLoading ||= viewer.loadURL(runtime.state().url).finally(() => { canvasLoading = undefined; });
                await canvasLoading;
            }
        } catch {
            if (viewer.webContents.getURL() !== bootURL) await viewer.loadURL(bootURL);
        }
    }
    async function connect(operation, args) {
        const result = await account.call(operation, args);
        if (['restore', 'reuse', 'login', 'login-2fa'].includes(operation) && result.connected && !result.requires_2fa) return account.call('auto-configure', { account_id: result.user.id });
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
        account = createAccount({ store: createEncryptedStore(directory, 'account.json'), vault, fetcher: (url, init) => net.fetch(url, init) });
        updater = createUpdater({ currentVersion: app.getVersion(), directory, target: () => updateTarget(), enabled: app.isPackaged, fetcher: (url, init) => net.fetch(url, init), changed: send, install: async plan => {
            const start = await prepareInstall(plan);
            await start();
            quitting = true;
            app.quit();
        } });
        session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
            if (runtime.state().url && details.url.startsWith(runtime.state().url + '/oneyes/') && viewer?.webContents.id === details.webContentsId) details.requestHeaders['X-OneYes-Session'] = runtime.token();
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
        handle('data', () => shell.openPath(directory));
        handle('models', profile => { if (!['default', 'image', 'text'].includes(profile)) throw new Error('Key 类型无效'); return localRequest('models/' + profile); }, true);
        handle('tasks', () => localRequest('tasks'), true);
        handle('update-check', () => updater.check(), true);
        handle('update-install', () => updater.apply(), true);
        const menu = [{ label: 'OneYes', submenu: [{ label: 'OneYes 账户与 Key', accelerator: 'CmdOrCtrl+,', click: () => void settings() }, { label: '打开画布', click: showWindow }, { label: '检查更新', click: () => { void settings('updates'); void updater.check(); } }, { type: 'separator' }, { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } }] }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }];
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
    app.on('before-quit', event => {
        quitting = true;
        if (stopped) return;
        event.preventDefault();
        updater?.close();
        void runtime?.stop().finally(() => { stopped = true; app.quit(); });
    });
}
