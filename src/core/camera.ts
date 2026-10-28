import fs from 'node:fs';
import path from 'node:path';
import type { CameraMode } from './types.ts';

/**
 * 相机注入：按设置把 Windows 摄像头或屏幕画面接到 Android 模拟器的相机上。
 * - webcam：emulator 原生 webcam 直通（webcam0/webcam1...，由 -webcam-list 枚举）。
 *   选 OBS 等虚拟摄像头并把源设为屏幕采集，即可获得真正实时的屏幕画面。
 * - screen：emulator 的 imagefile 相机源；馈送进程持续截屏，虚拟机内应用每次
 *   打开相机都会重新读文件，取到的即当时最新的屏幕画面（该源不随打开中的
 *   相机逐帧刷新；官方 videofile 源在当前构建会崩溃，无法做帧序列轮播）。
 */

export function screenFeedPath(dataRoot: string): string {
  return path.join(dataRoot, 'camera', 'screen.jpg');
}

/** 按相机来源生成 emulator 启动参数；emulated（缺省）不加参数 */
export function cameraArgs(
  mode: CameraMode | undefined,
  feedPath: string,
  webcamId = 'webcam0',
): string[] {
  if (mode === 'webcam')
    return ['-camera-front', webcamId, '-camera-back', webcamId];
  if (mode === 'screen') {
    const arg = `imagefile:${feedPath}`;
    return ['-camera-front', arg, '-camera-back', arg];
  }
  return [];
}

export interface WebcamInfo {
  id: string; // webcam0 / webcam1 ...
  label: string; // 设备名，如 'Integrated Camera'
}

/** 解析 `emulator -webcam-list` 输出中的摄像头行 */
export function parseWebcamList(stdout: string): WebcamInfo[] {
  const out: WebcamInfo[] = [];
  const re = /Camera '([^']+)' can be specified by label as '(webcam\d+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout))) out.push({ label: m[1]!, id: m[2]! });
  return out;
}

/** 枚举宿主摄像头；失败（SDK 缺失/无设备）返回空数组 */
export async function listWebcams(emulatorPath: string): Promise<WebcamInfo[]> {
  const { run } = await import('./exec.ts');
  const res = await run(emulatorPath, ['-webcam-list'], {
    timeoutMs: 20_000,
  }).catch(() => undefined);
  return res ? parseWebcamList(res.stdout) : [];
}

const FEED_INTERVAL_MS = 1000;
const FEED_WIDTH = 1280;
const FEED_HEIGHT = 720;

let feedTimer: NodeJS.Timeout | undefined;
let feedUsers = 0;
let feedFile = '';
let firstCapture: Promise<void> = Promise.resolve();

/** 抓主显示器一帧并原子写入画面文件；electron 只能在主进程动态引入（node --test 不会触达） */
async function captureFrame(file: string): Promise<void> {
  const { desktopCapturer, screen } = await import('electron');
  const primary = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: FEED_WIDTH, height: FEED_HEIGHT },
    fetchWindowIcons: false,
  });
  const src =
    sources.find((s) => s.display_id === String(primary.id)) ?? sources[0];
  if (!src || src.thumbnail.isEmpty()) return;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, src.thumbnail.toJPEG(80));
  fs.renameSync(tmp, file);
}

/** 引用计数启动屏幕馈送；返回启动参数应引用的画面文件路径 */
export function startScreenFeed(dataRoot: string): string {
  const file = screenFeedPath(dataRoot);
  feedUsers += 1;
  if (feedTimer) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  feedFile = file;
  firstCapture = captureFrame(file).catch(() => undefined);
  feedTimer = setInterval(() => {
    void captureFrame(feedFile).catch(() => undefined);
  }, FEED_INTERVAL_MS);
  return file;
}

/** 首帧写入完成（或失败）后 resolve；拉起模拟器前应等待，避免相机源读到空文件而回退 */
export function screenFeedReady(): Promise<void> {
  return firstCapture;
}

export function stopScreenFeed(): void {
  feedUsers = Math.max(0, feedUsers - 1);
  if (feedUsers > 0 || !feedTimer) return;
  clearInterval(feedTimer);
  feedTimer = undefined;
}
