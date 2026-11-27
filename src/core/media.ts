import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from './types.ts';

export interface CaptureDirs {
  imgs: string;
  videos: string;
}

type MediaSettings = Pick<Settings, 'dataRoot' | 'mediaDir'>;

/** 截图与录屏的根目录：未设置时落在数据根下的 media */
export function mediaRoot(settings: MediaSettings): string {
  const custom = settings.mediaDir?.trim();
  return custom ? path.resolve(custom) : path.join(settings.dataRoot, 'media');
}

export function captureDirs(settings: MediaSettings): CaptureDirs {
  const root = mediaRoot(settings);
  return { imgs: path.join(root, 'imgs'), videos: path.join(root, 'videos') };
}

/** 文件名里的时间戳，与既有截图同款（ISO，冒号与点换成短横线） */
export function captureStamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** 建好目录并返回；缺省位置首次使用时把旧版的 screenshots 并入 imgs */
export function ensureCaptureDir(
  settings: MediaSettings,
  kind: keyof CaptureDirs,
): string {
  const dir = captureDirs(settings)[kind];
  if (kind === 'imgs' && !settings.mediaDir?.trim())
    adoptLegacyShots(settings.dataRoot, dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** v1.2 及之前的截图落在 <数据根>\screenshots：imgs 尚不存在时整目录改名并入。
 *  改不成（HarmonyOS 模拟器占着目录句柄等）保持原样，下次再试。 */
function adoptLegacyShots(dataRoot: string, imgs: string): void {
  const legacy = path.join(dataRoot, 'screenshots');
  let legacyIsDir = false;
  try {
    legacyIsDir = fs.statSync(legacy).isDirectory();
  } catch {
    return;
  }
  if (!legacyIsDir || fs.existsSync(imgs)) return;
  try {
    fs.mkdirSync(path.dirname(imgs), { recursive: true });
    fs.renameSync(legacy, imgs);
  } catch {
    // 被占用或跨卷：留在原处
  }
}
