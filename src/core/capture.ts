import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, WebContents } from 'electron';
import { avdScopeKeys, scopeDirs } from './env.ts';
import { avdNameOf, pngSize } from './adb.ts';
import { readAvdConfig, readAvdPrefs } from './avd.ts';
import { detectSdk } from './sdk.ts';
import { loadAppSettings } from './settings.ts';
import { appendLog } from './log.ts';
import { listPersistedRunning, listRunning } from './emulator.ts';
import { findGrpcEndpoint } from './emuGps.ts';
import {
  SHARED_HANDLE_MAX,
  sharedHandle,
  type EmuFrameMeta,
} from './emuFrames.ts';
import {
  CaptureSessions,
  type CaptureEngine,
  type CaptureResult,
  type CaptureSink,
  type CaptureState,
} from './captureSession.ts';
import {
  CAPTURE_ROLE_ARG,
  type CaptureEvent,
  type CommandBody,
  type FrameSkin,
  type PrepareReply,
  type StopReply,
} from './captureProtocol.ts';
import { captureStamp, ensureCaptureDir } from './media.ts';
import {
  findSkinDir,
  pickRecordingLayout,
  pickStillLayout,
  readSkin,
  type SkinDefinition,
  type SkinLayout,
} from './skin.ts';
import type { Scope, SdkInfo, Settings } from './types.ts';

/**
 * 录屏与带边框截图的 Electron 胶水：隐藏的编码工作窗、落盘、皮肤素材、共享帧文件。
 * 纯逻辑分别在 captureSession（会话编排）、emuFrames（帧流）、skin（布局）。
 * electron 只能在主进程加载，这里统一动态引入（node --test 下不会触达）。
 */

const CAPTURE_TITLE = 'devemu-capture';
const SERIAL_RE = /^emulator-\d{1,5}$/;
/** 工作窗闲置这么久就关掉，省一份渲染进程的内存 */
const IDLE_CLOSE_MS = 60_000;
/** 崩溃等异常退出留下的共享帧文件：模拟器没机会删，放了这么久就没人持有 */
const STALE_SHARED_MS = 60 * 60_000;
const SHARED_PREFIX = 'devemu-capture-';

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// ---------- 编码工作窗 ----------

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 隐藏窗口：页面在画布上合成画面并编码，这里只管发命令、收应答 */
class WindowEngine implements CaptureEngine {
  onChunk: (id: string, data: ArrayBuffer) => void = () => undefined;
  onFailed: (id: string, error: string) => void = () => undefined;
  /** 工作窗异常退出：在录的会话得收尾 */
  onGone: () => void = () => undefined;
  private win: BrowserWindow | undefined;
  private opening: Promise<BrowserWindow> | undefined;
  private loaded: Promise<void> = Promise.resolve();
  private pending = new Map<string, Pending>();
  private seq = 0;
  private uses = 0;
  private idle: ReturnType<typeof setTimeout> | undefined;

  /** 这份消息是不是工作窗发来的：只认自家的渲染进程 */
  owns(contents: WebContents): boolean {
    return (
      !!this.win && !this.win.isDestroyed() && this.win.webContents === contents
    );
  }

  private window(): Promise<BrowserWindow> {
    if (this.win && !this.win.isDestroyed()) return Promise.resolve(this.win);
    return (this.opening ??= this.open().finally(() => {
      this.opening = undefined;
    }));
  }

