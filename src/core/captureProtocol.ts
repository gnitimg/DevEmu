import type { Quarter, SkinRect } from './skin.ts';

/**
 * 录屏链路的主进程 ↔ 编码工作窗协议。工作窗是一个隐藏窗口：画面在它的画布上
 * 合成（贴边框），由 MediaRecorder 编码后分块交回主进程落盘。
 */

/** 一套边框素材：主进程读好字节，页面解码成位图 */
export interface FrameSkin {
  /** layout 尺寸 */
  width: number;
  height: number;
  /** 屏幕在 layout 内的矩形 */
  screen: SkinRect;
  /** layout 里屏幕部件自身的旋转 */
  screenRotation: Quarter;
  /** 整幅画面相对 layout 还需旋转的角度（画布坐标，正值顺时针） */
  canvasRotation: number;
  backgrounds: { x: number; y: number; data: ArrayBuffer }[];
  /** 屏幕前景遮罩 */
  mask?: ArrayBuffer;
  /** 最上层的整幅叠加图 */
  onions: { x: number; y: number; data: ArrayBuffer }[];
}

interface PrepareBody {
  type: 'prepare';
  id: string;
  /** 首帧尺寸与朝向，决定画布大小与方向 */
  width: number;
  height: number;
  rotation: Quarter;
  skin: FrameSkin | null;
}
interface RollBody {
  type: 'roll';
  id: string;
  png: ArrayBuffer;
}
interface StopBody {
  type: 'stop';
  id: string;
}
interface AbortBody {
  type: 'abort';
  id: string;
}
interface StillBody {
  type: 'still';
  png: ArrayBuffer;
  skin: FrameSkin;
}

/** 需要应答的命令；请求号由发送方补 */
export type CommandBody = PrepareBody | RollBody | StopBody | StillBody;

/** 主进程 → 工作窗 */
export type CaptureCommand = (CommandBody & { requestId: string }) | AbortBody;

/** 帧通知：像素在共享文件里，页面读到即该帧 */
export interface FrameNotice {
  id: string;
  width: number;
  height: number;
  rotation: Quarter;
  path: string;
  bytes: number;
}

/** 工作窗 → 主进程 */
export type CaptureEvent =
  | { type: 'reply'; requestId: string; ok: true; data: unknown }
  | { type: 'reply'; requestId: string; ok: false; error: string }
  | { type: 'chunk'; id: string; data: ArrayBuffer }
  | { type: 'failed'; id: string; error: string };

export interface PrepareReply {
  mimeType: string;
  extension: string;
}

export interface StopReply {
  /** 编码器实际吃进的帧数（含静止期补的保活帧） */
  frames: number;
}

/** 码率随分辨率走：约 0.16 bit/像素/帧 × 30 帧，夹在 4–20 Mbps */
export function videoBitrate(width: number, height: number): number {
  const bps = Math.round((width * height * 30 * 0.16) / 1e6) * 1e6;
  return Math.min(20e6, Math.max(4e6, bps));
}

/** 画布变换（setTransform 的 a b c d e f） */
export type Transform = [number, number, number, number, number, number];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 先应用 inner 再应用 outer */
export function compose(outer: Transform, inner: Transform): Transform {
  const [a1, b1, c1, d1, e1, f1] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/** 把 iw×ih 的画面顺时针转 angle 度后铺满 rect 所需的变换（画布坐标，正值顺时针）。
 *  直角的正余弦取整到 0/±1：否则 6e-17 的残差会让像素落非整点，重采样发虚。 */
export function imageTransform(
  angle: number,
  iw: number,
  ih: number,
  rect: Rect,
): Transform {
  const rad = (angle * Math.PI) / 180;
  const snap = (v: number) =>
    Math.abs(v) < 1e-9
      ? 0
      : Math.abs(v - 1) < 1e-9
        ? 1
        : Math.abs(v + 1) < 1e-9
          ? -1
          : v;
  const cos = snap(Math.cos(rad));
  const sin = snap(Math.sin(rad));
  const sideways = cos === 0;
  // 横竖各按目标矩形缩放：转了 90° 时画面的宽落到矩形的高上
  const sx = rect.w / (sideways ? ih : iw);
  const sy = rect.h / (sideways ? iw : ih);
  const a = sx * cos;
  const b = sy * sin;
  const c = -sx * sin;
  const d = sy * cos;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return [
    a,
    b,
    c,
    d,
    cx - (iw / 2) * a - (ih / 2) * c,
    cy - (iw / 2) * b - (ih / 2) * d,
  ];
}

/** 画面上的点 (u, v) 经变换后落在哪 */
export function applyTransform(
  t: Transform,
  u: number,
  v: number,
): [number, number] {
  return [t[0] * u + t[2] * v + t[4], t[1] * u + t[3] * v + t[5]];
}

/** 视频封装。MP4(H.264) 通用性最好；不支持时退 WebM */
export interface Container {
  mimeType: string;
  extension: string;
}

/** 录屏工作窗的角色标记：主进程经 additionalArguments 传入，preload 据此多暴露一层桥 */
export const CAPTURE_ROLE_ARG = '--devemu-role=capture';

const CONTAINERS: Container[] = [
  { mimeType: 'video/mp4;codecs=avc1.640028', extension: 'mp4' },
  { mimeType: 'video/mp4;codecs=avc1', extension: 'mp4' },
  { mimeType: 'video/webm;codecs=vp9', extension: 'webm' },
  { mimeType: 'video/webm;codecs=vp8', extension: 'webm' },
  { mimeType: 'video/webm', extension: 'webm' },
];

export function pickContainer(
  isSupported: (mimeType: string) => boolean,
): Container | undefined {
  return CONTAINERS.find((c) => isSupported(c.mimeType));
}

/** 画布尺寸。带边框时是 layout 尺寸（整幅转了 90° 则横竖互换）；
 *  不带边框时就是首帧的尺寸——它已经是开录时朝向下的画面。
 *  边长补成偶数：编码器普遍要求。 */
export function canvasSize(
  frame: { width: number; height: number },
  skin: { width: number; height: number; canvasRotation: number } | null,
): { width: number; height: number } {
  const [width, height] = skin
    ? Math.abs(skin.canvasRotation) === 90
      ? [skin.height, skin.width]
      : [skin.width, skin.height]
    : [frame.width, frame.height];
  return { width: width + (width % 2), height: height + (height % 2) };
}
