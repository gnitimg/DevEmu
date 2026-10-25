import fs from 'node:fs';
import path from 'node:path';
import type { RunRecord } from './types.ts';

function runId(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function recordRun(
  runsDir: string,
  data: Omit<RunRecord, 'id' | 'at'>,
  extras?: { screenshot?: Buffer; logcat?: string },
): RunRecord {
  fs.mkdirSync(runsDir, { recursive: true });
  const id = runId();
  const dir = path.join(runsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const record: RunRecord = { ...data, id, at: new Date().toISOString() };
  if (extras?.screenshot) {
    fs.writeFileSync(path.join(dir, 'screenshot.png'), extras.screenshot);
    record.screenshot = 'screenshot.png';
  }
  if (extras?.logcat) {
    fs.writeFileSync(path.join(dir, 'logcat.txt'), extras.logcat, 'utf8');
    record.logcat = 'logcat.txt';
  }
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

export function listRuns(runsDir: string): RunRecord[] {
  try {
    return fs
      .readdirSync(runsDir)
      .filter((f) => /^\d{8}-\d{6}$/.test(f))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(runsDir, f, 'result.json'), 'utf8')) as RunRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is RunRecord => r !== null)
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

export function runDir(runsDir: string, id: string): string {
  return path.join(runsDir, id);
}
