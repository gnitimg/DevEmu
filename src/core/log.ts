import fs from 'node:fs';
import path from 'node:path';

/** 单个日志文件上限，超过后轮转为 app.old.log */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

export function logsDir(dataRoot: string): string {
  return path.join(dataRoot, 'logs');
}

export function logFile(dataRoot: string): string {
  return path.join(logsDir(dataRoot), 'app.log');
}

/** 追加一行运行日志；写失败静默（日志不能反过来影响功能） */
export function appendLog(dataRoot: string, line: string): void {
  try {
    const dir = logsDir(dataRoot);
    fs.mkdirSync(dir, { recursive: true });
    const file = logFile(dataRoot);
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) {
        fs.rmSync(path.join(dir, 'app.old.log'), { force: true });
        fs.renameSync(file, path.join(dir, 'app.old.log'));
      }
    } catch {
      // 首次写入时文件不存在，无需轮转
    }
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    // 忽略写入失败
  }
}

/** 删除 logs 目录下的全部 .log 文件，返回删除数量 */
export function clearLogs(dataRoot: string): number {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(logsDir(dataRoot));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.log')) continue;
    try {
      fs.rmSync(path.join(logsDir(dataRoot), entry), { force: true });
      removed++;
    } catch {
      // 单个文件删除失败不阻塞其余
    }
  }
  return removed;
}
