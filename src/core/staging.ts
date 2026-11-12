import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ASCII 判定用 charCodeAt 遍历而非 /[\x00-\x7F]/ 正则：控制字符字面量会触发
// no-control-regex 规则，语义等价的正则绕不开它
const isAscii = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
};

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
  // 安装包可能几百 MB：同步复制会冻结主进程
  await fs.promises.copyFile(filePath, staged);
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
