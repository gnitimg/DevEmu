import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cmdlineTool } from './sdk.ts';
import { downloadToFile } from './net.ts';
import { ShapingProxy } from './throttle.ts';

export interface DownloadItem {
  pkg: string;
  desc: string;
  state: 'queued' | 'downloading' | 'done' | 'failed' | 'cancelled';
  percent: number;
  /** 字节；0 表示未知 */
  downloaded: number;
  total: number;
  /** 字节/秒；0 表示未知 */
  speedBps: number;
  /** 秒；0 表示未知 */
  etaSec: number;
  /** sdkmanager 任务阶段：prepare 准备 / download 下载 / unzip 解压安装 */
  phase?: 'prepare' | 'download' | 'unzip';
  startedAt: number;
  finishedAt?: number;
  error?: string;
  /** 解压落位的组件目录：卸载时删它；缺省表示走 sdkmanager 或无法自动卸载 */
  installDir?: string;
  /** 应用更新包等临时任务：完成/失败不弹通用 toast（由更新链路承接），不写持久化历史 */
  ephemeral?: boolean;
}

/** 并行与限速选项（来自设置页） */
export interface DownloadOptions {
  parallel?: number;
  /** 字节/秒，0 为不限 */
  maxBps?: number;
  /** 上游（用户本机代理）端口；设置走代理线路时使用 */
  upstreamPort?: number;
}

interface Entry extends DownloadItem {
  child: ChildProcess | null;
  samples: { t: number; bytes: number }[];
  cancelRequested?: boolean;
  onStart?: () => void;
  /** 文件任务的 sock 中断（pkg 任务为空） */
  abort?: () => void;
  /** 临时任务（如应用更新包）：不写入已下载持久化历史，安装包装完即焚 */
  ephemeral?: boolean;
  // ---- sdkmanager 任务的显示进度重映射（原始百分比只反映全程位置） ----
  /** 原始百分比 */
  rawPct?: number;
  /** 下载阶段起始原始百分比 */
  dMin?: number;
  /** 解压阶段起始原始百分比与当时的显示进度 */
  unzipStartRaw?: number;
  dispAtUnzip?: number;
}

const active = new Map<string, Entry>();
const queued: Entry[] = [];
const finished: Entry[] = [];
const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;
let seq = 0;
let parallelLimit = 2;

function countRunning(): number {
  return [...active.values()].filter((e) => e.state !== 'queued').length;
}

/** 有空闲槽位时把排队任务拉起 */
function pumpQueue(): void {
  while (queued.length > 0 && countRunning() < parallelLimit) {
    const entry = queued.shift()!;
    // startNow 由闭包在入队时注入
    entry.onStart?.();
  }
}

const UNIT_BYTES: Record<string, number> = {
  b: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3, tb: 1024 ** 4, tib: 1024 ** 4,
};

function toBytes(num: string, unit: string): number {
  const u = UNIT_BYTES[unit.toLowerCase()];
  return u ? parseFloat(num) * u : 0;
}

function fmtUnits(unit: string): number {
  return UNIT_BYTES[unit.toLowerCase()] ?? 1;
}

/** 解析 sdkmanager 进度行：阶段化显示进度（准备 0-5 / 下载 5-95 / 解压 95-100）。
 *  sdkmanager 的原始百分比覆盖"取仓库+下载+解压"全程：下载仅占约 10-33%，
 *  解压在结尾 1 秒冲到 100%，直接展示会"卡住然后跳变"。此处按阶段重映射，
 *  下载段用渐进映射（渐近 95，不预知解压起点也平滑无跳变）。 */
