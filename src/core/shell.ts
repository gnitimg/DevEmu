import path from 'node:path';
import fs from 'node:fs';
import { run } from './exec.ts';
import { screenshot } from './adb.ts';
import { getShellGeometry, startPairDrag, startWindowGuard, onWindowGroupGeometry, onQemuGone } from './win.ts';
import { listRunning } from './emulator.ts';
import type { SdkInfo } from './types.ts';
import { VM_GAP_DIP } from './windowGroup.ts';
import { releaseLocationKeys, stopLocation } from './location.ts';

/**
 * 药丸窗口：模拟器屏幕右侧的竖向胶囊操作条（Electron 无边框小窗）。
 * 窗口外形由 win32 圆角区域裁成胶囊，按钮动作走 adb / 模拟器控制台。
 * electron 只能在主进程加载，这里统一动态引入（node --test 下不会触达）。
 */

export const PILL_WIDTH_DIP = 60;

export interface PillGeom {
  serial: string;
  avdName: string;
  /** qemu 屏幕区几何（物理像素），来自 applyShellGeometry */
  x: number;
  y: number;
  screenW: number;
  screenH: number;
}

const pills = new Map<string, import('electron').BrowserWindow>();
const openingPills = new Map<string, Promise<void>>();

export function hasPill(serial: string): boolean {
  return !!pills.get(serial) && !pills.get(serial)!.isDestroyed();
}

/** 当前开着药丸或定位面板的设备 serial（设备消失回收兜底用） */
export function openGroupSerials(): string[] {
  return [...new Set([...pills.keys(), ...locationPanels.keys()])];
}

export function pillTitle(serial: string): string {
  return `devemu-pill ${serial}`;
}

function pillHtml(win: import('electron').BrowserWindow, serial: string): void {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(
      `${MAIN_WINDOW_VITE_DEV_SERVER_URL}/#pill?serial=${encodeURIComponent(serial)}`,
    );
  } else {
    void win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      {
        hash: `pill?serial=${encodeURIComponent(serial)}`,
      },
    );
  }
}

/** 为已就绪的模拟器打开药丸窗口（已存在则先关闭重建） */
export async function openPill(geom: PillGeom): Promise<void> {
  const pending = openingPills.get(geom.serial);
  if (pending) return pending;
  const request = createPill(geom);
  openingPills.set(geom.serial, request);
  try { await request; }
  finally { openingPills.delete(geom.serial); }
}

async function createPill(geom: PillGeom): Promise<void> {
  const { BrowserWindow, screen } = await import('electron');
  closePill(geom.serial);
  // 物理像素 → 所在显示器的 DIP
  const displays = screen.getAllDisplays();
  const disp =
    displays.find((d) => {
      const b = d.bounds;
      const x = b.x * d.scaleFactor;
      const y = b.y * d.scaleFactor;
      const w = b.width * d.scaleFactor;
      const h = b.height * d.scaleFactor;
      return geom.x >= x && geom.x < x + w && geom.y >= y && geom.y < y + h;
    }) ?? screen.getPrimaryDisplay();
  const s = disp.scaleFactor || 1;
  const win = new BrowserWindow({
    x: Math.round((geom.x + geom.screenW) / s) + VM_GAP_DIP - 4,
    y: Math.round(geom.y / s),
    width: PILL_WIDTH_DIP,
    height: Math.round(geom.screenH / s),
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    minimizable: false,
    skipTaskbar: true,
    hasShadow: false,
    transparent: true,
    backgroundColor: '#00000000',
    title: pillTitle(geom.serial),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  win.on('closed', () => { if (pills.get(geom.serial) === win) pills.delete(geom.serial); });
  // 不设 alwaysOnTop：z 序由守卫绑定到设备窗口正后方（同图层，随设备前后）
  // 窗口标题锁定为 pill 标识：守卫/拖动按标题找窗口，页面 <title> 不得覆盖
  win.webContents.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle(pillTitle(geom.serial));
  });
  // 药丸窗口渲染问题打到主进程日志，便于诊断
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log(`[pill:${level}] ${message} (${source}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[pill] load failed ${code} ${desc} ${url}`);
  });
  pillHtml(win, geom.serial);
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  pills.set(geom.serial, win);
  startWindowGuard(geom.avdName, geom.serial);
}

export function closePill(serial: string): void {
  const win = pills.get(serial);
  if (!win) return;
  pills.delete(serial);
  if (!win.isDestroyed()) win.close();
}

