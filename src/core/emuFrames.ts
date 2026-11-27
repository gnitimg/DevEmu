import http2 from 'node:http2';
import type { Quarter } from './skin.ts';

/**
 * 模拟器 gRPC 的截图通道（android.emulation.control.EmulatorController）。
 * 与虚拟定位共用同一套端点发现与令牌鉴权；只实现 protobuf 线格式的这几个消息。
 */

export interface EmuEndpoint {
  port: number;
  token: string;
}

export interface EmuFrameMeta {
  width: number;
  height: number;
  rotation: Quarter;
  seq: number;
}

/** Image 消息：走共享内存通道时 data 为空，像素在共享文件里 */
export interface EmuFrame extends EmuFrameMeta {
  data?: Buffer;
}

export type PixelFormat = 'rgba' | 'png';

const FORMAT_ID: Record<PixelFormat, number> = { png: 0, rgba: 1 };
const RPC_PATH = '/android.emulation.control.EmulatorController/';
const CONNECT_MS = 1500;
/** 单条消息上限：原生分辨率下 RGBA 一帧约 10MB，留足余量再拦异常值 */
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;
/** 共享文件句柄的长度上限：模拟器实测 123 字符可用、124 起返回 INTERNAL */
export const SHARED_HANDLE_MAX = 120;

interface Field {
  number: number;
  kind: 'varint' | 'bytes';
  value: number;
  bytes: Buffer;
}

function readVarint(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('protobuf 数据截断');
    const byte = buf[pos++]!;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7;
    if (shift > 49) throw new Error('protobuf varint 过长');
  }
}

function writeVarint(value: number): Buffer {
  const bytes: number[] = [];
  for (let v = value; ; v = Math.floor(v / 128)) {
    bytes.push((v % 128) + (v >= 128 ? 128 : 0));
    if (v < 128) break;
  }
  return Buffer.from(bytes);
}

function fields(message: Buffer): Field[] {
  const out: Field[] = [];
  let pos = 0;
  while (pos < message.length) {
    let tag: number;
    [tag, pos] = readVarint(message, pos);
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) {
      let value: number;
      [value, pos] = readVarint(message, pos);
      out.push({ number, kind: 'varint', value, bytes: Buffer.alloc(0) });
    } else if (wire === 2) {
      let length: number;
      [length, pos] = readVarint(message, pos);
      if (pos + length > message.length) throw new Error('protobuf 数据截断');
      out.push({
        number,
        kind: 'bytes',
        value: 0,
        bytes: message.subarray(pos, pos + length),
      });
      pos += length;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      throw new Error(`protobuf 线格式不支持：${wire}`);
    }
  }
  return out;
}

/** 解析 Image 消息（宽高与朝向在内嵌的 ImageFormat 里） */
export function decodeImageMessage(message: Buffer): EmuFrame {
  const frame: EmuFrame = { width: 0, height: 0, rotation: 0, seq: 0 };
  for (const field of fields(message)) {
    if (field.number === 1) {
      for (const format of fields(field.bytes)) {
        if (format.number === 2) {
          for (const turn of fields(format.bytes))
            if (turn.number === 1) frame.rotation = turn.value as Quarter;
        } else if (format.number === 3) frame.width = format.value;
        else if (format.number === 4) frame.height = format.value;
      }
    } else if (field.number === 2) frame.width ||= field.value;
    else if (field.number === 3) frame.height ||= field.value;
    else if (field.number === 4) frame.data = field.bytes;
    else if (field.number === 5) frame.seq = field.value;
  }
  return frame;
}

/** ImageFormat 请求；给出 sharedMemory（file:/// 句柄）时改走共享内存传输通道 */
export function encodeImageFormat(
  format: PixelFormat,
  sharedMemory?: string,
): Buffer {
  // 混入 concat 的结果后不再限定底层缓冲类型
  const parts: Buffer[] = [Buffer.from([8, FORMAT_ID[format]])];
  if (sharedMemory) {
    const handle = Buffer.from(sharedMemory, 'utf8');
    const transport = Buffer.concat([
      Buffer.from([8, 1]),
      Buffer.from([18]),
      writeVarint(handle.length),
      handle,
    ]);
    parts.push(Buffer.from([50]), writeVarint(transport.length), transport);
  }
  return Buffer.concat(parts);
}

