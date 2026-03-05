const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    logout: () => ipcRenderer.invoke('logout')
});

window.addEventListener('DOMContentLoaded', () => {
    // expose any API to renderer if needed
})