function feedLine(entry: Entry, line: string): void {
  const pct = line.match(/(\d{1,3})\s*%/);
  if (pct) entry.rawPct = Math.min(100, parseInt(pct[1]!, 10));

  if (/Unzipping/i.test(line)) entry.phase = 'unzip';
  else if (/Downloading/i.test(line)) entry.phase = 'download';
  else if (/Loading|Fetch|Computing/i.test(line)) entry.phase = 'prepare';

  // 形如 "12.3 MiB / 80 MiB"（文件任务才有，直接用原始百分比）
  const sizes = line.match(/(\d+(?:\.\d+)?)\s*([KMGT]?i?B|[KMGT]?B)\s*\/\s*(\d+(?:\.\d+)?)\s*([KMGT]?i?B|[KMGT]?B)/i);
  if (sizes) {
    const scale = fmtUnits(sizes[2]!);
    const totalScale = fmtUnits(sizes[4]!);
    entry.downloaded = Math.round(parseFloat(sizes[1]!) * scale);
    entry.total = Math.round(parseFloat(sizes[3]!) * totalScale);
    if (entry.total > 0 && entry.rawPct !== undefined) entry.percent = Math.min(100, Math.round((entry.downloaded / entry.total) * 100));
  } else if (entry.rawPct !== undefined) {
    const raw = entry.rawPct;
    if (entry.phase === 'prepare') {
      entry.percent = Math.min(5, Math.round(raw * 0.5));
    } else if (entry.phase === 'download') {
      if (entry.dMin === undefined || raw < entry.dMin) entry.dMin = raw;
      const x = Math.max(0, raw - entry.dMin);
      const slack = 8; // 原始百分点余量：条渐进逼近 95，速度随下载推进放缓
      entry.percent = Math.min(95, Math.round(5 + (90 * x) / (x + slack)));
    } else if (entry.phase === 'unzip') {
      if (entry.unzipStartRaw === undefined) {
        entry.unzipStartRaw = raw;
        entry.dispAtUnzip = Math.max(5, entry.percent);
      }
      const span = Math.max(1, 100 - entry.unzipStartRaw);
      const base = entry.dispAtUnzip ?? 95;
      entry.percent = Math.min(100, Math.round(base + ((100 - base) * (raw - entry.unzipStartRaw)) / span));
    }
  }

  // sdkmanager 自报速度 "20 MiB/s"：跟随最新值刷新，避免显示停留在首次读数
  if (!sizes) {
    const speed = line.match(/(\d+(?:\.\d+)?)\s*([KMGT]?i?B|[KMGT]?B)\s*\/\s*s/i);
    if (speed) entry.speedBps = toBytes(speed[1]!, speed[2]!);
  }

  // 字节任务记字节；百分比任务把显示进度当样本（供 ETA 估算）
  if (entry.downloaded > 0) {
    entry.samples.push({ t: Date.now(), bytes: entry.downloaded });
    if (entry.samples.length > 30) entry.samples.shift();
  } else if (entry.percent > 0) {
    entry.samples.push({ t: Date.now(), bytes: entry.percent });
    if (entry.samples.length > 30) entry.samples.shift();
  }
}

/** 速度取最近 1 秒窗口的字节差；ETA = 剩余大小 / 速度。
 *  sdkmanager 任务无字节量：用近 15 秒的百分比速度估算 ETA */
function recompute(entry: Entry): void {
  const now = Date.now();
  if (entry.total > 0) {
    const recent = entry.samples.filter((s) => now - s.t <= 1000);
    const old = recent[0];
    const cur = entry.samples[entry.samples.length - 1];
    if (old && cur && now - old.t >= 400) {
      entry.speedBps = Math.max(0, Math.round(((cur.bytes - old.bytes) * 1000) / (cur.t - old.t)));
    }
    if (entry.total > 0 && entry.speedBps > 0) {
      entry.etaSec = Math.max(0, Math.round((entry.total - entry.downloaded) / entry.speedBps));
    } else {
      entry.etaSec = 0;
    }
    return;
  }
  // 百分比模式：仅下载阶段外推（准备/解压阶段太快或太慢，估算无意义）
  if (entry.phase !== 'download') {
    entry.etaSec = 0;
    return;
  }
  const recent = entry.samples.filter((s) => now - s.t <= 15_000);
  const old = recent[0];
  const cur = recent[recent.length - 1];
  if (old && cur && now - old.t >= 3000 && cur.bytes >= old.bytes) {
    const pctPerSec = (cur.bytes - old.bytes) / ((now - old.t) / 1000);
    if (pctPerSec > 0.002) {
      entry.etaSec = Math.max(0, Math.round((95 - cur.bytes) / pctPerSec));
      return;
    }
  }
  entry.etaSec = 0;
}

