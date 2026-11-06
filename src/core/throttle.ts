import net from 'node:net';

/**
 * 本地限速整形代理：sdkmanager 通过 --proxy 走这里，
 * 令牌桶控制每秒转发的字节数实现真实的下载限速。
 * 上游可以是直连，也可以串用户的本地代理（再经我们整形）。
 */
export class ShapingProxy {
  private server: net.Server | null = null;
  private tokens = Infinity;
  private lastRefill = Date.now();
  private waiters: Array<{ n: number; resolve: () => void }> = [];
  private port = 0;
  private closed = false;
  private readonly maxBps: number;
  private readonly upstream?: { port: number };

  constructor(maxBps: number, upstream?: { port: number }) {
    this.maxBps = maxBps;
    this.upstream = upstream;
  }

  async start(): Promise<number> {
    if (this.maxBps <= 0) return 0;
    this.tokens = this.maxBps;
    return new Promise((resolve, reject) => {
      const server = net.createServer((client) => this.onConnection(client));
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') this.port = addr.port;
        this.server = server;
        resolve(this.port);
      });
    });
  }

  close(): void {
    this.closed = true;
    this.server?.close();
    this.server = null;
    for (const w of this.waiters) w.resolve();
    this.waiters = [];
  }

  get listenPort(): number {
    return this.port;
  }

  /** 领取 n 个字节额度；无限制时立即返回。
   *  请求量按桶容量截断：单块 n 超过 maxBps 时 FIFO 唤醒条件永远不满足，
   *  队首卡死会阻塞整条下载管线。 */
  private take(n: number): Promise<void> {
    if (this.maxBps <= 0) return Promise.resolve();
    const need = Math.min(n, this.maxBps);
    this.refill();
    if (this.tokens >= need) {
      this.tokens -= need;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push({ n: need, resolve });
    });
  }

  private refill(): void {
    const now = Date.now();
    const dt = now - this.lastRefill;
    if (dt < 50) return;
    this.lastRefill = now;
    this.tokens = Math.min(this.maxBps, this.tokens + (this.maxBps * dt) / 1000);
    // 唤醒排队者（FIFO，只唤醒额度足够的）
    while (this.waiters.length > 0 && this.tokens >= this.waiters[0]!.n) {
      const w = this.waiters.shift()!;
      this.tokens -= w.n;
      w.resolve();
    }
  }

  private onConnection(client: net.Socket): void {
    client.once('error', () => client.destroy());
    let head = '';
    const onData = (chunk: Buffer) => {
      head += chunk.toString('latin1');
      const idx = head.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (head.length > 8192) client.destroy();
        return;
      }
      client.removeListener('data', onData);
      const reqLine = head.slice(0, head.indexOf('\r\n'));
      const m = reqLine.match(/^CONNECT\s+(\S+):(\d+)\s+HTTP/i);
      if (!m) {
        client.write('HTTP/1.1 405 Only CONNECT allowed\r\n\r\n');
        client.destroy();
        return;
      }
      this.tunnel(client, m[1]!, parseInt(m[2]!, 10));
    };
    client.on('data', onData);
  }

  private tunnel(client: net.Socket, host: string, port: number): void {
    // 上游/目标连接必须带超时：用户代理或目标挂起时（防火墙丢包不回 RST）
    // 否则下载永久卡死且无任何报错
    const openUpstream = (cb: (sock: net.Socket) => void) => {
      const bail = (sock: net.Socket, message: string) => {
        sock.destroy();
        if (!client.destroyed) {
          client.write(`HTTP/1.1 502 ${message}\r\n\r\n`);
          client.destroy();
        }
      };
      if (this.upstream) {
        const sock = net.connect(this.upstream.port, '127.0.0.1');
        sock.setTimeout(10_000, () => bail(sock, 'Upstream timeout'));
        sock.once('connect', () => {
          sock.setTimeout(10_000, () => bail(sock, 'Upstream timeout'));
          sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
          let resp = '';
          const onUp = (c: Buffer) => {
            resp += c.toString('latin1');
            if (!/\r\n\r\n/.test(resp)) {
              // 与客户端路径 8KB 头上限对称：异常上游无限头会撑爆内存
              if (resp.length > 8192) bail(sock, 'Upstream header too large');
              return;
            }
            sock.removeListener('data', onUp);
            sock.setTimeout(0);
            if (/^HTTP\/1\.[01] 200/.test(resp)) cb(sock);
            else bail(sock, 'Upstream refused');
          };
          sock.on('data', onUp);
        });
        sock.once('error', () => bail(sock, 'Upstream error'));
      } else {
        const sock = net.connect(port, host);
        sock.setTimeout(10_000, () => bail(sock, 'Connect timeout'));
        sock.once('connect', () => {
          sock.setTimeout(0);
          cb(sock);
        });
        sock.once('error', () => bail(sock, 'Connect failed'));
      }
    };

    openUpstream((remote) => {
      if (this.closed) {
        remote.destroy();
        client.destroy();
        return;
      }
      client.write('HTTP/1.1 200 Connection established\r\n\r\n');

      // 下行（远端 → sdkmanager）是下载数据，整形限速；上行走透传
      const pumpDown = async (chunk: Buffer) => {
        remote.pause();
        let off = 0;
        while (off < chunk.length && !this.closed) {
          const piece = chunk.subarray(off, Math.min(off + 32 * 1024, chunk.length));
          await this.take(piece.length);
          if (this.closed) break;
          if (!client.write(piece)) {
            // drain 之外 close/error 也要唤醒：对端断开时等 drain 会永久挂起
            await new Promise<void>((r) => {
              client.once('drain', r);
              client.once('close', r);
              client.once('error', r);
            });
          }
          off += piece.length;
        }
        remote.resume();
      };
      remote.on('data', (c: Buffer) => {
        void pumpDown(c).catch(() => undefined);
      });
      client.on('data', (c: Buffer) => {
        // 上行背压：remote 写满要暂停的是数据源 client（暂停 remote 挡不住
        // client 继续泵数据，只会无界缓冲）
        if (!remote.write(c)) client.pause();
      });
      remote.on('drain', () => client.resume());
      const bye = () => {
        client.destroy();
        remote.destroy();
      };
      client.once('close', bye);
      remote.once('close', bye);
      remote.once('error', bye);
    });
  }
}
