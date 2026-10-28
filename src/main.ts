import { app, BrowserWindow, Menu, globalShortcut } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { registerIpc } from './ipc.ts';
import { appendLog } from './core/log.ts';
import { loadAppSettings } from './core/settings.ts';
import { stopAllLocations } from './core/location.ts';
import { stopWindowGuards } from './core/win.ts';

if (started) {
  app.quit();
}

// 运行日志统一写 <dataRoot>/logs/app.log；dataRoot 每次现读，重置后也能拿到最新值
function logLine(line: string): void {
  appendLog(loadAppSettings().dataRoot, line);
}

process.on('uncaughtException', (err) => {
  logLine(`未捕获异常：${err.stack ?? err.message}`);
});
process.on('unhandledRejection', (reason) => {
  logLine(`未处理的 Promise 拒绝：${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

// 桌面工具不需要 Electron 默认菜单栏
Menu.setApplicationMenu(null);

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f6f7f8',
    title: 'DevEmu',
    frame: false,
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // 自绘标题栏需要知道最大化状态以切换按钮图标
  const sendMaximized = () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('win:maximized', mainWindow.isMaximized());
  };
  mainWindow.on('maximize', sendMaximized);
  mainWindow.on('unmaximize', sendMaximized);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

app.whenReady().then(() => {
  logLine(`应用启动 v${app.getVersion()}（Electron ${process.versions.electron}）`);
  registerIpc();
  createWindow();

  // 开发模式提供手动刷新：自绘窗口没有菜单，Ctrl+R/F5 默认不可用，
  // HMR 断连时渲染层会停在旧代码上无从恢复
  if (!app.isPackaged) {
    globalShortcut.register('F5', () => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.reload();
    });
    app.on('will-quit', () => globalShortcut.unregisterAll());
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  logLine('所有窗口已关闭，应用退出');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let shutdownStarted = false;
app.on('before-quit', (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  void stopAllLocations().finally(() => {
    stopWindowGuards();
    app.quit();
  });
});
