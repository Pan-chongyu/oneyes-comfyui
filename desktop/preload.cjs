const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('oneYesDesktop', {
    state: () => ipcRenderer.invoke('oneyes:state'),
    saveKeys: changes => ipcRenderer.invoke('oneyes:save-keys', changes),
    launch: () => ipcRenderer.invoke('oneyes:launch'),
    openSettings: () => ipcRenderer.invoke('oneyes:settings'),
    openData: () => ipcRenderer.invoke('oneyes:data'),
    openKeys: () => ipcRenderer.invoke('oneyes:keys'),
    models: profile => ipcRenderer.invoke('oneyes:models', profile),
    tasks: () => ipcRenderer.invoke('oneyes:tasks'),
    checkUpdate: () => ipcRenderer.invoke('oneyes:update-check'),
    installUpdate: () => ipcRenderer.invoke('oneyes:update-install'),
    onState: callback => { const handler = (_event, state) => callback(state); ipcRenderer.on('oneyes:state', handler); return () => ipcRenderer.removeListener('oneyes:state', handler); },
});
