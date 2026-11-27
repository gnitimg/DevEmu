import { test } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import {
  GrpcMessages,
  SHARED_HANDLE_MAX,
  decodeImageMessage,
  encodeImageFormat,
  grabFrame,
  openFrameStream,
  sharedHandle,
  type EmuFrameMeta,
} from './emuFrames.ts';

/** 构造一条 Image 消息（字段号与 emulator_controller.proto 一致；宽高用 varint，测试值均 < 128） */
function byte(value: number): Buffer {
  const out: number[] = [];
  for (let v = value; ; v = Math.floor(v / 128)) {
    out.push((v % 128) + (v >= 128 ? 128 : 0));
    if (v < 128) break;
  }
  return Buffer.from(out);
}
function frame(
  width: number,
  height: number,
  rotation: number,
  seq: number,
  data?: Buffer,
): Buffer {
  const format = Buffer.concat([
    Buffer.from([18, 2, 8, rotation]),
    Buffer.from([24]),
    byte(width),
    Buffer.from([32]),
    byte(height),
  ]);
  const parts = [Buffer.from([10]), byte(format.length), format];
  if (data) parts.push(Buffer.from([34]), byte(data.length), data);
  parts.push(Buffer.from([40]), byte(seq));
  return Buffer.concat(parts);
}
const wrap = (message: Buffer) => {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(message.length, 1);
  return Buffer.concat([head, message]);
};

test('解码 Image 消息：宽高与朝向取自内嵌的 ImageFormat', () => {
  const data = Buffer.from([1, 2, 3]);
  const decoded = decodeImageMessage(frame(1080, 2400, 3, 52, data));
  assert.deepEqual(
    { ...decoded, data: undefined },
    { width: 1080, height: 2400, rotation: 3, seq: 52, data: undefined },
  );
  assert.ok(decoded.data?.equals(data));
  // 旧字段（deprecated 的 width/height）在缺失 ImageFormat 宽高时兜底
  const legacy = Buffer.concat([
    Buffer.from([16]),
    byte(640),
    Buffer.from([24]),
    byte(480),
  ]);
  const fallback = decodeImageMessage(legacy);
  assert.equal(fallback.width, 640);
  assert.equal(fallback.height, 480);
});

test('ImageFormat 请求编码：RGBA 与 PNG 的格式号，共享内存句柄进 transport', () => {
  assert.deepEqual([...encodeImageFormat('rgba')], [8, 1]);
  assert.deepEqual([...encodeImageFormat('png')], [8, 0]);
  const handle = sharedHandle('C:\\ProgramData\\DevEmu\\capture\\f.rgba');
  assert.equal(handle, 'file:///C:/ProgramData/DevEmu/capture/f.rgba');
  const encoded = encodeImageFormat('rgba', handle);
  // format=1；transport(6)={channel(1)=MMAP(1), handle(2)=句柄}
  assert.equal(encoded[0], 8);
  assert.equal(encoded[1], 1);
  assert.equal(encoded[2], 50);
  assert.deepEqual([...encoded.subarray(4, 6)], [8, 1]);
  assert.equal(encoded[6], 18);
  const handleLength = encoded[7]!;
  assert.equal(encoded.subarray(8, 8 + handleLength).toString('utf8'), handle);
});

test('gRPC 消息切分：块边界与消息边界无关，多条与半条都处理', () => {
  const a = frame(10, 20, 0, 1, Buffer.from('aa'));
  const b = frame(30, 40, 1, 2, Buffer.from('bbbb'));
  const stream = Buffer.concat([wrap(a), wrap(b), wrap(a)]);
  for (const size of [1, 2, 3, 5, 7, 13, 64, 1000]) {
    const reader = new GrpcMessages();
    const got: Buffer[] = [];
    for (let i = 0; i < stream.length; i += size) {
      got.push(...reader.push(stream.subarray(i, i + size)));
    }
    assert.deepEqual(
      got.map((m) => [...m]),
      [[...a], [...b], [...a]],
      `块大小 ${size}`,
    );
  }
  // 过大的长度前缀按异常拦下
  const bad = new GrpcMessages();
  const bomb = Buffer.alloc(5);
  bomb.writeUInt32BE(0x7fffffff, 1);
  assert.throws(() => bad.push(bomb), /过大/);
});

