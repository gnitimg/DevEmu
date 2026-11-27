import { grabFrame, openFrameStream, sharedHandle } from './emuFrames.ts';
import type {
  EmuEndpoint,
  EmuFrame,
  EmuFrameMeta,
  FrameStream,
  PixelFormat,
} from './emuFrames.ts';
import type { Quarter } from './skin.ts';
import type { FrameSkin, PrepareReply, StopReply } from './captureProtocol.ts';

/**
 * 录屏会话编排：探测首帧 → 工作窗备好画布与封装 → 落盘流 → 帧流 → 开录。
 * 依赖全部注入，Electron 相关的部分（隐藏窗口、文件）留在这层之外。
 */

export interface CaptureEngine {
  /** 建画布、选封装；此时还不开始编码 */
  prepare(opts: {
    id: string;
    width: number;
    height: number;
    rotation: Quarter;
    skin: FrameSkin | null;
  }): Promise<PrepareReply>;
  /** 画首帧并开始编码 */
  roll(id: string, firstFrame: ArrayBuffer): Promise<void>;
  /** 帧到了：像素在共享文件里 */
  frame(
    id: string,
    meta: EmuFrameMeta,
    shared: { path: string; bytes: number },
  ): void;
  /** 停录并等分块全部交出 */
  finish(id: string): Promise<StopReply>;
  abort(id: string): void;
}

export interface CaptureSink {
  write(data: ArrayBuffer | Uint8Array): void;
  /** 等全部落盘并返回字节数；写失败抛错 */
  close(): Promise<number>;
}

export interface CaptureTransport {
  grabFrame(endpoint: EmuEndpoint, format: PixelFormat): Promise<EmuFrame>;
  openFrameStream(
    endpoint: EmuEndpoint,
    opts: {
      sharedMemory?: string;
      onFrame: (meta: EmuFrameMeta) => void;
      onEnd: () => void;
    },
  ): FrameStream;
}

export interface CaptureState {
  serial: string;
  recording: boolean;
  since?: number;
  file?: string;
}

export interface CaptureResult {
  file: string;
  bytes: number;
  durationMs: number;
  frames: number;
  /** 录到了但收尾不干净：文件保留，提示可能不完整 */
  warning?: string;
}

export interface CaptureDeps {
  engine: CaptureEngine;
  /** 给这次录屏开落盘流；id 是会话号，工作窗交回的分块按它路由 */
  openSink: (file: string, id: string) => Promise<CaptureSink> | CaptureSink;
  /** 帧流的共享文件：建好并给出路径；建不了返回 undefined（没有它帧数据拿不到） */
  sharedFile: (serial: string, bytes: number) => string | undefined;
  remove: (path: string) => Promise<void>;
  onChange: (state: CaptureState) => void;
  /** 帧流自行结束（虚拟机关闭或崩溃）后录屏自动收尾 */
  onEnded?: (result: CaptureResult) => void;
  transport?: CaptureTransport;
}

export interface StartOptions {
  serial: string;
  /** 不含扩展名：扩展名按工作窗实际选到的封装补 */
  fileBase: string;
  /** 按首帧的尺寸与朝向定边框；不给或不适用即不带边框 */
  skin?: (first: EmuFrameMeta) => FrameSkin | null;
}

interface Session {
  id: string;
  serial: string;
  file: string;
  sink: CaptureSink;
  stream?: FrameStream;
  shared?: { path: string; bytes: number };
  startedAt: number;
  frames: number;
  rolling: boolean;
  stopping?: Promise<CaptureResult>;
}

const defaultTransport: CaptureTransport = {
  grabFrame: (endpoint, format) => grabFrame(endpoint, format),
  openFrameStream: (endpoint, opts) => openFrameStream(endpoint, opts),
};