function ensureTicker(): void {
  if (ticker) return;
  ticker = setInterval(() => {
    for (const entry of active.values()) recompute(entry);
    if (active.size === 0 && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    notify();
  }, 1000);
}

function notify(): void {
  for (const cb of listeners) cb();
}

export function onDownloadsChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function snapshot(entry: Entry): DownloadItem {
  // 显式白名单：Entry 上的函数字段（onStart/abort）与进程句柄不可跨 IPC 结构化克隆
  return {
    pkg: entry.pkg,
    desc: entry.desc,
    state: entry.state,
    percent: entry.percent,
    downloaded: entry.downloaded,
    total: entry.total,
    speedBps: entry.speedBps,
    etaSec: entry.etaSec,
    phase: entry.phase,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    error: entry.error,
    installDir: entry.installDir,
    ephemeral: entry.ephemeral === true,
  };
}

export function listDownloads(): { active: DownloadItem[]; finished: DownloadItem[] } {
  return {
    active: [...active.values()].map(snapshot),
    finished: finished.map(snapshot),
  };
}

/** 删除一条已下载历史记录 */
export function removeFinished(pkg: string, startedAt: number): boolean {
  const i = finished.findIndex((e) => e.pkg === pkg && e.startedAt === startedAt);
  if (i < 0) return false;
  finished.splice(i, 1);
  persistFinished();
  notify();
  return true;
}

/** 查一条已下载记录（卸载前据 installDir 判断该删哪个目录） */
export function getFinished(pkg: string, startedAt: number): DownloadItem | undefined {
  const i = finished.findIndex((e) => e.pkg === pkg && e.startedAt === startedAt);
  return i < 0 ? undefined : snapshot(finished[i]!);
}

/** 同包名任务是否已在队列或进行中：sdk:install 入队前去重用 */
export function isPkgPending(pkg: string): boolean {
  return (
    queued.some((e) => e.pkg === pkg) ||
    [...active.values()].some((v) => v.pkg === pkg)
  );
}

export function cancelDownload(pkg: string): boolean {
  // 排队中的任务直接取消
  const qi = queued.findIndex((e) => e.pkg === pkg);
  if (qi >= 0) {
    const entry = queued.splice(qi, 1)[0]!;
    entry.state = 'cancelled';
    entry.cancelRequested = true;
    finish(entry);
    // 条目已出队，onStart 不会再被 pumpQueue 触发；等待方（Promise resolve /
    // onDone 广播）只挂在 onStart 上，不补调会让环境补装链与 autoBusy 永久挂死
    entry.onStart?.();
    return true;
  }
  // active 的键是 pkg#序号，按 pkg 匹配
  let hit: Entry | undefined;
  for (const v of active.values()) {
    if (v.pkg === pkg) {
      hit = v;
      break;
    }
  }
  if (!hit) return false;
  hit.cancelRequested = true;
  if (hit.child) hit.child.kill();
  else hit.abort?.();
  return true;
}

export function startDownload(
  sdk: { root: string; sdkmanager?: string },
  javaPath: string | null,
  proxy: { port: number } | undefined,
  pkg: string,
  desc: string,
  onLine?: (line: string) => void,
  opts: DownloadOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!sdk.sdkmanager) return Promise.resolve({ ok: false, error: 'SDK 缺少 cmdline-tools' });
  if (opts.parallel && opts.parallel >= 1 && opts.parallel <= 4) parallelLimit = Math.round(opts.parallel);

  const key = `${pkg}#${++seq}`;
  const entry: Entry = {
    pkg, desc, state: 'queued', percent: 0, downloaded: 0, total: 0, speedBps: 0, etaSec: 0,
    startedAt: Date.now(), child: null, samples: [],
  };
  active.set(key, entry);
  ensureTicker();
  notify();

  return new Promise((resolve) => {
    const startNow = () => {
      // 排队期间被取消：必须 resolve，否则串接方（如环境安装链式补装）永久挂死
      if (entry.state === 'cancelled') {
        resolve({ ok: false, error: '已取消' });
        return;
      }
      entry.state = 'downloading';
      void spawnTaskImpl(sdk, javaPath, proxy, pkg, entry, onLine, opts, resolve);
    };
    entry.onStart = startNow;
    if (countRunning() < parallelLimit) startNow();
    else {
      entry.state = 'queued';
      queued.push(entry);
    }
    notify();
  });
}