  private async open(): Promise<BrowserWindow> {
    const { BrowserWindow } = await import('electron');
    const win = new BrowserWindow({
      show: false,
      width: 480,
      height: 320,
      // devemu- 前缀：主窗关闭时的"只剩辅助窗口即退出"与广播过滤都按它认
      title: CAPTURE_TITLE,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        // preload 读共享帧文件要用 node:fs，沙箱化下拿不到
        sandbox: false,
        backgroundThrottling: false,
        additionalArguments: [CAPTURE_ROLE_ARG],
      },
    });
    this.win = win;
    this.loaded = new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve());
      win.webContents.once('did-fail-load', (_e, code, desc) =>
        reject(new Error(`录屏工作窗加载失败（${code} ${desc}）`)),
      );
    });
    // 失败可能在没人等的时候到：关窗让下次重建，拒绝不能变成未捕获
    this.loaded.catch(() => undefined);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('page-title-updated', (e) => {
      e.preventDefault();
      win.setTitle(CAPTURE_TITLE);
    });
    win.webContents.on('did-fail-load', () => {
      if (!win.isDestroyed()) win.close();
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      appendLog(
        loadAppSettings().dataRoot,
        `录屏工作窗渲染进程退出：${JSON.stringify(details)}`,
      );
      this.onGone();
      if (!win.isDestroyed()) win.close();
    });
    win.on('closed', () => {
      if (this.win !== win) return;
      this.win = undefined;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('录屏工作窗已关闭'));
      }
      this.pending.clear();
    });
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL)
      void win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}/#capture`);
    else
      void win.loadFile(
        path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
        { hash: 'capture' },
      );
    return win;
  }

  private send<T>(body: CommandBody, timeoutMs: number): Promise<T> {
    return this.window().then(async (win) => {
      await this.loaded;
      if (win.isDestroyed()) throw new Error('录屏工作窗已关闭');
      return new Promise<T>((resolve, reject) => {
        const requestId = String(++this.seq);
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error('录屏工作窗无响应'));
        }, timeoutMs);
        this.pending.set(requestId, {
          resolve: (data) => resolve(data as T),
          reject,
          timer,
        });
        win.webContents.send('capture:command', { ...body, requestId });
      });
    });
  }

  private beginUse(): void {
    this.uses++;
    clearTimeout(this.idle);
  }

  private endUse(): void {
    this.uses = Math.max(0, this.uses - 1);
    if (this.uses === 0)
      this.idle = setTimeout(() => this.close(), IDLE_CLOSE_MS);
  }

  /** 页面回传的事件：命令的应答、编码分块、编码失败 */
  event(payload: CaptureEvent): void {
    if (payload.type === 'chunk') this.onChunk(payload.id, payload.data);
    else if (payload.type === 'failed')
      this.onFailed(payload.id, payload.error);
    else {
      const pending = this.pending.get(payload.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(payload.requestId);
      if (payload.ok) pending.resolve(payload.data);
      else pending.reject(new Error(payload.error));
    }
  }

  prepare(opts: {
    id: string;
    width: number;
    height: number;
    rotation: 0 | 1 | 2 | 3;
    skin: FrameSkin | null;
  }): Promise<PrepareReply> {
    this.beginUse();
    return this.send({ type: 'prepare', ...opts }, 15_000);
  }
  roll(id: string, firstFrame: ArrayBuffer): Promise<void> {
    return this.send({ type: 'roll', id, png: firstFrame }, 15_000);
  }

  frame(
    id: string,
    meta: EmuFrameMeta,
    shared: { path: string; bytes: number },
  ): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    win.webContents.send('capture:frame', {
      id,
      width: meta.width,
      height: meta.height,
      rotation: meta.rotation,
      path: shared.path,
      bytes: shared.bytes,
    });
  }

  async finish(id: string): Promise<StopReply> {
    try {
      return await this.send({ type: 'stop', id }, 15_000);
    } finally {
      this.endUse();
    }
  }

  abort(id: string): void {
    this.endUse();
    const win = this.win;
    if (win && !win.isDestroyed())
      win.webContents.send('capture:command', { type: 'abort', id });
  }

  /** 截图贴上边框，返回 PNG */
  still(png: Buffer, skin: FrameSkin): Promise<Buffer> {
    this.beginUse();
    const data = png.buffer.slice(
      png.byteOffset,
      png.byteOffset + png.byteLength,
    ) as ArrayBuffer;
    return this.send<ArrayBuffer>({ type: 'still', png: data, skin }, 15_000)
      .then((out) => Buffer.from(out))
      .finally(() => this.endUse());
  }

  close(): void {
    clearTimeout(this.idle);
    if (this.win && !this.win.isDestroyed()) this.win.close();
  }
}

