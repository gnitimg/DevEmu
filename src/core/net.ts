import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

export type SystemId = 'android' | 'harmonyos';
export type RouteId = 'direct' | 'proxy';

/** 各系统测速目标（真实可达的官方源） */
export const ROUTE_TARGETS: Record<SystemId, { host: string; path: string }> = {
  android: { host: 'dl.google.com', path: '/android/repository/repository2-3.xml' },
  harmonyos: { host: 'developer.huawei.com', path: '/consumer/cn/' },
};

/** 存储的线路：直连 与 本地代理 */
export const ROUTES: { id: RouteId; name: string }[] = [
  { id: 'direct', name: '直连' },
  { id: 'proxy', name: '本地代理' },
];

export interface RouteProbe {
  id: RouteId;
  name: string;
  ok: boolean;
  /** 平均延迟（毫秒，-1 表示全部失败） */
  latencyMs: number;
  /** 丢包率 0-1 */
  loss: number;
  /** 真实下载速度 字节/秒（GET 实测） */
  speedBps: number;
}

const LATENCY_SAMPLES = 3;
const MAX_SPEED_BYTES = 4 * 1024 * 1024;

type Sock = tls.TLSSocket;

/** 建立一条到目标的 TLS 连接（直连，或经本地代理 CONNECT 隧道） */
function connect(
  target: { host: string; path: string },
  viaProxy: boolean,
  proxyPort: number,
  timeoutMs: number,
): Promise<Sock> {
  return new Promise((resolve, reject) => {
    const fail = (e: Error) => reject(e);
    if (!viaProxy) {
      const s = tls.connect({ host: target.host, port: 443, servername: target.host, rejectUnauthorized: false });
      s.setTimeout(timeoutMs, () => {
        s.destroy();
        reject(new Error('timeout'));
      });
      s.once('error', fail);
      s.once('secureConnect', () => {
        s.removeAllListeners('error');
        s.setTimeout(0);
        resolve(s);
      });
      return;
    }
    const sock = net.connect(proxyPort, '127.0.0.1');
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      reject(new Error('timeout'));
    });
    sock.once('error', fail);
    sock.once('connect', () => {
      sock.write(`CONNECT ${target.host}:443 HTTP/1.1\r\nHost: ${target.host}:443\r\n\r\n`);
    });
    let head = '';
    sock.on('data', (chunk: Buffer) => {
      head += chunk.toString('latin1');
      if (!/\r\n\r\n/.test(head)) return;
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        sock.destroy();
        return reject(new Error('proxy refused'));
      }
      sock.removeAllListeners('data');
      sock.removeAllListeners('error');
      const s = tls.connect({ socket: sock, servername: target.host, rejectUnauthorized: false });
      s.setTimeout(timeoutMs, () => {
        s.destroy();
        reject(new Error('timeout'));
      });
      s.once('error', fail);
      s.once('secureConnect', () => {
        s.removeAllListeners('error');
        s.setTimeout(0);
        resolve(s);
      });
    });
  });
}

/** 一次 HEAD 请求测延迟（毫秒） */
async function headOnce(target: { host: string; path: string }, viaProxy: boolean, proxyPort: number): Promise<number> {
  const s = await connect(target, viaProxy, proxyPort, 6000);
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    s.setTimeout(6000, () => {
      s.destroy();
      reject(new Error('timeout'));
    });
    s.once('error', (e) => {
      s.destroy();
      reject(e);
    });
    s.once('data', () => {
      const dt = Date.now() - t0;
      s.destroy();
      resolve(dt);
    });
    s.write(`HEAD ${target.path} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
  });
}

/** 一次完整 GET 实测下载速度（字节/秒） */
async function speedOnce(target: { host: string; path: string }, viaProxy: boolean, proxyPort: number): Promise<number> {
  const s = await connect(target, viaProxy, proxyPort, 8000);
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let bytes = 0;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      s.destroy();
      const ms = Date.now() - t0;
      resolve(ms > 0 ? Math.round((bytes / ms) * 1000) : 0);
    };
    s.setTimeout(10_000, done);
    s.once('error', () => {
      if (settled) return;
      settled = true;
      s.destroy();
      reject(new Error('network'));
    });
    s.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes >= MAX_SPEED_BYTES) done();
    });
    s.once('end', done);
    s.write(`GET ${target.path} HTTP/1.1\r\nHost: ${target.host}\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
  });
}

