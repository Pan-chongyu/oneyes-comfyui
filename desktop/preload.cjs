const { contextBridge, ipcRenderer } = require('electron');
let pendingSection, openSettings;
ipcRenderer.on('oneyes:open-settings', (_event, section) => {
    if (openSettings) openSettings(section);
    else pendingSection = section;
});
contextBridge.exposeInMainWorld('oneYesDesktop', {
    state: () => ipcRenderer.invoke('oneyes:state'),
    saveKeys: changes => ipcRenderer.invoke('oneyes:save-keys', changes),
    account: (operation, args) => ipcRenderer.invoke('oneyes:account', operation, args),
    launch: () => ipcRenderer.invoke('oneyes:launch'),
    openSettings: section => ipcRenderer.invoke('oneyes:settings', section),
    onOpenSettings: callback => {
        openSettings = callback;
        if (pendingSection) { callback(pendingSection); pendingSection = undefined; }
        return () => { if (openSettings === callback) openSettings = undefined; };
    },
    openData: () => ipcRenderer.invoke('oneyes:data'),
    confirm: options => ipcRenderer.invoke('oneyes:native-confirm', options),
    copyText: value => ipcRenderer.invoke('oneyes:copy-text', value),
    openKeys: () => ipcRenderer.invoke('oneyes:keys'),
    openAccountPage: page => ipcRenderer.invoke('oneyes:account-page', page),
    models: profile => ipcRenderer.invoke('oneyes:models', profile),
    tasks: () => ipcRenderer.invoke('oneyes:tasks'),
    checkUpdate: () => ipcRenderer.invoke('oneyes:update-check'),
    installUpdate: () => ipcRenderer.invoke('oneyes:update-install'),
    onState: callback => { const handler = (_event, state) => callback(state); ipcRenderer.on('oneyes:state', handler); return () => ipcRenderer.removeListener('oneyes:state', handler); },
});