/** 环境安装包等直链文件任务：下载（含进度/限速/取消）→ postProcess 解压落位 */
export interface FileTask {
  /** 显示与取消用的任务标识 */
  key: string;
  desc: string;
  host: string;
  path: string;
  fileName: string;
  viaProxy: boolean;
  proxyPort?: number;
  /** 字节/秒，0 不限速 */
  maxBps: number;
  /** 解压落位目录（已知时）；postProcess 返回目录时以返回值为准 */
  installDir?: string;
  /** 下载完成后调用（解压/搬移）；返回落位后的组件目录，用于卸载 */
  postProcess: (filePath: string, setPct: (p: number) => void) => Promise<string | void>;
  /** 完成（成功/失败/取消）回调，用于主进程广播 */
  onDone?: (r: { ok: boolean; cancelled?: boolean; error?: string }) => void;
}

/** 入队一个文件下载任务，立即返回；进度经 downloads:changed 广播 */
export function startFileDownload(task: FileTask): void {
  const key = `${task.key}#${++seq}`;
  const entry: Entry = {
    pkg: task.key, desc: task.desc, state: 'queued', percent: 0, downloaded: 0, total: 0, speedBps: 0, etaSec: 0,
    startedAt: Date.now(), child: null, samples: [], installDir: task.installDir,
  };
  active.set(key, entry);
  ensureTicker();
  notify();

  const startNow = () => {
    // 排队期间被取消：cancelDownload 会补调 onStart，这里必须收尾广播，
    // 否则 HarmonyOS 下载的 autoBusy 永远停在 true
    if (entry.state === 'cancelled') {
      task.onDone?.({ ok: false, cancelled: true, error: '已取消' });
      return;
    }
    void fileTaskImpl(entry, task);
  };
  entry.onStart = startNow;
  if (countRunning() < parallelLimit) startNow();
  else {
    entry.state = 'queued';
    queued.push(entry);
  }
  notify();
}

/** 接管 Electron 自身的下载（如华为下载页触发的 zip）：
 *  进度并入下载管理，「取消」作用于外部下载，完成后走 postProcess 收尾。 */
export interface ExternalDownloadTask {
  progress(bytes: number, total: number): void;
  complete(filePath: string): Promise<void>;
  fail(error: string): void;
}

