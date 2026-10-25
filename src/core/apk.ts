import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.ts';
import { stageAsciiPath, unstage } from './staging.ts';
import type { ApkMeta } from './types.ts';

export interface BadgingInfo {
  packageName: string;
  versionName?: string;
  versionCode?: string;
  label?: string;
  activity?: string;
}

/** 解析 aapt dump badging 首段 */
export function parseBadging(stdout: string): BadgingInfo | null {
  const pkg = stdout.match(/^package:\s+name='([^']+)'/m);
  if (!pkg) return null;
  const info: BadgingInfo = { packageName: pkg[1]! };
  const ver = stdout.match(/versionName='([^']*)'/);
  if (ver) info.versionName = ver[1];
  const code = stdout.match(/versionCode='([^']*)'/);
  if (code) info.versionCode = code[1];
  const label = stdout.match(/^application-label:\s*'(.*)'/m);
  if (label) info.label = label[1];
  const act = stdout.match(/^launchable-activity:\s+name='([^']+)'/m);
  if (act) info.activity = act[1];
  return info;
}

export function apkMetaPath(appsDir: string, id: string): string {
  return path.join(appsDir, `${id}.meta.json`);
}

export async function importApk(
  appsDir: string,
  srcPath: string,
  aapt?: string,
): Promise<ApkMeta> {
  fs.mkdirSync(appsDir, { recursive: true });
  const stat = fs.statSync(srcPath);
  const fileName = path.basename(srcPath);
  if (!/\.apk$/i.test(fileName)) throw new Error('只支持 .apk 文件');
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dest = path.join(appsDir, `${id}.apk`);
  fs.copyFileSync(srcPath, dest);

  let meta: ApkMeta = { id, fileName, size: stat.size, importedAt: new Date().toISOString() };
  if (aapt) {
    let staged = dest;
    try {
      staged = await stageAsciiPath(dest);
      const res = await run(aapt, ['dump', 'badging', staged], { timeoutMs: 30_000 });
      const info = parseBadging(res.stdout);
      if (info) {
        meta = {
          ...meta,
          packageName: info.packageName,
          versionName: info.versionName,
          label: info.label ?? fileName.replace(/\.apk$/i, ''),
          activity: info.activity,
        };
      }
    } catch {
      // aapt 失败不阻塞导入，仅缺元数据
    } finally {
      unstage(staged, dest);
    }
  }
  if (!meta.label) meta.label = fileName.replace(/\.apk$/i, '');
  fs.writeFileSync(apkMetaPath(appsDir, id), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

export function listApps(appsDir: string): ApkMeta[] {
  try {
    return fs
      .readdirSync(appsDir)
      .filter((f) => f.endsWith('.meta.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(appsDir, f), 'utf8')) as ApkMeta)
      .sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  } catch {
    return [];
  }
}

export function apkFilePath(appsDir: string, id: string): string {
  return path.join(appsDir, `${id}.apk`);
}

export function removeApp(appsDir: string, id: string): boolean {
  const metaFile = apkMetaPath(appsDir, id);
  let removed = false;
  for (const f of [metaFile, apkFilePath(appsDir, id), path.join(appsDir, `${id}.hap`)]) {
    try {
      fs.rmSync(f);
      removed = true;
    } catch {
      // 不存在就跳过
    }
  }
  return removed;
}
