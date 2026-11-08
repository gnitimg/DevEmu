import path from 'node:path';
import fs from 'node:fs';
import { run } from './exec.ts';
import { screenshot } from './adb.ts';
import {
  getShellGeometry,
  startPairDrag,
  startPairDragByPid,
  startHosWindowGuard,
  startWindowGuard,
  onWindowGroupGeometry,
  onQemuGone,
} from './win.ts';
import { listRunning } from './emulator.ts';
import type { SdkInfo } from './types.ts';
import { VM_GAP_DIP } from './windowGroup.ts';
import { releaseLocationKeys, stopLocation } from './location.ts';
import { runHosScenario } from './hosemu.ts';

/**
 * 药丸窗口：模拟器屏幕右侧的竖向胶囊操作条（Electron 无边框小窗）。
 * 窗口外形由 win32 圆角区域裁成胶囊，按钮动作走 adb / 模拟器控制台。
 * electron 只能在主进程加载，这里统一动态引入（node --test 下不会触达）。
 */

export const PILL_WIDTH_DIP = 60;

export interface PillGeom {
  serial: string;
  avdName: string;
  kind?: 'android' | 'hos';
  /** HarmonyOS：已解析的 Emulator.exe 主进程 pid */
  pid?: number;
  /** HarmonyOS：Emulator.exe 路径 */
  hosEmu?: string;
  /** HarmonyOS：hdc.exe 路径（多任务手势需要设备端 uitest） */
  hosHdc?: string;
  /** HarmonyOS：guest 原生分辨率（竖屏基准，旋转只影响手势坐标换算） */
  resolution?: { width: number; height: number };
  /** qemu 屏幕区几何（物理像素），来自 applyShellGeometry */
  x: number;
  y: number;
  screenW: number;
  screenH: number;
}

interface HosPillTarget {
  name: string;
  emu: string;
  hdc?: string;
  pid: number;
  width: number;
  height: number;
  portrait: boolean;
}

const pills = new Map<string, import('electron').BrowserWindow>();
const openingPills = new Map<string, Promise<void>>();
const hosTargets = new Map<string, HosPillTarget>();

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

