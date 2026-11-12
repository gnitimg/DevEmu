import fs from 'node:fs';
import path from 'node:path';
import type { CrashRecord } from './types.ts';

function crashId(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  // 同一秒的多条崩溃（如连环崩溃）不能互相覆盖
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-${date.getMilliseconds().toString(36).padStart(3, '0')}${Math.random().toString(36).slice(2, 5)}`;
}

export function recordCrash(
  crashesDir: string,
  data: Omit<CrashRecord, 'id'>,
  log?: string,
): CrashRecord {
  fs.mkdirSync(crashesDir, { recursive: true });
  const id = crashId();
  const dir = path.join(crashesDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const record: CrashRecord = { ...data, id };
  if (log !== undefined) {
    fs.writeFileSync(path.join(dir, 'crash.log'), log, 'utf8');
    record.log = 'crash.log';
  }
  fs.writeFileSync(path.join(dir, 'crash.json'), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

export function listCrashes(crashesDir: string): CrashRecord[] {
  try {
    return fs
      .readdirSync(crashesDir)
      .filter((f) => /^\d{8}-\d{6}-[\w]{3,}$/.test(f))
      .map((f) => {
        try {
          return JSON.parse(
            fs.readFileSync(path.join(crashesDir, f, 'crash.json'), 'utf8'),
          ) as CrashRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is CrashRecord => r !== null)
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

/** HOS 故障日志按文件名去重：应用重启后再次轮询到同一文件不能重复入库 */
export function hasCrashKey(crashesDir: string, key: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(crashesDir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    try {
      const rec = JSON.parse(
        fs.readFileSync(path.join(crashesDir, entry, 'crash.json'), 'utf8'),
      ) as CrashRecord;
      if (rec.key === key) return true;
    } catch {
      // 非记录目录/半写文件：跳过
    }
  }
  return false;
}

export function readCrashLog(crashesDir: string, id: string): string {
  if (!/^[\w-]{1,64}$/.test(id)) return '';
  try {
    return fs.readFileSync(path.join(crashesDir, id, 'crash.log'), 'utf8');
  } catch {
    return '';
  }
}