/** gRPC 长度前缀消息切分：数据块边界与消息边界无关，一条消息也可能拆在多块里 */
export class GrpcMessages {
  private chunks: Buffer[] = [];
  private size = 0;

  /** 喂入一个数据块，返回其中已完整的消息（借用输入缓冲，用完即弃） */
  push(chunk: Buffer): Buffer[] {
    this.chunks.push(chunk);
    this.size += chunk.length;
    const out: Buffer[] = [];
    while (this.size >= 5) {
      const length = this.peek(5).readUInt32BE(1);
      if (length > MAX_MESSAGE_BYTES) {
        this.chunks = [];
        this.size = 0;
        throw new Error('模拟器返回了过大的帧消息');
      }
      if (this.size < 5 + length) break;
      out.push(this.take(5 + length).subarray(5));
    }
    return out;
  }

  private peek(count: number): Buffer {
    const first = this.chunks[0]!;
    if (first.length >= count) return first;
    const head = Buffer.allocUnsafe(count);
    let copied = 0;
    for (const chunk of this.chunks) {
      chunk.copy(head, copied, 0, Math.min(count - copied, chunk.length));
      copied += chunk.length;
      if (copied >= count) break;
    }
    return head;
  }

  private take(count: number): Buffer {
    const first = this.chunks[0]!;
    this.size -= count;
    if (first.length >= count) {
      this.chunks[0] = first.subarray(count);
      if (this.chunks[0].length === 0) this.chunks.shift();
      return first.subarray(0, count);
    }
    const whole = Buffer.allocUnsafe(count);
    let copied = 0;
    while (copied < count) {
      const chunk = this.chunks[0]!;
      const slice = Math.min(count - copied, chunk.length);
      chunk.copy(whole, copied, 0, slice);
      copied += slice;
      this.chunks[0] = chunk.subarray(slice);
      if (this.chunks[0].length === 0) this.chunks.shift();
    }
    return whole;
  }
}

export function sharedHandle(file: string): string {
  return `file:///${file.replace(/\\/g, '/')}`;
}

const requestHeaders = (token: string, method: string) =>
  ({
    ':method': 'POST',
    ':path': `${RPC_PATH}${method}`,
    'content-type': 'application/grpc',
    te: 'trailers',
    authorization: `Bearer ${token}`,
  }) as http2.OutgoingHttpHeaders;

function rpcError(headers: http2.IncomingHttpHeaders): Error {
  const status = String(headers['grpc-status'] ?? '');
  let detail = String(headers['grpc-message'] ?? '');
  try {
    detail = decodeURIComponent(detail);
  } catch {
    // 非百分号编码的原文照用
  }
  return new Error(
    `模拟器拒绝了截图请求（${status || headers[':status']}）${detail}`,
  );
}

/** 发出请求并等到响应头：被拒绝或超时抛错，否则给出数据流 */
function openRequest(
  client: http2.ClientHttp2Session,
  token: string,
  method: string,
  payload: Buffer,
  timeoutMs: number,
): Promise<http2.ClientHttp2Stream> {
  const req = client.request(requestHeaders(token, method));
  return new Promise<http2.ClientHttp2Stream>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.close(http2.constants.NGHTTP2_CANCEL);
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new Error('模拟器截图接口无响应')),
      timeoutMs,
    );
    req.on('error', fail);
    req.on('response', (headers) => {
      if (settled) return;
      if (
        Number(headers[':status']) !== 200 ||
        Number(headers['grpc-status'] ?? 0) !== 0
      ) {
        fail(rpcError(headers));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(req);
    });
    const head = Buffer.alloc(5);
    head.writeUInt32BE(payload.length, 1);
    req.end(Buffer.concat([head, payload]));
  });
}

async function connect(port: number): Promise<http2.ClientHttp2Session> {
  const client = http2.connect(`http://127.0.0.1:${port}`);
  // 连接级错误由各请求自己转达；这里兜住事件，防止没人监听时冒成未捕获异常
  client.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('连接模拟器控制接口超时'));
    }, CONNECT_MS);
    client.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    client.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return client;
}

