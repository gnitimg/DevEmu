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

  mainWindow.on('closed', () => {
    // 药丸/定位面板也是 BrowserWindow：只关主窗时 window-all-closed 不触发，
    // 应用会带着无边框小窗继续存活且没有找回主窗的入口——此时直接退出
    // （模拟器进程不受影响，与全部窗口关闭的行为一致）。macOS 惯例关窗留应用。
    if (process.platform === 'darwin') return;
    const rest = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    if (rest.every((w) => w.getTitle().startsWith('devemu-'))) app.quit();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

function startMain(): void {
  app.on('second-instance', () => {
    // 药丸/定位面板也是本进程窗口（标题 devemu-* 前缀）：必须聚焦主窗口
    const main =
      BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && !w.getTitle().startsWith('devemu-'),
      ) ?? BrowserWindow.getAllWindows()[0];
    if (main) {
      if (main.isMinimized()) main.restore();
      main.focus();
    }
  });

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
}

// 单实例锁。更新安装时 Squirrel 可能赶在旧实例退完前启动新版，拿锁失败先
// 短暂重试等旧实例释放；重试用尽仍失败则照常启动——宁可短暂双开，
// 不能让刚装好的新版直接闪退
const LOCK_RETRY_MAX = 20;
if (app.requestSingleInstanceLock()) {
  startMain();
} else {
  let tries = 0;
  const retryLock = setInterval(() => {
    tries += 1;
    if (app.requestSingleInstanceLock() || tries >= LOCK_RETRY_MAX) {
      clearInterval(retryLock);
      startMain();
    }
  }, 500);
}
