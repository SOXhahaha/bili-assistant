const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    logout: () => ipcRenderer.invoke('logout'),
    quitApp: () => ipcRenderer.send('quit-app')
});

window.addEventListener('DOMContentLoaded', () => {
    // expose any API to renderer if needed
})