async function fakeServer(
  handler: (
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders,
    body: Buffer,
  ) => void,
): Promise<{ port: number; close(): Promise<void> }> {
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () =>
      handler(
        stream as http2.ServerHttp2Stream,
        headers,
        Buffer.concat(chunks),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
const ENDPOINT = { port: 0, token: 'test-token' };

test('grabFrame：带令牌请求 getScreenshot，取回一帧', async () => {
  let seen: { path: string; auth: string; body: Buffer } | undefined;
  const png = Buffer.from('png-bytes');
  const server = await fakeServer((stream, headers, body) => {
    seen = {
      path: String(headers[':path']),
      auth: String(headers.authorization),
      body,
    };
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
    stream.end(wrap(frame(1080, 2400, 0, 0, png)));
  });
  const got = await grabFrame({ ...ENDPOINT, port: server.port }, 'png');
  assert.deepEqual(
    {
      path: seen!.path,
      auth: seen!.auth,
      request: [...seen!.body.subarray(5)],
    },
    {
      path: '/android.emulation.control.EmulatorController/getScreenshot',
      auth: 'Bearer test-token',
      request: [8, 0],
    },
  );
  assert.equal(got.width, 1080);
  assert.equal(got.height, 2400);
  assert.ok(got.data?.equals(png));
  await server.close();
});

test('grabFrame：被拒绝或空响应时报中文错误', async () => {
  const denied = await fakeServer((stream) => {
    stream.respond({
      ':status': 200,
      'grpc-status': 16,
      'grpc-message': 'Unauthenticated',
    });
    stream.end();
  });
  await assert.rejects(
    grabFrame({ ...ENDPOINT, port: denied.port }, 'png'),
    /模拟器拒绝了截图请求（16）Unauthenticated/,
  );
  await denied.close();
  const empty = await fakeServer((stream) => {
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
    stream.end(wrap(frame(1080, 2400, 0, 0)));
  });
  await assert.rejects(
    grabFrame({ ...ENDPOINT, port: empty.port }, 'png'),
    /未返回画面/,
  );
  await empty.close();
});

test('帧流：消息切分后逐帧回调，服务端收流触发 onEnd', async () => {
  let path = '';
  let request: Buffer = Buffer.alloc(0);
  const server = await fakeServer((stream, headers, body) => {
    path = String(headers[':path']);
    request = body.subarray(5);
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
    // 一块里两条消息，另一条拆成两块
    stream.write(
      Buffer.concat([
        wrap(frame(1080, 2400, 0, 1)),
        wrap(frame(1080, 2400, 0, 2)),
      ]),
    );
    const split = wrap(frame(2400, 1080, 3, 3));
    stream.write(split.subarray(0, 9));
    setTimeout(() => stream.end(split.subarray(9)), 30);
  });
  const frames: EmuFrameMeta[] = [];
  let ended = 0;
  const stream = openFrameStream(
    { ...ENDPOINT, port: server.port },
    {
      onFrame: (meta) => frames.push(meta),
      onEnd: () => {
        ended += 1;
      },
    },
  );
  await stream.ready;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    path,
    '/android.emulation.control.EmulatorController/streamScreenshot',
  );
  // 未给共享文件时请求里只有格式号
  assert.deepEqual([...request], [8, 1]);
  assert.deepEqual(
    frames.map((f) => [f.width, f.height, f.rotation, f.seq]),
    [
      [1080, 2400, 0, 1],
      [1080, 2400, 0, 2],
      [2400, 1080, 3, 3],
    ],
  );
  assert.equal(ended, 1);
  stream.close();
  await server.close();
});

test('帧流：被拒绝时 ready 拒绝；主动收流不再触发 onEnd', async () => {
  const denied = await fakeServer((stream) => {
    stream.respond({
      ':status': 200,
      'grpc-status': 13,
      'grpc-message': 'internal',
    });
    stream.end();
  });
  let ended = 0;
  const refused = openFrameStream(
    { ...ENDPOINT, port: denied.port },
    { onFrame: () => undefined, onEnd: () => void ended++ },
  );
  await assert.rejects(refused.ready, /模拟器拒绝了截图请求（13）internal/);
  // 拒绝只经 ready 报一次，不再触发 onEnd
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(ended, 0);
  refused.close();
  await denied.close();

  const ok = await fakeServer((stream) => {
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
    // 保持打开直到客户端收流
  });
  const live = openFrameStream(
    { ...ENDPOINT, port: ok.port },
    { onFrame: () => undefined, onEnd: () => void ended++ },
  );
  await live.ready;
  live.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(ended, 0, '主动收流不应再报 onEnd');
  await ok.close();
});

test('帧流：共享内存句柄随请求发出，0x0 空帧不下发', async () => {
  let request: Buffer = Buffer.alloc(0);
  const server = await fakeServer((stream, _headers, body) => {
    request = body.subarray(5);
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
    stream.end(wrap(frame(0, 0, 0, 4)));
  });
  const frames: EmuFrameMeta[] = [];
  const stream = openFrameStream(
    { ...ENDPOINT, port: server.port },
    {
      sharedMemory: 'file:///C:/d/f.rgba',
      onFrame: (m) => frames.push(m),
      onEnd: () => undefined,
    },
  );
  await stream.ready;
  await new Promise((resolve) => setTimeout(resolve, 100));
  // transport = channel(2 字节) + handle(2 字节头 + 句柄)；长度按结构推导，不手数
  const handle = Buffer.from('file:///C:/d/f.rgba');
  assert.deepEqual(
    [...request],
    [8, 1, 50, 4 + handle.length, 8, 1, 18, handle.length, ...handle],
  );
  assert.equal(frames.length, 0);
  stream.close();
  await server.close();
});

test('sharedHandle 把 Windows 路径写成模拟器认的 file:/// 句柄，上限按字符数算', () => {
  assert.equal(
    sharedHandle('C:\\ProgramData\\DevEmu\\f.rgba'),
    'file:///C:/ProgramData/DevEmu/f.rgba',
  );
  assert.equal(
    sharedHandle('C:\\中文目录\\帧.rgba'),
    'file:///C:/中文目录/帧.rgba',
  );
  // 实测 123 字符可用、124 起被拒；上限留了余量
  assert.ok(SHARED_HANDLE_MAX < 123);
  assert.ok(
    SHARED_HANDLE_MAX >
      'file:///C:/Users/GNiTi/AppData/Local/DevEmu/.data/.runtime/devemu-capture-5554-abc123.rgba'
        .length,
  );
});
