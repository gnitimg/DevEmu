import {
  canvasSize,
  compose,
  imageTransform,
  pickContainer,
  videoBitrate,
  type CaptureCommand,
  type CaptureEvent,
  type FrameNotice,
  type FrameSkin,
  type PrepareReply,
  type StopReply,
  type Transform,
} from '../core/captureProtocol.ts';
import { frameAngle } from '../core/skin.ts';
import type { Quarter, SkinRect } from '../core/skin.ts';

/**
 * 录屏工作窗页面（#capture 路由）。这是个隐藏窗口：帧在这里画上画布，
 * MediaRecorder 编码后把分块交回主进程落盘；带边框的截图也在这里合成。
 * 像素由 preload 从共享文件读好送进来，页面自己不碰文件。
 */

interface CaptureBridge {
  onCommand(cb: (cmd: CaptureCommand) => void): void;
  onFrame(cb: (notice: FrameNotice, pixels: ArrayBuffer | null) => void): void;
  send(event: CaptureEvent): void;
}

interface Placed {
  x: number;
  y: number;
  bitmap: ImageBitmap;
}

interface LoadedSkin {
  screen: SkinRect;
  screenRotation: Quarter;
  /** layout 平面 → 画布（含整幅旋转与偶数边的 1px 伸缩） */
  plane: Transform;
  backgrounds: Placed[];
  mask?: ImageBitmap;
  onions: Placed[];
}

interface Session {
  id: string;
  mimeType: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** 每帧先落到这张画布，再按变换画上去 */
  staging: HTMLCanvasElement;
  /** 画布朝向：开录时的设备朝向（不带边框时帧按它摆） */
  orientation: Quarter;
  skin: LoadedSkin | null;
  track?: CanvasCaptureMediaStreamTrack;
  recorder?: MediaRecorder;
  frames: number;
  lastPaintAt: number;
  keepAlive: number;
  /** 保活像素这一回是加还是减 */
  nudgeUp: boolean;
  /** 分块按序交出 */
  chunks: Promise<void>;
}

type Prepare = Extract<CaptureCommand, { type: 'prepare' }>;
type Roll = Extract<CaptureCommand, { type: 'roll' }>;
type Stop = Extract<CaptureCommand, { type: 'stop' }>;
type Still = Extract<CaptureCommand, { type: 'still' }>;

/** 画面静止时模拟器不推帧：隔这么久没新帧就补一帧，把时间轴续到当下 */
const KEEP_ALIVE_MS = 200;

let bridge: CaptureBridge;
const sessions = new Map<string, Session>();

// 不给 Blob 标类型：皮肤图有 webp 也有 png，交给解码器按字节认
const decode = (data: ArrayBuffer): Promise<ImageBitmap> =>
  createImageBitmap(new Blob([data]));

function releaseSkin(skin: LoadedSkin | null): void {
  if (!skin) return;
  for (const placed of [...skin.backgrounds, ...skin.onions])
    placed.bitmap.close();
  skin.mask?.close();
}

function dispose(s: Session): void {
  window.clearInterval(s.keepAlive);
  releaseSkin(s.skin);
  s.canvas.remove();
  sessions.delete(s.id);
}

async function loadSkin(
  skin: FrameSkin,
  canvas: { width: number; height: number },
): Promise<LoadedSkin> {
  const place = async (
    items: { x: number; y: number; data: ArrayBuffer }[],
  ): Promise<Placed[]> =>
    Promise.all(
      items.map(async (item) => ({
        x: item.x,
        y: item.y,
        bitmap: await decode(item.data),
      })),
    );
  const [backgrounds, mask, onions] = await Promise.all([
    place(skin.backgrounds),
    skin.mask ? decode(skin.mask) : undefined,
    place(skin.onions),
  ]);
  return {
    screen: skin.screen,
    screenRotation: skin.screenRotation,
    plane: imageTransform(skin.canvasRotation, skin.width, skin.height, {
      x: 0,
      y: 0,
      w: canvas.width,
      h: canvas.height,
    }),
    backgrounds,
    mask,
    onions,
  };
}