const engine = new WindowEngine();

// ---------- 落盘 ----------

function openSink(file: string): CaptureSink {
  const stream = fs.createWriteStream(file, { flags: 'w' });
  let failure: Error | undefined;
  stream.on('error', (err) => {
    failure = err;
  });
  // 出错后 end 的回调不一定触发，统一等 close
  const settled = new Promise<number>((resolve, reject) => {
    stream.on('close', () =>
      failure ? reject(failure) : resolve(stream.bytesWritten),
    );
  });
  return {
    write: (data) => {
      if (failure) return;
      const chunk =
        data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      stream.write(chunk);
    },
    close: () => {
      stream.end();
      return settled;
    },
  };
}

// ---------- 共享帧文件 ----------

/** 选址：模拟器对句柄长度有上限，数据根、临时目录里放得下的优先，都不行退 ProgramData */
function createSharedFile(serial: string, bytes: number): string | undefined {
  const dirs = [
    path.join(loadAppSettings().dataRoot, '.runtime'),
    os.tmpdir(),
    'C:\\ProgramData\\DevEmu',
  ];
  const name = `${SHARED_PREFIX}${serial.replace('emulator-', '')}-${Date.now().toString(36)}.rgba`;
  for (const dir of dirs) {
    const file = path.join(dir, name);
    if (Buffer.byteLength(sharedHandle(file)) > SHARED_HANDLE_MAX) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const fd = fs.openSync(file, 'w');
      try {
        fs.ftruncateSync(fd, bytes + 65536);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // 这个位置不可写，换下一个
      continue;
    }
    void sweepSharedFiles(dir);
    return file;
  }
  return undefined;
}

async function sweepSharedFiles(dir: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(SHARED_PREFIX)) continue;
    const file = path.join(dir, entry.name);
    try {
      const age = Date.now() - (await fs.promises.stat(file)).mtimeMs;
      // 在录的共享文件都在新近建过，只清放了很久的
      if (age > STALE_SHARED_MS)
        await fs.promises.rm(file, {
          force: true,
          maxRetries: 3,
          retryDelay: 200,
        });
    } catch {
      // 被占用或已不在：下次再说
    }
  }
}

// ---------- 虚拟机与皮肤 ----------

interface AvdRef {
  scope: Scope;
  name: string;
}

const scopeOf = (scopeKey: string): Scope =>
  scopeKey === 'shared'
    ? { kind: 'shared' }
    : { kind: 'project', projectId: scopeKey.slice('project:'.length) };

/** 串号对应的虚拟机：优先在册实例（含重启前落盘的），否则按 adb 报的名字在各作用域里找。
 *  外部工具建的虚拟机不在数据根里，找不到就按不带边框处理 */
async function avdOf(
  sdk: SdkInfo,
  dataRoot: string,
  serial: string,
): Promise<AvdRef | undefined> {
  const live =
    listRunning().find((e) => e.serial === serial) ??
    listPersistedRunning(dataRoot).find((e) => e.serial === serial);
  if (live) return { scope: scopeOf(live.scopeKey), name: live.avdName };
  const name = await avdNameOf(sdk.adb, serial).catch(() => undefined);
  const key = name ? avdScopeKeys(dataRoot, name)[0] : undefined;
  return key && name ? { scope: scopeOf(key), name } : undefined;
}

function skinOf(
  sdk: SdkInfo,
  dataRoot: string,
  avd: AvdRef,
): { dir: string; skin: SkinDefinition } | undefined {
  let config: Record<string, string>;
  try {
    config = readAvdConfig(scopeDirs(dataRoot, avd.scope).avdHome, avd.name);
  } catch {
    return undefined;
  }
  const dir = findSkinDir(sdk.root, config);
  const skin = dir ? readSkin(dir) : undefined;
  return dir && skin ? { dir, skin } : undefined;
}