export function closeAllPills(): void {
  for (const serial of pills.keys()) closePill(serial);
}

// ---------- 虚拟定位面板 ----------

const locationPanels = new Map<string, import('electron').BrowserWindow>();

onWindowGroupGeometry((serial, geometry) => {
  void import('electron').then(({screen}) => {
    const bounds = screen.screenToDipRect(null, {x:geometry.x,y:geometry.y,width:geometry.screenW,height:geometry.screenH});
    const pill = pills.get(serial);
    const panel = locationPanels.get(serial);
    const setBounds = (win: import('electron').BrowserWindow | undefined, x: number, width: number): void => {
      if (!win || win.isDestroyed()) return;
      const next = {x,y:bounds.y,width,height:bounds.height};
      const old = win.getBounds();
      if (Object.keys(next).some(key => old[key as keyof typeof old] !== next[key as keyof typeof next])) win.setBounds(next);
    };
    const pillX = bounds.x + bounds.width + VM_GAP_DIP - 4;
    setBounds(pill, pillX, PILL_WIDTH_DIP);
    const pillBounds = pill && !pill.isDestroyed() ? pill.getBounds() : null;
    setBounds(panel, pillBounds ? pillBounds.x + pillBounds.width + VM_GAP_DIP - 10 : bounds.x + bounds.width + VM_GAP_DIP - 6, 392);
  });
});

function locationPanelHtml(
  win: import('electron').BrowserWindow,
  serial: string,
): void {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(
      `${MAIN_WINDOW_VITE_DEV_SERVER_URL}/#locpanel?serial=${encodeURIComponent(serial)}`,
    );
  } else {
    void win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      {
        hash: `locpanel?serial=${encodeURIComponent(serial)}`,
      },
    );
  }
}

/** 虚拟定位面板：药丸定位按钮唤出的参数与方向控制小窗（每台设备一个，已开则置前） */
export async function openLocationPanel(serial: string): Promise<void> {
  const { BrowserWindow, screen } = await import('electron');
  const existing = locationPanels.get(serial);
  if (existing && !existing.isDestroyed()) {
    // 二次点击：播放收起动画后关窗（渲染层 __panelClose 自关，主进程兜底强关）
    void existing.webContents
      .executeJavaScript(
        'window.__panelClose ? window.__panelClose() : window.close()',
        true,
      )
      .catch(() => undefined);
    setTimeout(() => {
      if (!existing.isDestroyed()) existing.close();
    }, 240);
    return;
  }
  const PANEL_W = 392;
  let x: number | undefined;
  let y: number | undefined;
  // 高度与左侧控制中心（药丸）一致。药丸是本进程自己的窗口，直接读它的几何：
  // 零延迟（不走 PowerShell 查 qemu 几何），高度/顶边天然与药丸对齐
  let PANEL_H = 764;
  const pill = pills.get(serial);
  const wa = screen.getPrimaryDisplay().workArea;
  if (pill && !pill.isDestroyed()) {
    const b = pill.getBounds();
    PANEL_H = b.height;
    x = b.x + b.width + VM_GAP_DIP - 10;
    y = b.y;
  } else {
    // 药丸未开（设置里关闭了药丸）：退回查 qemu 窗口几何
    const entry = listRunning().find((e) => e.serial === serial);
    if (entry) {
      const geom = await getShellGeometry(entry.avdName).catch(() => undefined);
      if (geom) {
        const s = screen.getPrimaryDisplay().scaleFactor || 1;
        PANEL_H = Math.max(
          320,
          Math.min(Math.round(geom.screenH / s), wa.height - 12),
        );
        x = Math.round((geom.x + geom.screenW) / s) + VM_GAP_DIP - 6;
        y = Math.max(
          wa.y,
          Math.min(Math.round(geom.y / s), wa.y + wa.height - PANEL_H),
        );
      }
    }
  }
  const win = new BrowserWindow({
    x,
    y,
    width: PANEL_W,
    height: PANEL_H,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    minimizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    // 与药丸一致走 transparent 合成路径（不透明无边框小窗在部分机器上合成异常），
    // 加载期窗口不可见即天然无闪白
    transparent: true,
    backgroundColor: '#00000000',
    title: `devemu-location ${serial}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  win.on('blur', () => releaseLocationKeys(serial));
  win.on('closed', () => {
    releaseLocationKeys(serial);
    if (locationPanels.get(serial) === win) locationPanels.delete(serial);
  });
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log(`[location:${level}] ${message} (${source}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.log('[location] renderer gone:', JSON.stringify(details));
  });
  win.webContents.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle(`devemu-location ${serial}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[location] load failed ${code} ${desc} ${url}`);
  });
  locationPanelHtml(win, serial);
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  locationPanels.set(serial, win);
  // 仅开面板（设置里关了药丸）时也必须起守卫，否则设备退出无人收窗
  const entry = listRunning().find((e) => e.serial === serial);
  if (entry) startWindowGuard(entry.avdName, serial);
}

