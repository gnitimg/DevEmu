import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EmuFrame, EmuFrameMeta, FrameStream } from './emuFrames.ts';
import type { FrameSkin } from './captureProtocol.ts';
import {
  CaptureSessions,
  type CaptureEngine,
  type CaptureResult,
  type CaptureState,
  type CaptureTransport,
} from './captureSession.ts';

const ENDPOINT = { port: 8554, token: 'token' };
const SERIAL = 'emulator-5554';
const SHARED = 'C:\\d\\emulator-5554.rgba';
const SKIN: FrameSkin = {
  width: 1209,
  height: 2553,
  screen: { x: 60, y: 69, w: 1080, h: 2400 },
  screenRotation: 0,
  canvasRotation: 0,
  backgrounds: [{ x: 0, y: 0, data: new ArrayBuffer(3) }],
  onions: [],
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

class FakeEngine implements CaptureEngine {
  prepares: unknown[] = [];
  rolled: ArrayBuffer[] = [];
  frames: [string, EmuFrameMeta, { path: string; bytes: number }][] = [];
  finished: string[] = [];
  aborted: string[] = [];
  finishError?: Error;
  async prepare(opts: unknown) {
    this.prepares.push(opts);
    return { mimeType: 'video/mp4;codecs=avc1', extension: 'mp4' };
  }
  async roll(id: string, first: ArrayBuffer) {
    void id;
    this.rolled.push(first);
  }
  frame(
    id: string,
    meta: EmuFrameMeta,
    shared: { path: string; bytes: number },
  ) {
    this.frames.push([id, meta, shared]);
  }
  async finish(id: string) {
    if (this.finishError) throw this.finishError;
    this.finished.push(id);
    return { frames: this.frames.length };
  }
  abort(id: string) {
    this.aborted.push(id);
  }
}

type StreamOptions = Parameters<CaptureTransport['openFrameStream']>[1];

class FakeStream implements FrameStream {
  ready: Promise<void>;
  closed = 0;
  accept!: () => void;
  refuse!: (err: Error) => void;
  opts: StreamOptions;

  constructor(opts: StreamOptions) {
    this.opts = opts;
    this.ready = new Promise<void>((resolve, reject) => {
      this.accept = resolve;
      this.refuse = reject;
    });
  }
  push(rotation: 0 | 1 | 2 | 3 = 0) {
    const turned = rotation === 1 || rotation === 3;
    this.opts.onFrame({
      width: turned ? 2400 : 1080,
      height: turned ? 1080 : 2400,
      rotation,
      seq: 1,
    });
  }
  end() {
    this.opts.onEnd();
  }
  close() {
    this.closed++;
  }
}

class FakeTransport implements CaptureTransport {
  streams: FakeStream[] = [];
  frame: EmuFrame = {
    width: 1080,
    height: 2400,
    rotation: 0,
    seq: 0,
    data: Buffer.from('png'),
  };
  grabError?: Error;
  async grabFrame() {
    if (this.grabError) throw this.grabError;
    return this.frame;
  }
  openFrameStream(
    _endpoint: Parameters<CaptureTransport['openFrameStream']>[0],
    opts: StreamOptions,
  ) {
    const stream = new FakeStream(opts);
    this.streams.push(stream);
    return stream;
  }
}

class FakeSink {
  chunks: unknown[] = [];
  failClose?: Error;
  file: string;
  id: string;
  constructor(file: string, id: string) {
    this.file = file;
    this.id = id;
  }
  write(data: unknown) {
    this.chunks.push(data);
  }
  async close() {
    if (this.failClose) throw this.failClose;
    return this.chunks.length * 100;
  }
}

function harness() {
  const engine = new FakeEngine();
  const transport = new FakeTransport();
  const sinks: FakeSink[] = [];
  const removed: string[] = [];
  const states: CaptureState[] = [];
  const ended: CaptureResult[] = [];
  const sharedBytes = new Map<string, number>();
  const env = { sharedDisabled: false };
  const sessions = new CaptureSessions({
    engine,
    transport,
    openSink: (file, id) => {
      const sink = new FakeSink(file, id);
      sinks.push(sink);
      return sink;
    },
    sharedFile: (serial, bytes) => {
      if (env.sharedDisabled) return undefined;
      sharedBytes.set(serial, bytes);
      return `C:\\d\\${serial}.rgba`;
    },
    remove: async (file) => {
      removed.push(file);
    },
    onChange: (state) => states.push(state),
    onEnded: (result) => ended.push(result),
  });
  const fileBase = 'C:\\v\\emulator-5554-2026-11-25T05-20-00-000Z';
  /** 只发起开录，帧流停在"等模拟器接受"：需要观察中途状态的用例用这个。
   *  被拒绝的开录 Promise 先挂空处理，免得等待期间被判成未处理的拒绝 */
  const begin = (
    skin?: (first: EmuFrameMeta) => FrameSkin | null,
    serial = SERIAL,
  ) => {
    const pending = sessions.start(ENDPOINT, { serial, fileBase, skin });
    pending.catch(() => undefined);
    return pending;
  };
  /** 开录并等帧流被接受、首帧画完 */
  const start = async (
    skin?: (first: EmuFrameMeta) => FrameSkin | null,
    serial = SERIAL,
  ) => {
    const pending = begin(skin, serial);
    await tick();
    transport.streams.at(-1)?.accept();
    return pending;
  };
  return {
    sessions,
    engine,
    transport,
    sinks,
    removed,
    states,
    ended,
    sharedBytes,
    env,
    fileBase,
    start,
    begin,
  };
}

test('开录：先探测首帧、备画布，帧流被接受后才画首帧开录', async () => {
  const h = harness();
  const pending = h.begin((first) => (first.rotation === 0 ? SKIN : null));
  await tick();
  const stream = h.transport.streams[0]!;
  assert.deepEqual(h.engine.prepares[0], {
    id: '1',
    width: 1080,
    height: 2400,
    rotation: 0,
    skin: SKIN,
  });
  // 共享文件按首帧的像素字节数建，请求里带 file:/// 句柄
  assert.equal(h.sharedBytes.get(SERIAL), 1080 * 2400 * 4);
  assert.equal(stream.opts.sharedMemory, 'file:///C:/d/emulator-5554.rgba');
  assert.equal(h.sinks[0]!.file, `${h.fileBase}.mp4`);
  assert.equal(h.sinks[0]!.id, '1', '落盘流带着会话号，分块按它路由');
  assert.deepEqual(h.sessions.status(SERIAL), {
    serial: SERIAL,
    recording: true,
    since: h.sessions.status(SERIAL).since,
    file: `${h.fileBase}.mp4`,
  });
  assert.equal(h.engine.rolled.length, 0, '帧流被接受前不开录');
  stream.accept();
  assert.deepEqual(await pending, { file: `${h.fileBase}.mp4` });
  assert.equal(Buffer.from(h.engine.rolled[0]!).toString(), 'png');

  stream.push();
  stream.push(3);
  assert.deepEqual(
    h.engine.frames.map(([id, meta, shared]) => [
      id,
      meta.rotation,
      meta.width,
      shared,
    ]),
    [
      ['1', 0, 1080, { path: SHARED, bytes: 1080 * 2400 * 4 }],
      ['1', 3, 2400, { path: SHARED, bytes: 1080 * 2400 * 4 }],
    ],
  );
  stream.closed = 0;
  const result = await h.sessions.stop(SERIAL);
  assert.deepEqual(
    { ...result, durationMs: typeof result.durationMs },
    { file: `${h.fileBase}.mp4`, bytes: 0, durationMs: 'number', frames: 2 },
  );
  assert.equal(stream.closed, 1, '停录先收流');
  assert.deepEqual(h.engine.finished, ['1']);
  assert.deepEqual(h.engine.aborted, []);
  assert.equal(h.sessions.status(SERIAL).recording, false);
  assert.deepEqual(h.removed, [SHARED], '模拟器没删掉的共享文件由我们收尾');
  assert.deepEqual(
    h.states.map((s) => s.recording),
    [true, true, false],
  );
});

test('帧流自行结束（虚拟机关闭）：自动收尾并带告警通知', async () => {
  const h = harness();
  await h.start();
  const stream = h.transport.streams[0]!;
  stream.push();
  stream.push();
  stream.end();
  await tick();
  assert.equal(h.sessions.status(SERIAL).recording, false);
  assert.equal(h.ended.length, 1);
  assert.equal(h.ended[0]!.frames, 2);
  assert.equal(h.ended[0]!.warning, '虚拟机画面流已结束');
  assert.deepEqual(h.engine.finished, ['1']);
});

test('帧流被拒绝：开录失败，文件与共享文件都清掉', async () => {
  const h = harness();
  const pending = h.begin();
  await tick();
  h.transport.streams[0]!.refuse(
    new Error('模拟器拒绝了截图请求（13）internal'),
  );
  await assert.rejects(pending, /拒绝了截图请求（13）/);
  assert.equal(h.sessions.status(SERIAL).recording, false);
  assert.equal(h.engine.rolled.length, 0);
  assert.deepEqual(h.engine.aborted, ['1']);
  assert.deepEqual(h.removed.sort(), [`${h.fileBase}.mp4`, SHARED].sort());
});

test('拿不到首帧或建不了共享文件时不开流', async () => {
  const h = harness();
  h.transport.grabError = new Error('模拟器未返回画面（可能尚未完成启动）');
  await assert.rejects(h.start(), /未返回画面/);
  assert.equal(h.transport.streams.length, 0);
  assert.equal(h.sinks.length, 0);

  h.transport.grabError = undefined;
  h.env.sharedDisabled = true;
  await assert.rejects(h.start(), /无法创建录屏缓存文件/);
  assert.equal(
    h.transport.streams.length,
    0,
    '没有共享文件就没有像素，不白发帧流',
  );
  assert.equal(h.sessions.status(SERIAL).recording, false);
  assert.deepEqual(h.removed, [`${h.fileBase}.mp4`]);
});

test('同一台虚拟机不能重复开录：连流期间与开录后都拒绝', async () => {
  const h = harness();
  const pending = h.begin();
  await tick();
  await assert.rejects(h.start(), /正在录屏/);
  h.transport.streams[0]!.accept();
  await pending;
  await assert.rejects(h.start(), /正在录屏/);
  assert.equal(h.transport.streams.length, 1);
});

test('并发停录只收尾一次并拿到同一结果', async () => {
  const h = harness();
  await h.start();
  const first = h.sessions.stop(SERIAL);
  const second = h.sessions.stop(SERIAL);
  assert.equal(first, second);
  await first;
  assert.deepEqual(h.engine.finished, ['1']);
  assert.equal(h.transport.streams[0]!.closed, 1);
  await assert.rejects(h.sessions.stop(SERIAL), /未在录屏/);
});

test('落盘失败：报保存失败，残缺文件删除', async () => {
  const h = harness();
  await h.start();
  h.sinks[0]!.failClose = new Error('ENOSPC: no space left on device');
  await assert.rejects(h.sessions.stop(SERIAL), /录屏保存失败：ENOSPC/);
  assert.equal(h.sessions.status(SERIAL).recording, false);
  // 共享文件收流即清；残缺的视频文件随后删除
  assert.deepEqual(h.removed, [SHARED, `${h.fileBase}.mp4`]);
});

test('编码器收尾失败：文件保留并带告警', async () => {
  const h = harness();
  await h.start();
  h.sinks[0]!.write(new ArrayBuffer(4));
  h.engine.finishError = new Error('renderer gone');
  const result = await h.sessions.stop(SERIAL);
  assert.equal(result.warning, '录屏中断：renderer gone');
  assert.equal(result.bytes, 100);
  assert.equal(result.file, `${h.fileBase}.mp4`);
  assert.ok(!h.removed.includes(result.file), '已写出的分块还能播，文件不删');
  assert.deepEqual(h.engine.aborted, ['1']);
});

test('开录途中点停止：按取消处理，不留文件', async () => {
  const h = harness();
  const pending = h.begin();
  await tick();
  const stopping = h.sessions.stop(SERIAL);
  h.transport.streams[0]!.accept();
  await assert.rejects(pending, /录屏已取消/);
  await assert.rejects(stopping, /录屏已取消/);
  assert.equal(h.engine.rolled.length, 0);
  assert.equal(h.sessions.status(SERIAL).recording, false);
  assert.deepEqual(h.removed, [SHARED, `${h.fileBase}.mp4`]);
});

test('工作窗报编码失败：带告警自动收尾', async () => {
  const h = harness();
  await h.start();
  h.sessions.fail(SERIAL, 'encoder error');
  await tick();
  assert.equal(h.sessions.status(SERIAL).recording, false);
  assert.deepEqual(h.engine.finished, ['1']);
});

test('stopAll 把多台在录的虚拟机一起收尾', async () => {
  const h = harness();
  await h.start();
  await h.start(undefined, 'emulator-5556');
  assert.deepEqual(h.sessions.serials().sort(), [
    'emulator-5554',
    'emulator-5556',
  ]);
  await h.sessions.stopAll();
  assert.deepEqual(h.sessions.serials(), []);
  assert.deepEqual(h.engine.finished.sort(), ['1', '2']);
});