function pillHtml(
  win: import('electron').BrowserWindow,
  serial: string,
  kind: 'android' | 'hos',
): void {
  const query = `serial=${encodeURIComponent(serial)}${kind === 'hos' ? '&kind=hos' : ''}`;
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}/#pill?${query}`);
  } else {
    void win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      {
        hash: `pill?${query}`,
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
  const kind = geom.kind === 'hos' ? 'hos' : 'android';
  if (kind === 'hos' && geom.pid && geom.hosEmu) {
    hosTargets.set(geom.serial, {
      name: geom.avdName,
      emu: geom.hosEmu,
      hdc: geom.hosHdc,
      pid: geom.pid,
      width: geom.resolution?.width ?? 0,
      height: geom.resolution?.height ?? 0,
      portrait: !geom.resolution || geom.resolution.height >= geom.resolution.width,
    });
  }
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
  // HarmonyOS 模拟器把原生操作条画在窗口内右侧条带里：药丸压在条带上替代它，
  // 窗口保持 Qt 自己的尺寸（不再钳制），否则会与 Qt 抢尺寸导致持续抖动。
  const right = Math.round((geom.x + geom.screenW) / s);
  const win = new BrowserWindow({
    x: kind === 'hos' ? right - PILL_WIDTH_DIP : right + VM_GAP_DIP - 4,
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
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    console.log(`[pill] load failed ${code} ${desc} ${url}`);
    // 主帧加载失败则永远等不到 ready-to-show：关窗让 emu:list 轮询重建
    if (isMainFrame && !win.isDestroyed()) win.close();
  });
  pillHtml(win, geom.serial, kind);
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  pills.set(geom.serial, win);
  if (kind === 'hos' && geom.pid) startHosWindowGuard(geom.pid, geom.serial);
  else startWindowGuard(geom.avdName, geom.serial);
}

export function closePill(serial: string): void {
  hosTargets.delete(serial);
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

/** 物理像素矩形 → 所在显示器的 DIP 矩形：按"包含左上角的显示器"的 scaleFactor 手动换算，
 *  work 为该显示器的工作区（已是 DIP）。不用 screenToDipRect(null,…)（按主显示器换算），
 *  否则多显示器不同 DPI 时与 createPill 初建算法不一致，GEOM 更新后药丸/面板会跳位。 */
async function physRectToDip(geom: PillGeom): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
  work: { x: number; y: number; width: number; height: number };
}> {
  const { screen } = await import('electron');
  const disp =
    screen.getAllDisplays().find((d) => {
      const b = d.bounds;
      const s = d.scaleFactor || 1;
      return (
        geom.x >= b.x * s &&
        geom.x < (b.x + b.width) * s &&
        geom.y >= b.y * s &&
        geom.y < (b.y + b.height) * s
      );
    }) ?? screen.getPrimaryDisplay();
  const s = disp.scaleFactor || 1;
  return {
    x: Math.round(geom.x / s),
    y: Math.round(geom.y / s),
    width: Math.round(geom.screenW / s),
    height: Math.round(geom.screenH / s),
    work: disp.workArea,
  };
}

onWindowGroupGeometry((serial, geometry) => {
  void (async () => {
    const bounds = await physRectToDip({
      serial,
      avdName: '',
      x: geometry.x,
      y: geometry.y,
      screenW: geometry.screenW,
      screenH: geometry.screenH,
    });
    const pill = pills.get(serial);
    const panel = locationPanels.get(serial);
    const setBounds = (win: import('electron').BrowserWindow | undefined, x: number, width: number): void => {
      if (!win || win.isDestroyed()) return;
      const next = {x,y:bounds.y,width,height:bounds.height};
      const old = win.getBounds();
      if (Object.keys(next).some(key => old[key as keyof typeof old] !== next[key as keyof typeof next])) win.setBounds(next);
    };
    const pillX = hosTargets.has(serial)
      ? bounds.x + bounds.width - PILL_WIDTH_DIP
      : bounds.x + bounds.width + VM_GAP_DIP - 4;
    setBounds(pill, pillX, PILL_WIDTH_DIP);
    const pillBounds = pill && !pill.isDestroyed() ? pill.getBounds() : null;
    setBounds(panel, pillBounds ? pillBounds.x + pillBounds.width + VM_GAP_DIP - 10 : bounds.x + bounds.width + VM_GAP_DIP - 6, 392);
  })().catch(() => undefined);
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
  const { BrowserWindow } = await import('electron');
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
        // 与药丸同款换算：按所在显示器（而非主显示器）的 scaleFactor 与工作区
        const b = await physRectToDip({
          serial,
          avdName: '',
          x: geom.x,
          y: geom.y,
          screenW: geom.screenW,
          screenH: geom.screenH,
        });
        PANEL_H = Math.max(320, Math.min(b.height, b.work.height - 12));
        x = b.x + b.width + VM_GAP_DIP - 6;
        y = Math.max(b.work.y, Math.min(b.y, b.work.y + b.work.height - PANEL_H));
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
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    console.log(`[location] load failed ${code} ${desc} ${url}`);
    if (isMainFrame && !win.isDestroyed()) win.close();
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

/** HarmonyOS 药丸把手拖动：按已解析 pid 找设备窗口，药丸同偏移跟随 */
export function startHosPillMove(serial: string): boolean {
  const target = hosTargets.get(serial);
  const win = pills.get(serial);
  if (!target || !win || win.isDestroyed()) return false;
  const panel = locationPanels.get(serial);
  startPairDragByPid(
    target.pid,
    nativeHandleHex(win),
    panel && !panel.isDestroyed() ? nativeHandleHex(panel) : '',
  );
  return true;
}

/** HarmonyOS 药丸动作：走 Emulator.exe 场景模拟（电源/音量/旋转/截图/手势） */
export async function handleHosPillAction(
  dataRoot: string,
  serial: string,
  action: PillAction,
): Promise<{ ok: boolean; savedTo?: string; error?: string }> {
  const target = hosTargets.get(serial);
  if (!target) return { ok: false, error: '虚拟机未在运行' };
  const { emu, name } = target;
  if (action === 'powerLong') {
    const res = await run(emu, ['-stop', name], { timeoutMs: 60_000 }).catch(
      () => undefined,
    );
    return {
      ok: !!res && res.code === 0,
      error: res && res.code !== 0 ? res.stderr.trim() : undefined,
    };
  }
  if (action === 'screenshot') {
    return captureHosScreenshot(target, dataRoot);
  }
  const nativeW = target.width || 1256;
  const nativeH = target.height || 2760;
  const w = target.portrait ? nativeW : nativeH;
  const h = target.portrait ? nativeH : nativeW;
  const round = Math.round;
  if (action === 'recents') {
    // 场景命令的 -slide 不会触发多任务：改走设备端 uitest 的慢速上滑
    const hdcTarget = target.hdc ? await hdcTargetOfPid(target.pid, target.hdc) : undefined;
    if (!target.hdc || !hdcTarget) return { ok: false, error: '未找到模拟器的 hdc 通道' };
    const res = await run(
      target.hdc,
      [
        '-t',
        hdcTarget,
        'shell',
        'uitest',
        'uiInput',
        'swipe',
        String(round(w * 0.5)),
        String(h - 2),
        String(round(w * 0.5)),
        String(round(h * 0.45)),
        '250',
      ],
      { timeoutMs: 30_000 },
    ).catch(() => undefined);
    return {
      ok: !!res && res.code === 0,
      error: res && res.code !== 0 ? res.stderr.trim() || res.stdout.trim() : undefined,
    };
  }
  // back/home 用系统手势（场景命令内部按实例找 hdc 通道）；分辨率按当前旋转状态换算
  const args: string[] =
    action === 'power'
      ? ['-power']
      : action === 'volup'
        ? ['-volume', 'up']
        : action === 'voldown'
          ? ['-volume', 'down']
          : action === 'rotate'
            ? ['-rotation', 'left']
            : action === 'back'
              ? ['-slide', `${round(w * 0.01)} ${round(h * 0.5)} ${round(w * 0.45)} ${round(h * 0.5)}`]
              : action === 'home'
                ? ['-slide', `${round(w * 0.5)} ${h - 2} ${round(w * 0.5)} ${round(h * 0.6)}`]
                : [];
  if (args.length === 0) return { ok: false, error: '该操作暂不支持 HarmonyOS' };
  const res = await runHosScenario(emu, name, args);
  if (res.ok && action === 'rotate') target.portrait = !target.portrait;
  return { ok: res.ok, error: res.error };
}

/** HarmonyOS 模拟器自身的 hdc TCP 端口：netstat 取该 pid 的 LISTENING 端口，
 *  再与 hdc 目标列表交叉，避免多实例并存时把手势发到别的设备 */
async function hdcTargetOfPid(pid: number, hdc: string): Promise<string | undefined> {
  const netstat = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'netstat.exe')
    : 'netstat';
  const net = await run(netstat, ['-ano', '-p', 'TCP'], { timeoutMs: 8000 }).catch(() => undefined);
  if (!net || net.code !== 0) return undefined;
  const ports = new Set<number>();
  for (const line of net.stdout.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (m && Number(m[2]) === pid) ports.add(Number(m[1]));
  }
  if (ports.size === 0) return undefined;
  const list = await run(hdc, ['list', 'targets'], { timeoutMs: 8000 }).catch(() => undefined);
  if (!list || list.code !== 0) return undefined;
  for (const raw of list.stdout.split(/\r?\n/)) {
    const target = raw.trim();
    const m = /^(\S+):(\d+)$/.exec(target);
    if (m && ports.has(Number(m[2]))) return target;
  }
  return undefined;
}

async function captureHosScreenshot(
  target: HosPillTarget,
  dataRoot: string,
): Promise<{ ok: boolean; savedTo?: string; error?: string }> {
  const dir = path.join(dataRoot, 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const isPng = (f: string) => /\.png$/i.test(f);
  // 直接写截图目录：用独立临时目录时模拟器会长期占用目录句柄，删不掉只能泄漏
  const before = new Set(fs.readdirSync(dir).filter(isPng));
  const res = await runHosScenario(target.emu, target.name, [
    '-screenshot',
    '-screenshotPath',
    dir,
  ]);
  if (!res.ok) return { ok: false, error: res.error };
  const png = fs
    .readdirSync(dir)
    .filter((f) => isPng(f) && !before.has(f))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!png) return { ok: false, error: '模拟器未生成截图（可能尚未完成启动）' };
  const file = path.join(
    dir,
    `${target.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
  );
  // 截图子进程退出后仍会短暂占用文件：Windows 下改名要等句柄释放
  for (let i = 0; i < 20; i++) {
    try {
      fs.renameSync(png, file);
      return { ok: true, savedTo: file };
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return { ok: false, error: '截图文件被占用，未能保存' };
}

function nativeHandleHex(win: import('electron').BrowserWindow): string {
  // getNativeWindowHandle() 前 8 字节为 HWND（小端）
  const handle = win.getNativeWindowHandle();
  return (handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString(16);
}