function toArrayBuffer(data: Buffer): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
}

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export class CaptureSessions {
  private sessions = new Map<string, Session>();
  private starting = new Set<string>();
  private seq = 0;
  private transport: CaptureTransport;
  private deps: CaptureDeps;

  constructor(deps: CaptureDeps) {
    this.deps = deps;
    this.transport = deps.transport ?? defaultTransport;
  }

  status(serial: string): CaptureState {
    const s = this.sessions.get(serial);
    return s
      ? {
          serial,
          recording: true,
          since: s.startedAt || Date.now(),
          file: s.file,
        }
      : { serial, recording: false };
  }

  serials(): string[] {
    return [...this.sessions.keys()];
  }

  /** 会话号对应的串号：工作窗只认会话号 */
  serialOf(id: string): string | undefined {
    for (const [serial, session] of this.sessions)
      if (session.id === id) return serial;
    return undefined;
  }

  private changed(serial: string): void {
    this.deps.onChange(this.status(serial));
  }

  async start(
    endpoint: EmuEndpoint,
    opts: StartOptions,
  ): Promise<{ file: string }> {
    const { serial } = opts;
    if (this.sessions.has(serial) || this.starting.has(serial))
      throw new Error('该虚拟机正在录屏');
    this.starting.add(serial);
    let session: Session | undefined;
    try {
      const first = await this.transport.grabFrame(endpoint, 'png');
      if (!first.data) throw new Error('模拟器未返回画面（可能尚未完成启动）');
      const id = String(++this.seq);
      const { extension } = await this.deps.engine.prepare({
        id,
        width: first.width,
        height: first.height,
        rotation: first.rotation,
        skin: opts.skin?.(first) ?? null,
      });
      const file = `${opts.fileBase}.${extension}`;
      const sink = await this.deps.openSink(file, id);
      // 闭包里拿不到对 session 的收窄，单独留一个确定的引用
      const live: Session = {
        id,
        serial,
        file,
        sink,
        startedAt: 0,
        frames: 0,
        rolling: false,
      };
      session = live;
      this.sessions.set(serial, live);
      this.changed(serial);
      const bytes = first.width * first.height * 4;
      const sharedPath = this.deps.sharedFile(serial, bytes);
      if (!sharedPath)
        throw new Error('无法创建录屏缓存文件，请检查存储位置是否可写');
      live.shared = { path: sharedPath, bytes };
      live.stream = this.transport.openFrameStream(endpoint, {
        sharedMemory: sharedHandle(sharedPath),
        onFrame: (meta) => {
          live.frames++;
          this.deps.engine.frame(id, meta, live.shared!);
        },
        onEnd: () => this.ended(live),
      });
      await live.stream.ready;
      // 备画布、连流期间用户可能已经点了停止
      if (live.stopping) {
        await live.stopping.catch(() => undefined);
        throw new Error('录屏已取消');
      }
      await this.deps.engine.roll(id, toArrayBuffer(first.data));
      live.startedAt = Date.now();
      live.rolling = true;
      this.changed(serial);
      return { file };
    } catch (err) {
      if (session)
        await (
          session.stopping ??
          this.releaseLater(session, false, undefined, '录屏未能开始')
        ).catch(() => undefined);
      throw err;
    } finally {
      this.starting.delete(serial);
    }
  }

  /** 停止并把文件落定。warning：调用方已知的收尾问题（编码器报错等）；
   *  notStarted：还没开录成功就被停掉时的提示语 */
  stop(
    serial: string,
    warning?: string,
    notStarted = '录屏已取消',
  ): Promise<CaptureResult> {
    const s = this.sessions.get(serial);
    if (!s) return Promise.reject(new Error('该虚拟机未在录屏'));
    return (s.stopping ??= this.releaseLater(s, true, warning, notStarted));
  }

  /** 工作窗报告编码失败：按带告警收尾 */
  fail(serial: string, reason: string): void {
    const s = this.sessions.get(serial);
    if (s && !s.stopping)
      void this.stop(serial, `录屏中断：${reason}`).catch(() => undefined);
  }

  /** 应用退出前把所有在录的收尾；单个失败不拖累其余 */
  async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.serials()].map((serial) => this.stop(serial)),
    );
  }

  private ended(s: Session): void {
    if (s.stopping) return;
    void this.stop(
      s.serial,
      '虚拟机画面流已结束',
      '虚拟机画面流已结束，录屏没有开始',
    )
      .then((result) => this.deps.onEnded?.(result))
      .catch(() => undefined);
  }

  /** 同一会话只收尾一次；收尾失败的拒绝可能没人等，先挂个空处理防未捕获 */
  private releaseLater(
    s: Session,
    keep: boolean,
    warning: string | undefined,
    notStarted: string,
  ): Promise<CaptureResult> {
    const pending = this.release(s, keep, warning, notStarted);
    s.stopping = pending;
    pending.catch(() => undefined);
    return pending;
  }

  /** 收流、停编码、等落盘。keep=false（没开录成功）时文件一并删除 */
  private async release(
    s: Session,
    keep: boolean,
    warning: string | undefined,
    notStarted: string,
  ): Promise<CaptureResult> {
    s.stream?.close();
    // 模拟器通常在流结束时自己删共享文件；这里兜底，失败路径上也不留 10MB 残片
    if (s.shared) void this.deps.remove(s.shared.path).catch(() => undefined);
    const durationMs = s.rolling ? Date.now() - s.startedAt : 0;
    let problem = warning;
    if (s.rolling) {
      try {
        await this.deps.engine.finish(s.id);
      } catch (err) {
        // 已写出的分块通常还能播：留着并提示可能不完整
        problem = `录屏中断：${message(err)}`;
        this.deps.engine.abort(s.id);
      }
    } else this.deps.engine.abort(s.id);
    let bytes = 0;
    try {
      bytes = await s.sink.close();
    } catch (err) {
      // 磁盘写满等：残缺文件没有保留价值
      await this.deps.remove(s.file).catch(() => undefined);
      this.forget(s);
      throw new Error(`录屏保存失败：${message(err)}`);
    }
    this.forget(s);
    if (!s.rolling) {
      await this.deps.remove(s.file).catch(() => undefined);
      throw new Error(notStarted);
    }
    if (!keep) await this.deps.remove(s.file).catch(() => undefined);
    return {
      file: s.file,
      bytes,
      durationMs,
      frames: s.frames,
      ...(problem ? { warning: problem } : {}),
    };
  }

  private forget(s: Session): void {
    this.sessions.delete(s.serial);
    this.changed(s.serial);
  }
}
