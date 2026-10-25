import { spawn, type ChildProcess } from 'node:child_process';
import { cmdlineTool } from './sdk.ts';
import type { SdkInfo } from './types.ts';

export interface DownloadItem {
  pkg: string;
  desc: string;
  state: 'downloading' | 'done' | 'failed' | 'cancelled';
  percent: number;
  /** 字节；0 表示未知 */
  downloaded: number;
  total: number;
  /** 字节/秒；0 表示未知 */
  speedBps: number;
  /** 秒；0 表示未知 */
  etaSec: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

interface Entry extends DownloadItem {
  child: ChildProcess | null;
  samples: { t: number; bytes: number }[];
  cancelRequested?: boolean;
}

const active = new Map<string, Entry>();
const finished: Entry[] = [];
const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;
let seq = 0;

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

/** 解析 sdkmanager 进度行：百分比、已下/总大小、速度 */
function feedLine(entry: Entry, line: string): void {
  const pct = line.match(/(\d{1,3})\s*%/);
  if (pct) entry.percent = Math.min(100, parseInt(pct[1]!, 10));

  // 形如 "12.3 MiB / 80 MiB"（分隔符与单位写法多变）
  const sizes = line.match(/(\d+(?:\.\d+)?)\s*([KMGT]?i?B|[KMGT]?B)\s*\/\s*(\d+(?:\.\d+)?)\s*([KMGT]?i?B|[KMGT]?B)/i);
  if (sizes) {
    const scale = fmtUnits(sizes[2]!);
    const totalScale = fmtUnits(sizes[4]!);
    entry.downloaded = Math.round(parseFloat(sizes[1]!) * scale);
    entry.total = Math.round(parseFloat(sizes[3]!) * totalScale);
    if (entry.total > 0 && entry.percent === 0) entry.percent = Math.min(100, Math.round((entry.downloaded / entry.total) * 100));
  }

  // sdkmanager 自报速度 "20 MiB/s"
  if (!sizes) {
    const speed = line.match(/(\d+(?:\.\d+)?)\s*([KMGT]?i?B|[KMGT]?B)\s*\/\s*s/i);
    if (speed && entry.speedBps === 0) entry.speedBps = toBytes(speed[1]!, speed[2]!);
  }

  if (entry.downloaded > 0) {
    entry.samples.push({ t: Date.now(), bytes: entry.downloaded });
    if (entry.samples.length > 30) entry.samples.shift();
  }
}

/** 速度取最近 1 秒窗口的字节差；ETA = 剩余大小 / 速度 */
function recompute(entry: Entry): void {
  const now = Date.now();
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
  const { child: _child, samples: _samples, ...item } = entry;
  return item;
}

export function listDownloads(): { active: DownloadItem[]; finished: DownloadItem[] } {
  return {
    active: [...active.values()].map(snapshot),
    finished: finished.map(snapshot),
  };
}

export function cancelDownload(pkg: string): boolean {
  const entry = active.get(pkg);
  if (!entry || !entry.child) return false;
  entry.cancelRequested = true;
  entry.child.kill();
  return true;
}

export function startDownload(
  sdk: SdkInfo,
  javaPath: string | null,
  proxy: { port: number } | undefined,
  pkg: string,
  desc: string,
  onLine?: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  if (!sdk.sdkmanager) return Promise.resolve({ ok: false, error: 'SDK 缺少 cmdline-tools' });
  const key = `${pkg}#${++seq}`;
  const entry: Entry = {
    pkg, desc, state: 'downloading', percent: 0, downloaded: 0, total: 0, speedBps: 0, etaSec: 0,
    startedAt: Date.now(), child: null, samples: [],
  };
  active.set(key, entry);
  ensureTicker();
  notify();

  const tool = cmdlineTool(sdk.sdkmanager, javaPath, 'sdkmanager-classpath.jar', 'com.android.sdklib.tool.sdkmanager.SdkManagerCli');
  const proxyArgs = proxy ? ['--proxy_type', 'http', '--proxy_host', '127.0.0.1', '--proxy_port', String(proxy.port)] : [];
  const args = [...tool.prefix, `--sdk_root=${sdk.root}`, ...proxyArgs, pkg];
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

  return new Promise((resolve) => {
    child.on('error', (err) => {
      entry.state = 'failed';
      entry.error = err.message;
      finish(entry);
      resolve({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
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
      finish(entry);
      resolve({ ok: !entry.cancelRequested && code === 0, error: entry.cancelRequested ? '已取消' : code === 0 ? undefined : `安装进程退出码 ${code}` });
    });
  });
}

function finish(entry: Entry): void {
  entry.finishedAt = Date.now();
  for (const [k, v] of active) {
    if (v === entry) active.delete(k);
  }
  finished.unshift(entry);
  if (finished.length > 50) finished.pop();
  notify();
}