/** 按尺寸重设落脚画布并返回它的 2D 上下文 */
function fitStaging(
  staging: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D {
  if (staging.width !== width || staging.height !== height) {
    staging.width = width;
    staging.height = height;
  }
  return staging.getContext('2d')!;
}

/** 把落在 staging 上的一帧画进画布并交给编码器。rotation 是这一帧自己的朝向 */
function paint(
  s: Session,
  width: number,
  height: number,
  rotation: Quarter,
): void {
  const { ctx, staging, skin } = s;
  if (!skin) {
    const whole = { x: 0, y: 0, w: s.canvas.width, h: s.canvas.height };
    ctx.setTransform(
      ...imageTransform(
        frameAngle(rotation, s.orientation),
        width,
        height,
        whole,
      ),
    );
    ctx.drawImage(staging, 0, 0);
  } else {
    const { plane, screen } = skin;
    ctx.setTransform(
      ...compose(
        plane,
        imageTransform(
          frameAngle(rotation, skin.screenRotation),
          width,
          height,
          screen,
        ),
      ),
    );
    ctx.drawImage(staging, 0, 0);
    // 遮罩盖在画面上：圆角与前摄开孔处的机身色来自它
    if (skin.mask) {
      ctx.setTransform(
        ...compose(
          plane,
          imageTransform(
            frameAngle(0, skin.screenRotation),
            skin.mask.width,
            skin.mask.height,
            screen,
          ),
        ),
      );
      ctx.drawImage(skin.mask, 0, 0);
    }
    ctx.setTransform(...plane);
    for (const onion of skin.onions)
      ctx.drawImage(onion.bitmap, onion.x, onion.y);
  }
  s.frames++;
  s.lastPaintAt = performance.now();
  s.track?.requestFrame();
}

async function prepare(cmd: Prepare): Promise<PrepareReply> {
  const container = pickContainer((mimeType) =>
    MediaRecorder.isTypeSupported(mimeType),
  );
  if (!container) throw new Error('当前系统没有可用的视频编码器');
  const canvas = document.createElement('canvas');
  const size = canvasSize(cmd, cmd.skin);
  canvas.width = size.width;
  canvas.height = size.height;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('无法创建录屏画布');
  // 边框外恒为黑：机身图在屏幕处是透明的，不铺底会露出上一帧
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const skin = cmd.skin ? await loadSkin(cmd.skin, canvas) : null;
  if (skin) {
    ctx.setTransform(...skin.plane);
    for (const bg of skin.backgrounds) ctx.drawImage(bg.bitmap, bg.x, bg.y);
  }
  sessions.set(cmd.id, {
    id: cmd.id,
    mimeType: container.mimeType,
    canvas,
    ctx,
    staging: document.createElement('canvas'),
    orientation: cmd.rotation,
    skin,
    frames: 0,
    lastPaintAt: 0,
    keepAlive: 0,
    nudgeUp: false,
    chunks: Promise.resolve(),
  });
  return { mimeType: container.mimeType, extension: container.extension };
}

/** 画面静止时模拟器不推帧，而画布没变时编码器不出帧：录屏若在静止中结束，
 *  结尾这段会被截掉。所以保活不能只重发上一帧，得让画布真的变——
 *  只翻动画布最后一个像素的最低位，加减交替不至于漂移，肉眼不可见 */
function nudge(s: Session): void {
  const { ctx } = s;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  s.nudgeUp = !s.nudgeUp;
  ctx.fillStyle = s.nudgeUp
    ? 'rgba(255,255,255,0.004)'
    : 'rgba(0,0,0,0.004)';
  ctx.fillRect(s.canvas.width - 1, s.canvas.height - 1, 1, 1);
  s.track?.requestFrame();
}

async function roll(cmd: Roll): Promise<void> {
  const s = sessions.get(cmd.id);
  if (!s) throw new Error('录屏会话不存在');
  // 首帧就是探测用的那张：朝向与开录时一致
  const bitmap = await decode(cmd.png);
  const { width, height } = bitmap;
  fitStaging(s.staging, width, height).drawImage(bitmap, 0, 0);
  bitmap.close();
  const stream = s.canvas.captureStream(0);
  s.track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const recorder = new MediaRecorder(stream, {
    mimeType: s.mimeType,
    videoBitsPerSecond: videoBitrate(s.canvas.width, s.canvas.height),
  });
  s.recorder = recorder;
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    s.chunks = s.chunks
      .then(() => e.data.arrayBuffer())
      .then((data) => bridge.send({ type: 'chunk', id: s.id, data }))
      .catch(() => undefined);
  };
  recorder.onerror = () =>
    bridge.send({ type: 'failed', id: s.id, error: '视频编码器出错' });
  recorder.start(1000);
  paint(s, width, height, s.orientation);
  s.keepAlive = window.setInterval(() => {
    if (performance.now() - s.lastPaintAt >= KEEP_ALIVE_MS) nudge(s);
  }, KEEP_ALIVE_MS / 2);
}

