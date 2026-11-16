import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ShapingProxy } from './throttle.ts';

const PAYLOAD = Buffer.alloc(512 * 1024, 0x61);

/** 目标端：连接后一次性发 PAYLOAD 再 FIN；返回监听端口 */
async function startTarget(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((sock) => {
    sock.end(PAYLOAD);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as net.AddressInfo).port),
    );
  });
  return { server, port };
}

test('限速整形代理：单隧道大数据量靠定时自醒补牌传完，不卡死', async () => {
  const { server, port } = await startTarget();
  const proxy = new ShapingProxy(128 * 1024);
  const proxyPort = await proxy.start();

  const client = net.connect(proxyPort, '127.0.0.1');
  let bytes = 0;
  const done = new Promise<number>((resolve) => {
    client.on('data', (c: Buffer) => {
      bytes += c.length;
    });
    client.on('close', () => resolve(bytes));
  });
  client.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: t\r\n\r\n`);

  // 512KB @ 128KB/s 约 4 秒传完；修复前令牌桶单唤醒源死锁会在 ~128KB 处
  // 永久挂起，15 秒边界足以区分两种行为
  const total = await Promise.race([
    done,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`限速传输卡死：仅收到 ${bytes} 字节`)),
        15_000,
      ),
    ),
  ]);
  // bye 在远端 FIN 时 destroy 客户端，尾部 ≤32KB 可能被丢弃
  assert.ok(total >= 400 * 1024, `应传完绝大部分数据，实际 ${total}`);

  client.destroy();
  proxy.close();
  server.close();
});
