const { BrowserWindow, ipcMain, session } = require('electron');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

function createWebsiteLogin(parent) {
    let window, pending;
    return () => {
        if (pending) { window.show(); window.focus(); return pending; }
        const isolated = session.fromPartition('oneyes-login-' + randomUUID());
        isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        isolated.setPermissionCheckHandler(() => false);
        isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.resourceType === 'mainFrame' && new URL(details.url).origin !== 'https://oneyes.ai' }));
        window = new BrowserWindow({ parent: parent(), width: 520, height: 780, title: '登录 OneYes', backgroundColor: '#18181a', webPreferences: { session: isolated, preload: path.join(__dirname, 'website-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
        const loginWindow = window;
        loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        pending = new Promise((resolve, reject) => {
            ipcMain.handle('oneyes:website-session', async (event, tokens) => {
                if (event.sender !== loginWindow.webContents || event.senderFrame !== event.sender.mainFrame || new URL(event.senderFrame.url).origin !== 'https://oneyes.ai') throw new Error('登录来源无效');
                if (!tokens || !['access_token', 'refresh_token'].every(name => typeof tokens[name] === 'string' && tokens[name].trim() && !/[\r\n\0]/.test(tokens[name]))) throw new Error('登录信息不完整，请重新登录');
                resolve({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
                loginWindow.destroy();
            });
            loginWindow.once('closed', () => reject(new Error('已取消网站登录，可直接登录或手动填写 API Key')));
            void loginWindow.loadURL('https://oneyes.ai/login').catch(() => { reject(new Error('网站登录加载失败，请检查网络后重试')); loginWindow.destroy(); });
        }).finally(async () => {
            ipcMain.removeHandler('oneyes:website-session');
            try { await isolated.clearStorageData(); }
            finally { window = pending = undefined; }
        });
        return pending;
    };
}
module.exports = { createWebsiteLogin };
