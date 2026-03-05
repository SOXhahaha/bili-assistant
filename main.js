const { app, BrowserWindow, ipcMain, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// Avoid Windows profile cache permission issues by pinning userData to workspace-local folder.
const basePath = app.isPackaged ? path.dirname(process.execPath) : __dirname
const userDataPath = path.join(basePath, '.app-data')
if (!fs.existsSync(userDataPath)) {
  fs.mkdirSync(userDataPath, { recursive: true })
}
app.setPath('userData', userDataPath)

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1500,
    height: 1000,
    minWidth: 1024,
    minHeight: 700,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    titleBarStyle: 'hidden', // 隐藏默认标题栏，自定义UI
    backgroundColor: '#f1f2f3', // 与页面背景色一致，消除闪白
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true // 启用 webview 以嵌入 B站 页面
    }
  })

  mainWindow.loadFile('index.html')
}

app.whenReady().then(() => {
  createWindow()

  ipcMain.handle('logout', async () => {
    try {
      const ses = session.fromPartition('persist:bili-assistant');
      await ses.clearStorageData({ storages: ['cookies'] });
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.on('quit-app', () => {
    app.exit(0)
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})