function imageBytes(skinDir: string, file: string): ArrayBuffer {
  const buf = fs.readFileSync(path.join(skinDir, file));
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

function frameSkin(
  skinDir: string,
  layout: SkinLayout,
  canvasRotation: number,
): FrameSkin {
  return {
    width: layout.width,
    height: layout.height,
    screen: layout.screen,
    screenRotation: layout.screenRotation,
    canvasRotation,
    backgrounds: layout.backgrounds.map((bg) => ({
      x: bg.x,
      y: bg.y,
      data: imageBytes(skinDir, bg.file),
    })),
    ...(layout.mask ? { mask: imageBytes(skinDir, layout.mask) } : {}),
    onions: layout.onions.map((onion) => ({
      x: onion.x,
      y: onion.y,
      data: imageBytes(skinDir, onion.file),
    })),
  };
}

/** 这台虚拟机有没有可用的边框皮肤（设置页据此决定要不要显示"带边框"开关） */
export function captureFrameSupported(
  sdk: SdkInfo,
  dataRoot: string,
  scope: Scope,
  name: string,
): boolean {
  return skinOf(sdk, dataRoot, { scope, name }) !== undefined;
}

// ---------- 会话 ----------

let sessions: CaptureSessions | undefined;
const sinks = new Map<string, CaptureSink>();
let onState: (state: CaptureState) => void = () => undefined;
let onSaved: (result: CaptureResult, endedByDevice: boolean) => void = () =>
  undefined;

function ensureSessions(): CaptureSessions {
  if (sessions) return sessions;
  const routed: CaptureEngine = {
    prepare: (opts) => engine.prepare(opts),
    roll: (id, png) => engine.roll(id, png),
    frame: (id, meta, shared) => engine.frame(id, meta, shared),
    finish: (id) => engine.finish(id).finally(() => sinks.delete(id)),
    abort: (id) => {
      sinks.delete(id);
      engine.abort(id);
    },
  };
  engine.onChunk = (id, data) => sinks.get(id)?.write(data);
  engine.onFailed = (id, error) => {
    const serial = sessions?.serialOf(id);
    if (serial) void sessions?.fail(serial, error);
  };
  engine.onGone = () => {
    for (const serial of sessions?.serials() ?? [])
      void sessions?.fail(serial, '录屏工作窗已退出');
  };
  sessions = new CaptureSessions({
    engine: routed,
    openSink: (file, id) => {
      const sink = openSink(file);
      sinks.set(id, sink);
      return sink;
    },
    sharedFile: createSharedFile,
    // 模拟器可能在流结束片刻后才松开共享文件：带重试地删
    remove: (file) =>
      fs.promises.rm(file, { force: true, maxRetries: 20, retryDelay: 500 }),
    onChange: (state) => onState(state),
    onEnded: (result) => onSaved(result, true),
  });
  return sessions;
}

export function captureStatus(serial: string): CaptureState {
  return sessions?.status(serial) ?? { serial, recording: false };
}

/** 在录的串号 */
export function captureRecordingSerials(): string[] {
  return sessions?.serials() ?? [];
}

export function captureHooks(hooks: {
  onState?: (state: CaptureState) => void;
  onSaved?: (result: CaptureResult, endedByDevice: boolean) => void;
}): void {
  if (hooks.onState) onState = hooks.onState;
  if (hooks.onSaved) onSaved = hooks.onSaved;
}

export type CaptureReply =
  | { ok: true; recording: boolean; file?: string; result?: CaptureResult }
  | { ok: false; error: string };

/** 录屏开关：在录就停，否则开录 */
export async function captureToggle(rawSerial: unknown): Promise<CaptureReply> {
  const serial = typeof rawSerial === 'string' ? rawSerial : '';
  if (!SERIAL_RE.test(serial))
    return { ok: false, error: '仅支持 Android 虚拟机' };
  const sessions = ensureSessions();
  const settings = loadAppSettings();
  const sdk = detectSdk(settings.sdkPath);
  if (sessions.status(serial).recording) {
    try {
      const result = await sessions.stop(serial);
      onSaved(result, false);
      return { ok: true, recording: false, result };
    } catch (err) {
      appendLog(settings.dataRoot, `录屏停止失败 ${serial}：${message(err)}`);
      return { ok: false, error: message(err) };
    }
  }
  const endpoint = findGrpcEndpoint(serial);
  if (!endpoint)
    return { ok: false, error: '未找到模拟器的画面接口，无法录屏' };
  const avd = sdk
    ? await avdOf(sdk, settings.dataRoot, serial).catch(() => undefined)
    : undefined;
  const framed =
    avd && readAvdPrefs(settings.dataRoot, avd.scope, avd.name).captureFrame
      ? skinOf(sdk!, settings.dataRoot, avd)
      : undefined;
  const label = avd?.name ?? serial;
  const fileBase = path.join(
    ensureCaptureDir(settings, 'videos'),
    `${label}-${captureStamp()}`,
  );
  try {
    const { file } = await sessions.start(endpoint, {
      serial,
      fileBase,
      skin: framed
        ? (first) => {
            const picked = pickRecordingLayout(framed.skin, first.rotation);
            return picked
              ? frameSkin(framed.dir, picked.layout, picked.canvasRotation)
              : null;
          }
        : undefined,
    });
    appendLog(
      settings.dataRoot,
      `开始录屏 ${label} → ${file}${framed ? '（带边框）' : ''}`,
    );
    return { ok: true, recording: true, file };
  } catch (err) {
    appendLog(settings.dataRoot, `录屏启动失败 ${label}：${message(err)}`);
    return { ok: false, error: message(err) };
  }
}

/** 设备从列表里消失时的兜底收尾（帧流自己断开是主路径） */
export function stopCapture(serial: string, reason: string): void {
  if (!sessions?.status(serial).recording) return;
  void sessions.stop(serial, reason).catch(() => undefined);
}

/** 应用退出前把在录的收尾落盘；最多等这么久，不能拖住退出 */
export async function finalizeCaptures(timeoutMs: number): Promise<void> {
  if (!sessions || sessions.serials().length === 0) return;
  await Promise.race([
    sessions.stopAll(),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  engine.close();
}

/** 截图落盘。虚拟机开了"带边框"且有皮肤时贴上边框，合成不了就存原图 */
export async function saveScreenshot(
  sdk: SdkInfo,
  settings: Settings,
  serial: string,
  png: Buffer,
): Promise<string> {
  let data = png;
  try {
    data = (await framedScreenshot(sdk, settings, serial, png)) ?? png;
  } catch (err) {
    appendLog(
      settings.dataRoot,
      `截图边框合成失败，按原图保存：${message(err)}`,
    );
  }
  const file = path.join(
    ensureCaptureDir(settings, 'imgs'),
    `${serial}-${captureStamp()}.png`,
  );
  fs.writeFileSync(file, data);
  return file;
}

async function framedScreenshot(
  sdk: SdkInfo,
  settings: Settings,
  serial: string,
  png: Buffer,
): Promise<Buffer | undefined> {
  const target = await avdOf(sdk, settings.dataRoot, serial).catch(
    () => undefined,
  );
  if (
    !target ||
    !readAvdPrefs(settings.dataRoot, target.scope, target.name).captureFrame
  )
    return undefined;
  const source = skinOf(sdk, settings.dataRoot, target);
  const size = pngSize(png);
  if (!source || !size) return undefined;
  const layout = pickStillLayout(source.skin, size.width, size.height);
  // 横竖都对不上的皮肤（折叠屏内外屏之类）硬贴只会拉伸变形，不如不贴
  if (!layout || layout.screen.w > layout.screen.h !== size.width > size.height)
    return undefined;
  return engine.still(png, frameSkin(source.dir, layout, 0));
}

/** 工作窗发来的事件（ipc.ts 把 ipcMain 消息转到这里）；别处冒充的一律不认 */
export function captureEventFrom(sender: WebContents, payload: unknown): void {
  if (!engine.owns(sender) || !payload || typeof payload !== 'object') return;
  const type = (payload as { type?: unknown }).type;
  if (type === 'reply' || type === 'chunk' || type === 'failed')
    engine.event(payload as CaptureEvent);
}