/** 取一帧。录屏起始帧用它：帧流只在画面变化时才推，开录瞬间画面多半是静止的 */
export async function grabFrame(
  endpoint: EmuEndpoint,
  format: PixelFormat,
  timeoutMs = 15_000,
): Promise<EmuFrame> {
  const client = await connect(endpoint.port);
  try {
    const req = await openRequest(
      client,
      endpoint.token,
      'getScreenshot',
      encodeImageFormat(format),
      timeoutMs,
    );
    const frame = await new Promise<EmuFrame>((resolve, reject) => {
      const reader = new GrpcMessages();
      const timer = setTimeout(
        () => reject(new Error('模拟器截图接口无响应')),
        timeoutMs,
      );
      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.on('data', (chunk: Buffer) => {
        try {
          // 只有一帧；多余的按协议异常丢弃
          for (const message of reader.push(chunk))
            resolve(decodeImageMessage(message));
        } catch (err) {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      req.on('end', () => {
        clearTimeout(timer);
        reject(new Error('模拟器未返回画面'));
      });
    });
    if (!frame.data?.length)
      throw new Error('模拟器未返回画面（可能尚未完成启动）');
    return frame;
  } finally {
    client.close();
  }
}

export interface FrameStream {
  /** 模拟器接受帧流后兑现；被拒绝或连接失败则拒绝 */
  ready: Promise<void>;
  /** 主动收流：之后不再触发 onEnd */
  close(): void;
}

/**
 * 打开帧流。给出 sharedMemory 时走共享内存通道：模拟器把像素直接写进该文件，
 * 每条消息只报尺寸与朝向（onFrame 回调后文件内容即该帧）。文件由模拟器在流结束时删除。
 */
export function openFrameStream(
  endpoint: EmuEndpoint,
  opts: {
    sharedMemory?: string;
    onFrame: (meta: EmuFrameMeta) => void;
    onEnd: () => void;
  },
): FrameStream {
  const client = http2.connect(`http://127.0.0.1:${endpoint.port}`);
  client.on('error', () => undefined);
  let req: http2.ClientHttp2Stream | undefined;
  let closed = false;
  let ended = false;
  let settleReady: { ok: () => void; fail: (err: Error) => void } | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    settleReady = { ok: resolve, fail: reject };
  });
  // ready 可能没人等（比如起流后立刻收流）：拒绝不能变成未处理的 rejection
  ready.catch(() => undefined);
  const finish = () => {
    if (closed || ended) return;
    ended = true;
    opts.onEnd();
  };
  const readyTimer = setTimeout(
    () => settleReady?.fail(new Error('模拟器未响应帧流请求')),
    10_000,
  );
  client.once('error', () => {
    settleReady?.fail(new Error('模拟器控制接口连接中断'));
    finish();
  });
  client.once('connect', () => {
    if (closed) {
      client.close();
      return;
    }
    req = client.request(requestHeaders(endpoint.token, 'streamScreenshot'));
    const reader = new GrpcMessages();
    req.on('response', (headers) => {
      if (
        Number(headers[':status']) !== 200 ||
        Number(headers['grpc-status'] ?? 0) !== 0
      ) {
        // 拒绝只经 ready 报告：收流引发的结束事件不再当成"流断了"
        ended = true;
        settleReady?.fail(rpcError(headers));
        req?.close(http2.constants.NGHTTP2_CANCEL);
      } else {
        clearTimeout(readyTimer);
        settleReady?.ok();
      }
    });
    req.on('data', (chunk: Buffer) => {
      try {
        for (const message of reader.push(chunk)) {
          const frame = decodeImageMessage(message);
          // 屏幕关闭等状态下模拟器会报 0x0 的空帧
          if (frame.width > 0 && frame.height > 0) opts.onFrame(frame);
        }
      } catch {
        req?.close(http2.constants.NGHTTP2_CANCEL);
      }
    });
    req.on('error', () => finish());
    req.on('end', () => finish());
    const payload = encodeImageFormat('rgba', opts.sharedMemory);
    const head = Buffer.alloc(5);
    head.writeUInt32BE(payload.length, 1);
    req.end(Buffer.concat([head, payload]));
  });
  return {
    ready,
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(readyTimer);
      req?.close(http2.constants.NGHTTP2_CANCEL);
      client.close();
    },
  };
}
