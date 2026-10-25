import net from 'node:net';
import tls from 'node:tls';

export interface RouteProbe {
  name: '直连' | '代理';
  ok: boolean;
  /** 平均延迟（毫秒，-1 表示全部失败） */
  latencyMs: number;
  /** 丢包率 0-1 */
  loss: number;
}

const HOST = 'dl.google.com';
const PATH = '/android/repository/repository2-3.xml';
const SAMPLES = 4;

function onceViaProxy(port: number, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const sock = net.connect(port, '127.0.0.1');
    const fail = (e: Error) => {
      sock.destroy();
      reject(e);
    };
    sock.setTimeout(timeoutMs, () => fail(new Error('timeout')));
    sock.on('error', fail);
    sock.on('connect', () => {
      sock.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`);
    });
    let head = '';
    sock.on('data', (chunk: Buffer) => {
      head += chunk.toString('latin1');
      if (!/\r\n\r\n/.test(head)) return;
      if (!/^HTTP\/1\.[01] 200/.test(head)) return fail(new Error('proxy refused'));
      sock.removeAllListeners('data');
      sock.removeAllListeners('error');
      const tlsSock = tls.connect({ socket: sock, servername: HOST, rejectUnauthorized: false }, () => {
        tlsSock.write(`HEAD ${PATH} HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`);
      });
      tlsSock.setTimeout(timeoutMs, () => {
        tlsSock.destroy();
        reject(new Error('timeout'));
      });
      tlsSock.on('error', (e: Error) => {
        tlsSock.destroy();
        reject(e);
      });
      tlsSock.on('data', () => {
        // 收到响应头即算通
        const dt = Date.now() - t0;
        tlsSock.destroy();
        resolve(dt);
      });
    });
  });
}

function onceDirect(timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = tls.connect({ host: HOST, port: 443, servername: HOST, rejectUnauthorized: false }, () => {
      req.write(`HEAD ${PATH} HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', (e: Error) => {
      req.destroy();
      reject(e);
    });
    req.on('data', () => {
      const dt = Date.now() - t0;
      req.destroy();
      resolve(dt);
    });
  });
}

async function probe(name: '直连' | '代理', fn: () => Promise<number>): Promise<RouteProbe> {
  const latencies: number[] = [];
  let failed = 0;
  for (let i = 0; i < SAMPLES; i++) {
    try {
      latencies.push(await fn());
    } catch {
      failed++;
    }
  }
  if (latencies.length === 0) return { name, ok: false, latencyMs: -1, loss: 1 };
  const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  return { name, ok: failed === 0, latencyMs: avg, loss: failed / SAMPLES };
}

/** 测速直连与本地代理两条线路到 Google SDK 仓库的延迟与丢包 */
export async function probeRoutes(proxyPort?: number): Promise<RouteProbe[]> {
  const results: RouteProbe[] = [await probe('直连', () => onceDirect(6000))];
  if (proxyPort) {
    results.push(await probe('代理', () => onceViaProxy(proxyPort, 6000)));
  }
  return results;
}