async function stop(cmd: Stop): Promise<StopReply> {
  const s = sessions.get(cmd.id);
  if (!s?.recorder) throw new Error('录屏会话不存在');
  window.clearInterval(s.keepAlive);
  const recorder = s.recorder;
  // 收尾前补一帧：最后一帧的时长延到停止那一刻，而不是停在上一次保活
  nudge(s);
  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
    if (recorder.state === 'inactive') resolve();
    else recorder.stop();
  });
  await s.chunks;
  const frames = s.frames;
  dispose(s);
  return { frames };
}

function abort(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  // 文件不会保留：停编码器只为释放资源，不再收分块
  if (s.recorder) {
    s.recorder.ondataavailable = null;
    s.recorder.onerror = null;
    if (s.recorder.state !== 'inactive') s.recorder.stop();
  }
  dispose(s);
}

/** 截图贴上边框，返回 PNG。截图是 guest 原生朝向的画面（朝向 0） */
async function still(cmd: Still): Promise<ArrayBuffer> {
  const out = document.createElement('canvas');
  out.width = cmd.skin.width;
  out.height = cmd.skin.height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('无法创建截图画布');
  const skin = await loadSkin(cmd.skin, out);
  const bitmap = await decode(cmd.png);
  try {
    const { screen, screenRotation } = skin;
    for (const bg of skin.backgrounds) ctx.drawImage(bg.bitmap, bg.x, bg.y);
    ctx.setTransform(
      ...imageTransform(
        frameAngle(0, screenRotation),
        bitmap.width,
        bitmap.height,
        screen,
      ),
    );
    ctx.drawImage(bitmap, 0, 0);
    if (skin.mask) {
      ctx.setTransform(
        ...imageTransform(
          frameAngle(0, screenRotation),
          skin.mask.width,
          skin.mask.height,
          screen,
        ),
      );
      ctx.drawImage(skin.mask, 0, 0);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const onion of skin.onions)
      ctx.drawImage(onion.bitmap, onion.x, onion.y);
  } finally {
    bitmap.close();
    releaseSkin(skin);
  }
  const blob = await new Promise<Blob>((resolve, reject) =>
    out.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('截图编码失败'))),
      'image/png',
    ),
  );
  return blob.arrayBuffer();
}

/** 挂载录屏工作窗（入口在 hash 以 #capture 开头时调用） */
export function renderCapturePage(): void {
  const found = (window as unknown as { devemuCapture?: CaptureBridge })
    .devemuCapture;
  if (!found) return;
  bridge = found;
  bridge.onCommand((cmd) => {
    if (cmd.type === 'abort') return abort(cmd.id);
    const run =
      cmd.type === 'prepare'
        ? prepare(cmd)
        : cmd.type === 'roll'
          ? roll(cmd)
          : cmd.type === 'stop'
            ? stop(cmd)
            : still(cmd);
    void run.then(
      (data) =>
        bridge.send({
          type: 'reply',
          requestId: cmd.requestId,
          ok: true,
          data,
        }),
      (err) =>
        bridge.send({
          type: 'reply',
          requestId: cmd.requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
    );
  });

  bridge.onFrame((notice, pixels) => {
    const s = sessions.get(notice.id);
    // 共享文件读不到（流刚结束、连续撞上写方）：跳过这一帧，保活会补
    if (
      !s?.recorder ||
      !pixels ||
      pixels.byteLength !== notice.width * notice.height * 4
    )
      return;
    fitStaging(s.staging, notice.width, notice.height).putImageData(
      new ImageData(new Uint8ClampedArray(pixels), notice.width, notice.height),
      0,
      0,
    );
    paint(s, notice.width, notice.height, notice.rotation);
  });
}
