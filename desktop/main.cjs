const { app, BrowserWindow, Menu, Tray, ipcMain, shell, nativeImage, net, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRuntime } = require('./runtime.cjs');
const { createVault } = require('./vault.cjs');
const { createUpdater } = require('./updater.cjs');
const { updateTarget } = require('./update-platform.cjs');
const { prepareInstall } = require('./update-install.cjs');

app.setName('OneYes ComfyUI');
if (!app.requestSingleInstanceLock()) app.quit();
else {
    let launcher, viewer, tray, runtime, vault, updater, quitting = false, stopped = false;
    const settingsURL = pathToFileURL(path.join(__dirname, 'settings.html')).href;
    const windows = new Set();
    const send = () => { for (const window of windows) if (!window.isDestroyed()) window.webContents.send('oneyes:state', state()); };
    const state = () => ({ runtime: runtime.state(), update: updater.state(), version: app.getVersion(), platform: process.platform, arch: process.arch });
    function windowOptions() { return { width: 1020, height: 740, minWidth: 740, minHeight: 620, backgroundColor: '#191b20', title: 'OneYes ComfyUI', icon: path.join(__dirname, 'resources/icon.png'), titleBarStyle: 'hidden', ...(process.platform !== 'darwin' ? { titleBarOverlay: { color: '#191b20', symbolColor: '#d2d6e2', height: 40 } } : { trafficLightPosition: { x: 16, y: 14 } }), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } }; }
    function secureWindow(window, allowed) {
        windows.add(window);
        window.on('closed', () => windows.delete(window));
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
        window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
    }
    function settings() {
        if (!launcher || launcher.isDestroyed()) {
            launcher = new BrowserWindow(windowOptions());
            secureWindow(launcher, url => url === settingsURL);
            launcher.loadURL(settingsURL);
        }
        launcher.show(); launcher.focus();
    }
    function showCanvas() {
        if (!viewer || viewer.isDestroyed()) {
            viewer = new BrowserWindow({ ...windowOptions(), width: 1440, height: 960, titleBarStyle: 'default', titleBarOverlay: false });
            secureWindow(viewer, url => { try { return new URL(url).origin === runtime.state().url; } catch { return false; } });
            viewer.loadURL(runtime.state().url);
        }
        viewer.show(); viewer.focus();
        launcher?.hide();
    }
    async function launch() { await runtime.launch(); if (runtime.state().status === 'ready') showCanvas(); }
    function authorize(event, onlySettings = false) {
        const url = event.senderFrame?.url;
        if (!windows.has(BrowserWindow.fromWebContents(event.sender)) || event.senderFrame !== event.sender.mainFrame || (url !== settingsURL && (onlySettings || !runtime.state().url || !url?.startsWith(runtime.state().url + '/')))) throw new Error('请求来源无效');
    }
    function handle(name, action, onlySettings = false) {
        ipcMain.handle('oneyes:' + name, async (event, ...args) => { authorize(event, onlySettings); return action(...args); });
    }
    async function localRequest(route) {
        if (runtime.state().status !== 'ready') throw new Error('请先启动 ComfyUI，再刷新模型或任务列表');
        const response = await net.fetch(runtime.state().url + '/oneyes/' + route, { headers: { 'X-OneYes-Session': runtime.token() } });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || '暂时无法读取，请稍后重试');
        return value;
    }
    app.on('second-instance', () => viewer && !viewer.isDestroyed() ? (viewer.show(), viewer.focus()) : settings());
    app.whenReady().then(async () => {
        app.setAppUserModelId('ai.oneyes.comfyui');
        const directory = app.getPath('userData');
        const resources = app.isPackaged ? process.resourcesPath : __dirname;
        runtime = createRuntime({ resources, directory, changed: send });
        vault = createVault(directory);
        updater = createUpdater({ currentVersion: app.getVersion(), directory, target: () => updateTarget(), enabled: app.isPackaged, fetcher: (url, init) => net.fetch(url, init), changed: send, install: async plan => {
            const start = await prepareInstall(plan);
            await start();
            quitting = true;
            app.quit();
        } });
        session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
            if (runtime.state().url && details.url.startsWith(runtime.state().url + '/oneyes/') && [...windows].some(window => !window.isDestroyed() && window.webContents.id === details.webContentsId)) details.requestHeaders['X-OneYes-Session'] = runtime.token();
            callback({ requestHeaders: details.requestHeaders });
        });
        session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(permission === 'fullscreen' && details.isMainFrame && contents.mainFrame.url.startsWith(runtime.state().url + '/')));
        session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => permission === 'fullscreen' && details.isMainFrame && Boolean(runtime.state().url) && contents?.mainFrame.url.startsWith(runtime.state().url + '/'));
        handle('state', async () => ({ ...state(), configured: await vault.status() }));
        handle('settings', settings);
        handle('save-keys', async changes => { await vault.save(changes); return vault.status(); }, true);
        handle('launch', launch, true);
        handle('keys', () => shell.openExternal('https://oneyes.ai/keys'), true);
        handle('data', () => shell.openPath(directory), true);
        handle('models', profile => { if (!['default', 'image', 'text'].includes(profile)) throw new Error('Key 类型无效'); return localRequest('models/' + profile); }, true);
        handle('tasks', () => localRequest('tasks'), true);
        handle('update-check', () => updater.check(), true);
        handle('update-install', () => updater.apply(), true);
        const menu = [{ label: 'OneYes', submenu: [{ label: 'OneYes 设置', accelerator: 'CmdOrCtrl+,', click: settings }, { label: '打开画布', click: () => void launch().catch(settings) }, { label: '检查更新', click: () => { settings(); void updater.check(); } }, { type: 'separator' }, { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } }] }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }];
        Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
        let icon = nativeImage.createFromPath(path.join(__dirname, 'resources', process.platform === 'darwin' ? 'trayTemplate.png' : 'icon.png')).resize({ width: 18, height: 18 });
        if (process.platform === 'darwin') icon.setTemplateImage(true);
        tray = new Tray(icon);
        tray.setToolTip('OneYes ComfyUI');
        tray.setContextMenu(Menu.buildFromTemplate(menu[0].submenu));
        tray.on('click', settings);
        settings();
        await fs.mkdir(path.join(directory, 'ota'), { recursive: true });
        await fs.writeFile(path.join(directory, 'ota', `installed-${app.getVersion()}.ok`), 'ready');
        void updater.start();
        try { await fs.access(path.join(directory, 'runtime/oneyes-ready')); void launch().catch(settings); } catch {}
    });
    app.on('activate', () => runtime && settings());
    app.on('window-all-closed', () => {});
    app.on('before-quit', event => {
        quitting = true;
        if (stopped) return;
        event.preventDefault();
        updater?.close();
        void runtime?.stop().finally(() => { stopped = true; app.quit(); });
    });
}