export function closeLocationPanel(serial: string): void {
  const win = locationPanels.get(serial);
  if (!win) return;
  locationPanels.delete(serial);
  if (!win.isDestroyed()) win.close();
}

export function closeLocationPanels(): void {
  for (const serial of locationPanels.keys()) closeLocationPanel(serial);
}

// 设备进程消失（含在 Android 里直接关机、外部启动的模拟器退出）：窗口组与定位会话随设备同步关闭
onQemuGone((serial) => {
  void stopLocation(serial).catch(() => undefined);
  closePill(serial);
  closeLocationPanel(serial);
});

// ---------- 路线编辑器 ----------

export type PillAction =
  | 'power'
  | 'powerLong'
  | 'volup'
  | 'voldown'
  | 'screenshot'
  | 'rotate'
  | 'back'
  | 'home'
  | 'recents';

const KEYCODES: Partial<Record<PillAction, number>> = {
  power: 26,
  volup: 24,
  voldown: 25,
  back: 4,
  home: 3,
  recents: 187,
};

/** 药丸按钮动作：按键走 adb，旋转走模拟器控制台（adb emu），截图存到数据目录；
 *  powerLong（长按电源 3 秒）尝试关闭这台虚拟机 */
export async function handlePillAction(
  sdk: SdkInfo,
  dataRoot: string,
  serial: string,
  action: PillAction,
): Promise<{ ok: boolean; savedTo?: string; error?: string }> {
  console.log('[pill-main] action', serial, action);
  if (action === 'powerLong') {
    const entry = listRunning().find((e) => e.serial === serial);
    if (!entry) return { ok: false, error: '虚拟机未在运行' };
    const { stopEmulator } = await import('./emulator.ts');
    const stopped = await stopEmulator(sdk, entry).catch(() => false);
    return { ok: stopped };
  }
  const code = KEYCODES[action];
  if (code !== undefined) {
    const res = await run(
      sdk.adb,
      ['-s', serial, 'shell', 'input', 'keyevent', String(code)],
      {
        timeoutMs: 15_000,
      },
    ).catch(() => undefined);
    return {
      ok: !!res && res.code === 0,
      error: res && res.code !== 0 ? res.stderr.trim() : undefined,
    };
  }
  if (action === 'rotate') {
    const res = await run(sdk.adb, ['-s', serial, 'emu', 'rotate'], {
      timeoutMs: 15_000,
    }).catch(() => undefined);
    return {
      ok: !!res && res.code === 0,
      error: res && res.code !== 0 ? res.stderr.trim() : undefined,
    };
  }
  if (action === 'screenshot') {
    const dir = path.join(dataRoot, 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(
      dir,
      `${serial}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
    );
    const png = await screenshot(sdk.adb, serial);
    fs.writeFileSync(file, png);
    return { ok: true, savedTo: file };
  }
  return { ok: false, error: '未知动作' };
}

/** 药丸底部把手拖动：qemu、药丸与定位面板按同一偏移跟随鼠标（直传原生句柄） */
export function startPillMove(serial: string): boolean {
  const entry = listRunning().find((e) => e.serial === serial);
  const win = pills.get(serial);
  if (!entry || !win || win.isDestroyed()) return false;
  const hwndHex = nativeHandleHex(win);
  const panel = locationPanels.get(serial);
  startPairDrag(
    entry.avdName,
    hwndHex,
    panel && !panel.isDestroyed() ? nativeHandleHex(panel) : '',
  );
  return true;
}

function nativeHandleHex(win: import('electron').BrowserWindow): string {
  // getNativeWindowHandle() 前 8 字节为 HWND（小端）
  const handle = win.getNativeWindowHandle();
  return (handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString(16);
}