/** 测一条线路：延迟取 3 次平均、丢包率、下载速度 1 次实测 */
export async function probeRoute(
  system: SystemId,
  routeId: RouteId,
  proxyPort?: number,
): Promise<RouteProbe> {
  const meta = ROUTES.find((r) => r.id === routeId)!;
  const target = ROUTE_TARGETS[system];
  const viaProxy = routeId === 'proxy';
  if (viaProxy && !proxyPort) return { id: routeId, name: meta.name, ok: false, latencyMs: -1, loss: 1, speedBps: 0 };
  const port = proxyPort ?? 0;
  const latencies: number[] = [];
  let failed = 0;
  for (let i = 0; i < LATENCY_SAMPLES; i++) {
    try {
      latencies.push(await headOnce(target, viaProxy, port));
    } catch {
      failed++;
    }
  }
  let speed = 0;
  try {
    speed = await speedOnce(target, viaProxy, port);
  } catch {
    speed = 0;
  }
  if (latencies.length === 0) {
    return { id: routeId, name: meta.name, ok: false, latencyMs: -1, loss: 1, speedBps: 0 };
  }
  const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  return { id: routeId, name: meta.name, ok: failed === 0, latencyMs: avg, loss: failed / LATENCY_SAMPLES, speedBps: speed };
}

/** 一次测完某系统的全部线路（并行） */
export async function probeSystemRoutes(system: SystemId, proxyPort?: number): Promise<RouteProbe[]> {
  const ids: RouteId[] = ROUTES.map((r) => r.id);
  return Promise.all(ids.map((id) => probeRoute(system, id, proxyPort)));
}

/* ---------- 文件下载（环境安装包等）：流式落盘、进度、限速、取消、跟随重定向 ---------- */

export interface DlTarget {
  host: string;
  path: string;
}

export interface DlOptions {
  viaProxy?: boolean;
  proxyPort?: number;
  /** 字节/秒，0 或缺省不限速 */
  maxBps?: number;
  onProgress?: (bytes: number, total: number) => void;
  /** 返回 true 时中断并抛“已取消” */
  isCancelled?: () => boolean;
  /** 注册中断函数（下载管理取消按钮调用） */
  registerAbort?: (abort: () => void) => void;
}

const DL_REDIRECT_LIMIT = 6;
const DL_IDLE_TIMEOUT_MS = 30_000;
const DL_STRING_CAP = 64 * 1024 * 1024;

function parseHeaders(header: string): { status: number; location?: string; total: number } {
  const status = parseInt(header.split(' ')[1] ?? '0', 10) || 0;
  const location = header.match(/^location:\s*(\S+)/im)?.[1];
  const total = parseInt(header.match(/^content-length:\s*(\d+)/im)?.[1] ?? '0', 10) || 0;
  return { status, location, total };
}