export function adoptExternalDownload(opts: {
  key: string;
  desc: string;
  /** 解压落位目录：卸载时删它 */
  installDir?: string;
  /** 临时任务不写入已下载持久化历史（本次会话内仍可见） */
  ephemeral?: boolean;
  /** 下载管理里点取消 */
  onCancel: () => void;
  postProcess: (filePath: string, setPct: (p: number) => void) => Promise<void>;
  onDone?: (r: { ok: boolean; cancelled?: boolean; error?: string }) => void;
}): ExternalDownloadTask {
  const entry: Entry = {
    pkg: opts.key, desc: opts.desc, state: 'downloading', percent: 0, downloaded: 0, total: 0, speedBps: 0, etaSec: 0,
    startedAt: Date.now(), child: null, samples: [], installDir: opts.installDir, ephemeral: opts.ephemeral,
  };
  active.set(`${opts.key}#${++seq}`, entry);
  ensureTicker();
  notify();
  entry.abort = () => opts.onCancel();
  // 进度事件可能每秒多条：数据照常更新，广播节流，1Hz ticker 兜底补齐显示
  let lastNotify = 0;

  const settle = (state: 'done' | 'failed' | 'cancelled', error?: string) => {
    entry.state = state;
    entry.error = error;
    finish(entry);
    opts.onDone?.({
      ok: state === 'done',
      cancelled: state === 'cancelled',
      error: state === 'failed' ? error : undefined,
    });
  };

  return {
    progress(bytes, total) {
      if (entry.state !== 'downloading') return;
      entry.downloaded = bytes;
      if (total > 0) entry.total = total;
      entry.percent = total > 0 ? Math.min(95, Math.round((bytes / total) * 95)) : Math.min(95, entry.percent + 1);
      entry.samples.push({ t: Date.now(), bytes });
      if (entry.samples.length > 30) entry.samples.shift();
      const now = Date.now();
      if (now - lastNotify >= 500) {
        lastNotify = now;
        notify();
      }
    },
    async complete(filePath) {
      if (entry.state !== 'downloading') return;
      try {
        entry.percent = 96;
        await opts.postProcess(filePath, (p) => {
          entry.percent = Math.max(96, Math.min(99, Math.round(p)));
        });
        entry.percent = 100;
        settle('done');
      } catch (err) {
        settle(entry.cancelRequested ? 'cancelled' : 'failed', err instanceof Error ? err.message : String(err));
      }
    },
    fail(error) {
      if (entry.state !== 'downloading') return;
      settle(entry.cancelRequested ? 'cancelled' : 'failed', entry.cancelRequested ? '已取消' : error);
    },
  };
}

/** 外部进程只报百分比的任务（如 HarmonyOS 模拟器镜像）：进度并入下载管理 */
export interface PercentTask {
  /** 下载管理里的任务标识，同时用于取消匹配 */
  key: string;
  desc: string;
  /** 下载管理里点取消 */
  cancel?: () => void;
  onDone?: (r: { ok: boolean; cancelled?: boolean; error?: string }) => void;
}

export function adoptPercentTask(opts: PercentTask): {
  progress(percent: number | null): void;
  complete(): void;
  fail(error: string): void;
} {
  const entry: Entry = {
    pkg: opts.key, desc: opts.desc, state: 'downloading', percent: 0, downloaded: 0, total: 0, speedBps: 0, etaSec: 0,
    startedAt: Date.now(), child: null, samples: [], phase: 'download',
  };
  active.set(`${opts.key}#${++seq}`, entry);
  ensureTicker();
  notify();
  entry.abort = () => opts.cancel?.();
  // HOS 镜像下载每秒输出多条百分比行：广播节流，1Hz ticker 兜底补齐显示
  let lastNotify = 0;

  const settle = (state: 'done' | 'failed' | 'cancelled', error?: string) => {
    entry.state = state;
    entry.error = error;
    if (state === 'done') entry.percent = 100;
    finish(entry);
    opts.onDone?.({
      ok: state === 'done',
      cancelled: state === 'cancelled',
      error: state === 'failed' ? error : undefined,
    });
  };

  return {
    progress(percent) {
      if (entry.state !== 'downloading' || percent === null) return;
      entry.percent = Math.max(0, Math.min(99, Math.round(percent)));
      entry.samples.push({ t: Date.now(), bytes: entry.percent });
      if (entry.samples.length > 30) entry.samples.shift();
      const now = Date.now();
      if (now - lastNotify >= 500) {
        lastNotify = now;
        notify();
      }
    },
    complete() {
      if (entry.state !== 'downloading') return;
      settle('done');
    },
    fail(error) {
      if (entry.state !== 'downloading') return;
      settle(entry.cancelRequested ? 'cancelled' : 'failed', entry.cancelRequested ? '已取消' : error);
    },
  };
}

