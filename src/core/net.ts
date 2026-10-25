import net from 'node:net';
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
