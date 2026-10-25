import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isAscii = (s: string): boolean => /^[\x00-\x7F]*$/.test(s);

/**
 * aapt / adb 等原生工具无法打开含非 ASCII 字符（如中文项目名）的路径，
 * 这类文件先复制到纯 ASCII 的临时目录再交给它们
 */
export async function stageAsciiPath(filePath: string): Promise<string> {
  if (isAscii(filePath)) return filePath;
  const dir = path.join(os.tmpdir(), 'devemu-stage');
  fs.mkdirSync(dir, { recursive: true });
  const staged = path.join(
    dir,
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${path.extname(filePath)}`,
  );
  fs.copyFileSync(filePath, staged);
  return staged;
}

export function unstage(staged: string, original: string): void {
  if (staged !== original) {
    try {
      fs.rmSync(staged);
    } catch {
      // 清理失败不影响主流程
    }
  }
}