async function fileTaskImpl(entry: Entry, task: FileTask): Promise<void> {
  const dlDir = path.join(os.tmpdir(), 'devemu-env-dl');
  // 时间戳前缀隔离：同名安装包并发任务（双击/多环境）写同一 .part 会互相截断
  const dlPath = path.join(dlDir, `${Date.now()}-${task.fileName}.part`);
  entry.state = 'downloading';
  notify();
  let cancelled = false;
  let sockAbort: (() => void) | null = null;
  entry.abort = () => {
    cancelled = true;
    sockAbort?.();
  };
  const isCancelled = () => cancelled || entry.cancelRequested === true;
  try {
    const r = await downloadToFile({ host: task.host, path: task.path }, dlPath, {
      viaProxy: task.viaProxy,
      proxyPort: task.proxyPort,
      maxBps: task.maxBps,
      isCancelled,
      registerAbort: (fn) => {
        sockAbort = fn;
      },
      onProgress: (bytes, total) => {
        entry.downloaded = bytes;
        entry.total = total;
        entry.percent = total > 0 ? Math.min(95, Math.round((bytes / total) * 95)) : Math.min(95, entry.percent + 1);
        entry.samples.push({ t: Date.now(), bytes });
        if (entry.samples.length > 30) entry.samples.shift();
      },
    });
    if (isCancelled()) throw new Error('已取消');
    entry.total = r.total || r.bytes;
    entry.downloaded = r.bytes;
    entry.percent = 96;
    const installedDir = await task.postProcess(dlPath, (p) => {
      entry.percent = Math.max(96, Math.min(99, Math.round(p)));
    });
    if (installedDir) entry.installDir = installedDir;
    entry.percent = 100;
    entry.state = 'done';
    finish(entry);
    task.onDone?.({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isCancelled() || msg === '已取消') {
      entry.state = 'cancelled';
      entry.error = '已取消';
    } else {
      entry.state = 'failed';
      entry.error = msg;
    }
    // 安装包可达数 GB：异步删除，不冻结主进程（尤其是解压刚结束时）
    await fs.promises.rm(dlPath, { force: true }).catch(() => undefined);
    finish(entry);
    task.onDone?.({ ok: false, cancelled: entry.state === 'cancelled', error: entry.error });
  } finally {
    await fs.promises.rm(dlPath, { force: true }).catch(() => undefined);
  }
}

async function spawnTaskImpl(
  sdk: { root: string; sdkmanager?: string },
  javaPath: string | null,
  proxy: { port: number } | undefined,
  pkg: string,
  entry: Entry,
  onLine: ((line: string) => void) | undefined,
  opts: DownloadOptions,
  resolve: (r: { ok: boolean; error?: string }) => void,
): Promise<void> {
  if (!sdk.sdkmanager) {
    entry.state = 'failed';
    entry.error = 'SDK 缺少 cmdline-tools';
    finish(entry);
    resolve({ ok: false, error: 'SDK 缺少 cmdline-tools' });
    return;
  }
  const tool = cmdlineTool(sdk.sdkmanager, javaPath, 'sdkmanager-classpath.jar', 'com.android.sdklib.tool.sdkmanager.SdkManagerCli');

  // 限速：本地整形代理接管（上游按线路设置串用户代理）
  let proxyArgs: string[] = proxy ? ['--proxy_type', 'http', '--proxy_host', '127.0.0.1', '--proxy_port', String(proxy.port)] : [];
  let shaping: ShapingProxy | null = null;
  if (opts.maxBps && opts.maxBps > 0) {
    shaping = new ShapingProxy(opts.maxBps, opts.upstreamPort ? { port: opts.upstreamPort } : undefined);
    try {
      const port = await shaping.start();
      proxyArgs = ['--proxy_type', 'http', '--proxy_host', '127.0.0.1', '--proxy_port', String(port)];
    } catch {
      shaping = null; // 整形代理起不来就回退原线路
    }
  }

  const args = [...tool.prefix, `--sdk_root=${sdk.root}`, ...proxyArgs, pkg];
  // shaping.start 的 await 窗口里可能已被取消：child 尚未存在时 cancelDownload
  // 是空操作，必须在 spawn 前补一次检查，否则任务照常跑完
  if (entry.cancelRequested) {
    shaping?.close();
    entry.state = 'cancelled';
    entry.error = '已取消';
    finish(entry);
    resolve({ ok: false, error: '已取消' });
    return;
  }
  const child = spawn(tool.exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  entry.child = child;

  let buf = '';
  const pump = (text: string) => {
    buf += text;
    // 进度条用单个 \r 覆盖刷新，三种换行都要切开
    const lines = buf.split(/\r\n|\r|\n/);
    buf = lines.pop() ?? '';
    for (const l of lines) {
      if (!l.trim()) continue;
      feedLine(entry, l);
      onLine?.(l);
    }
  };
  child.stdout?.on('data', (c: Buffer) => pump(c.toString('utf8')));
  child.stderr?.on('data', (c: Buffer) => pump(c.toString('utf8')));

  // error 与 close 在异常退出时都会到达（close 总在 error 后）：只按先到的一次收尾，
  // 否则历史里出现两条重复记录、persistFinished 双写
  let childEnded = false;
  child.on('error', (err) => {
    if (childEnded) return;
    childEnded = true;
    entry.state = 'failed';
    entry.error = err.message;
    shaping?.close();
    finish(entry);
    resolve({ ok: false, error: err.message });
  });
  child.on('close', (code) => {
    if (childEnded) return;
    childEnded = true;
    if (entry.state === 'downloading') {
      if (entry.cancelRequested) {
        entry.state = 'cancelled';
      } else if (code === 0) {
        entry.state = 'done';
        entry.percent = 100;
      } else {
        entry.state = 'failed';
        entry.error = `退出码 ${code}`;
      }
    }
    shaping?.close();
    finish(entry);
    resolve({
      ok: !entry.cancelRequested && code === 0,
      error: entry.cancelRequested ? '已取消' : code === 0 ? undefined : `安装进程退出码 ${code}`,
    });
  });
}

/** 完成收尾的延迟：percent 95→100 与归档同帧发生时进度条会瞬间消失，观感是"跳变"；
 *  先广播 done+100 让渲染层用 0.5s 动画补满，再归档移出"下载中" */
const DONE_FILL_MS = 600;

function finish(entry: Entry): void {
  if (entry.finishedAt) return;
  if (entry.state === 'done') {
    notify();
    setTimeout(() => finishNow(entry), DONE_FILL_MS);
    return;
  }
  finishNow(entry);
}

function finishNow(entry: Entry): void {
  entry.finishedAt = Date.now();
  for (const [k, v] of active) {
    if (v === entry) active.delete(k);
  }
  finished.unshift(entry);
  if (finished.length > 50) finished.pop();
  persistFinished();
  pumpQueue();
  notify();
}

// ---------- 已下载历史持久化（主进程重启后不丢） ----------

let storeFile: string | null = null;

/** 注册历史存储位置并加载已有记录（registerIpc 时调用） */
export function initDownloadStore(dataRoot: string): void {
  storeFile = path.join(dataRoot, 'downloads.json');
  if (finished.length > 0) return;
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8')) as { finished?: DownloadItem[] };
    // 只有成功落盘的任务算「已下载」；旧版本写入的失败/取消记录一并丢掉
    for (const it of raw.finished ?? []) if (it.state === 'done') finished.push(it as Entry);
  } catch {
    // 无记录或损坏：空历史
  }
}

function persistFinished(): void {
  if (!storeFile) return;
  try {
    const tmp = `${storeFile}.tmp`;
    // 失败/取消只在当次弹窗提示，不写历史；临时任务（更新包）装完即焚也不写
    const done = finished.filter((e) => e.state === 'done' && !e.ephemeral);
    fs.writeFileSync(tmp, JSON.stringify({ finished: done.map(snapshot) }), 'utf8');
    fs.renameSync(tmp, storeFile);
  } catch {
    // 写失败不影响下载
  }
}