/** 发起一次 GET，把响应体逐块交给 sink；3xx 返回 Location 由上层重连 */
async function getOnce(
  target: DlTarget,
  viaProxy: boolean,
  proxyPort: number,
  opts: DlOptions,
  sink: (chunk: Buffer) => Promise<void>,
): Promise<{ status: number; location?: string; bytes: number; total: number }> {
  const s = await connect(target, viaProxy, proxyPort, 10_000);
  return new Promise((resolve, reject) => {
    let header = '';
    let meta: { status: number; location?: string; total: number } | null = null;
    let bytes = 0;
    let winStart = Date.now();
    let winBytes = 0;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const abort = () => {
      s.destroy();
    };
    opts.registerAbort?.(abort);

    const fail = (e: Error) => {
      s.destroy();
      done(() => reject(e));
    };
    s.on('error', fail);
    s.setTimeout(DL_IDLE_TIMEOUT_MS, () => fail(new Error('下载超时（30 秒无数据）')));

    s.write(
      `GET ${target.path} HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: DevEmu\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
    );

    s.on('data', (chunk: Buffer) => {
      if (settled) return;
      if (opts.isCancelled?.()) {
        s.destroy();
        done(() => reject(new Error('已取消')));
        return;
      }
      if (!meta) {
        header += chunk.toString('latin1');
        const idx = header.indexOf('\r\n\r\n');
        if (idx === -1) return;
        meta = parseHeaders(header.slice(0, idx));
        if ([301, 302, 303, 307, 308].includes(meta.status) && meta.location) {
          s.destroy();
          done(() => resolve({ ...meta, status: meta!.status, location: meta!.location, bytes: 0, total: 0 }));
          return;
        }
        if (meta.status < 200 || meta.status >= 300) {
          fail(new Error(`HTTP ${meta.status}`));
          return;
        }
        chunk = chunk.subarray(idx + 4);
        if (chunk.length === 0) return;
      }
      const body = chunk;
      bytes += body.length;
      winBytes += body.length;
      s.pause();
      void (async () => {
        try {
          // 令牌桶粗限速：单窗口超量则等满窗口
          if (opts.maxBps && opts.maxBps > 0) {
            const now = Date.now();
            if (now - winStart >= 1000) {
              winStart = now;
              winBytes = body.length;
            } else if (winBytes > opts.maxBps) {
              await new Promise((r) => setTimeout(r, Math.max(50, 1000 - (now - winStart))));
              winStart = Date.now();
              winBytes = 0;
            }
          }
          if (opts.isCancelled?.()) throw new Error('已取消');
          await sink(body);
          opts.onProgress?.(bytes, meta!.total);
          s.resume();
        } catch (e) {
          fail(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    });
    s.on('end', () => {
      if (!meta) return fail(new Error('连接被中断'));
      done(() => resolve({ status: meta!.status, bytes, total: meta!.total }));
    });
    s.on('close', () => {
      if (!settled && meta) done(() => resolve({ status: meta!.status, bytes, total: meta!.total }));
    });
  });
}

function applyRedirect(current: DlTarget, location: string): DlTarget | null {
  try {
    const u = new URL(location, `https://${current.host}${current.path}`);
    if (u.protocol !== 'https:') return null;
    return { host: u.host, path: u.pathname + u.search };
  } catch {
    return null;
  }
}

async function download(
  first: DlTarget,
  opts: DlOptions,
  sink: (chunk: Buffer) => Promise<void>,
): Promise<{ bytes: number; total: number }> {
  let target = first;
  for (let hop = 0; hop < DL_REDIRECT_LIMIT; hop++) {
    const r = await getOnce(target, !!opts.viaProxy, opts.proxyPort ?? 0, opts, sink);
    if (r.location) {
      const next = applyRedirect(target, r.location);
      if (!next) throw new Error('不支持的下载地址');
      target = next;
      continue;
    }
    return { bytes: r.bytes, total: r.total };
  }
  throw new Error('重定向次数过多');
}

/** 下载到文件（失败时删除残留文件） */
export async function downloadToFile(target: DlTarget, dest: string, opts: DlOptions = {}): Promise<{ bytes: number; total: number }> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  let fileErr: Error | null = null;
  out.on('error', (e) => {
    fileErr = e;
  });
  const writeChunk = (b: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (fileErr) return reject(fileErr);
      if (out.write(b)) resolve();
      else out.once('drain', () => (fileErr ? reject(fileErr) : resolve()));
    });
  try {
    return await download(target, opts, writeChunk);
  } catch (e) {
    try {
      fs.rmSync(dest, { force: true });
    } catch {
      // 清理失败忽略
    }
    throw e;
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }
}

/** 下载小文件到字符串（版本清单 / API 响应），超过上限报错 */
export async function downloadToString(target: DlTarget, opts: DlOptions = {}): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const { bytes } = await download(target, opts, async (b) => {
    size += b.length;
    if (size > DL_STRING_CAP) throw new Error('响应过大');
    chunks.push(b);
  });
  void bytes;
  return Buffer.concat(chunks).toString('utf8');
}
