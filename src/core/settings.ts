import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Settings } from './types.ts';

export const DEFAULT_DATA_ROOT = path.join(os.homedir(), 'DevEmu');

export function settingsPath(dataRoot: string): string {
  return path.join(dataRoot, 'settings.json');
}

/**
 * settings.json 固定存放在 DEFAULT_DATA_ROOT（dataRoot 字段只是指向数据目录），
 * 否则修改 dataRoot 后主配置会"漂移"到新目录导致不生效
 */
export function loadAppSettings(): Settings {
  return loadSettings(DEFAULT_DATA_ROOT);
}

export function saveAppSettings(settings: Settings): void {
  ensureDataDirs(settings.dataRoot);
  const file = settingsPath(DEFAULT_DATA_ROOT);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function loadSettings(dataRoot: string): Settings {
  try {
    const raw = fs.readFileSync(settingsPath(dataRoot), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    if (typeof parsed.dataRoot !== 'string' || !parsed.dataRoot)
      throw new Error('bad');
    return {
      dataRoot: parsed.dataRoot,
      sdkPath: parsed.sdkPath,
      javaPath: parsed.javaPath,
      harmonySdkPath: parsed.harmonySdkPath,
      // 旧 UI 默认值 swiftshader_indirect 被随保存写入，在 API 35+ 预览镜像上整屏全黑
      // （2026-10 实测 guest/窗口 0% 点亮）：未标记迁移过的存量值一次性迁到 angle_indirect。
      // 标记随任一次设置保存落盘，此后用户手动选回的软件渲染不再被迁移。
      gpuMode:
        !parsed.gpuSwiftshaderMigrated && parsed.gpuMode === 'swiftshader_indirect'
          ? 'angle_indirect'
          : parsed.gpuMode,
      gpuSwiftshaderMigrated: parsed.gpuSwiftshaderMigrated,
      cameraMode: parsed.cameraMode,
      webcam: parsed.webcam,
      pillEnabled: parsed.pillEnabled,
      proxyEnabled: parsed.proxyEnabled,
      proxyPort: parsed.proxyPort,
      // 旧版单一 downloadRoute 迁移为 Android 线路
      androidDownloadRoute:
        parsed.androidDownloadRoute ??
        (parsed as Partial<Settings> & { downloadRoute?: 'direct' | 'proxy' })
          .downloadRoute,
      harmonyDownloadRoute: parsed.harmonyDownloadRoute,
      maxDownloadKbps: parsed.maxDownloadKbps,
      parallelDownloads: parsed.parallelDownloads,
      autoCheckUpdate: parsed.autoCheckUpdate,
      agentEnabled: parsed.agentEnabled,
      agentPort: parsed.agentPort,
      agentToken: parsed.agentToken,
    };
  } catch {
    return { dataRoot };
  }
}

export function saveSettings(settings: Settings): void {
  ensureDataDirs(settings.dataRoot);
  const file = settingsPath(settings.dataRoot);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function ensureDataDirs(dataRoot: string): void {
  for (const dir of [
    dataRoot,
    path.join(dataRoot, 'projects'),
    path.join(dataRoot, 'devices', 'avd'),
    path.join(dataRoot, 'devices', 'apps'),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 随数据根一起迁移的已知数据项（settings.json 固定在默认数据目录，不随迁） */
const MIGRATE_ITEMS = [
  'projects',
  path.join('devices', 'avd'),
  path.join('devices', 'apps'),
  path.join('devices', 'runs'),
  'agent',
  'logs',
  'location',
  'camera',
  'screenshots',
  'downloads.json',
];

function samePath(a: string, b: string): boolean {
  return path.relative(path.resolve(a), path.resolve(b)) === '';
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 把 src 移到 dest：目标已存在时递归合并，同名冲突以迁移源为准
 * （迁移的是当前生效数据，旧目标里缺失的项才从源补齐）
 */
function moveInto(src: string, dest: string): void {
  const srcStat = fs.statSync(src);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (srcStat.isDirectory()) {
    let destStat: fs.Stats | undefined;
    try {
      destStat = fs.statSync(dest);
    } catch {
      // 目标不存在
    }
    if (destStat && !destStat.isDirectory()) {
      // 同名文件挡路：以迁移源目录为准
      fs.rmSync(dest, { force: true, maxRetries: 10, retryDelay: 500 });
      destStat = undefined;
    }
    if (!destStat) {
      try {
        fs.renameSync(src, dest);
        return;
      } catch {
        // 跨卷 rename（EXDEV）或目标目录已存在：退回逐项合并
      }
    }
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src))
      moveInto(path.join(src, entry), path.join(dest, entry));
    fs.rmSync(src, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 500,
    });
    return;
  }
  // 同名目录挡路时以迁移源文件为准（文件 rename 不到目录上）
  try {
    if (fs.statSync(dest).isDirectory())
      fs.rmSync(dest, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 500,
      });
  } catch {
    // 目标不存在，直接 rename
  }
  try {
    fs.renameSync(src, dest);
    return;
  } catch {
    // 跨卷（EXDEV）：复制后删源
  }
  fs.copyFileSync(src, dest);
  fs.rmSync(src, { force: true, maxRetries: 10, retryDelay: 500 });
}

export interface DataRootMigration {
  /** 已迁走的项（相对数据根的路径） */
  moved: string[];
  /** 未能迁走的项（源被占用等）；非空时调用方应放弃切换数据根 */
  failed: string[];
  /** 改写指向旧数据根的 AVD ini 数量 */
  iniFixed: number;
}

/**
 * .ini 里的 path= 是创建虚拟机时数据根的绝对路径（avdmanager 不写 path.rel），
 * 跨根迁移后必须改指新根，否则模拟器按旧盘符找不到磁盘。
 * 只改前缀仍指向旧根的行；.avd 内的 config.ini 只含 SDK 相对路径，无需处理。
 */
function rewriteAvdIniPaths(newRoot: string, oldRoot: string): number {
  const homes = [path.join(newRoot, 'devices', 'avd')];
  let projects: string[] = [];
  try {
    projects = fs.readdirSync(path.join(newRoot, 'projects'));
  } catch {
    // 无项目目录
  }
  for (const p of projects)
    homes.push(path.join(newRoot, 'projects', p, 'avd'));
  let fixed = 0;
  for (const home of homes) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(home);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.ini')) continue;
      const file = path.join(home, entry);
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      let changed = false;
      const next = lines.map((line) => {
        if (!/^path=/i.test(line.trim())) return line;
        const value = line.slice(line.indexOf('=') + 1).trim();
        if (!isInside(oldRoot, value) || samePath(oldRoot, value)) return line;
        changed = true;
        return `${line.slice(0, line.indexOf('=') + 1)}${path.join(newRoot, path.relative(oldRoot, value))}`;
      });
      if (!changed) continue;
      try {
        const eol = /\r\n/.test(text) ? '\r\n' : '\n';
        fs.writeFileSync(file, next.join(eol), 'utf8');
        fixed++;
      } catch {
        // ini 改写失败不阻塞迁移主体
      }
    }
  }
  return fixed;
}

/**
 * 把旧数据根下的全部已知数据迁到新数据根对应子路径，迁完清掉搬空的空壳目录。
 * 旧根里还有别的内容（settings.json、用户自放文件）时旧根本身删不掉，自然保留。
 */
export function migrateDataRoot(
  oldRoot: string,
  newRoot: string,
): DataRootMigration {
  const result: DataRootMigration = { moved: [], failed: [], iniFixed: 0 };
  const from = path.resolve(oldRoot);
  const to = path.resolve(newRoot);
  if (samePath(from, to)) return result;
  for (const rel of MIGRATE_ITEMS) {
    const src = path.join(from, rel);
    const dest = path.join(to, rel);
    // 新数据根落在某一项内部时该项不能动（目录移不进自己的子树）
    if (isInside(src, dest)) continue;
    try {
      fs.statSync(src);
    } catch {
      continue;
    }
    try {
      moveInto(src, dest);
      result.moved.push(rel);
    } catch {
      result.failed.push(rel);
    }
  }
  // 有部分项失败也不跳过改写：已迁走的 ini 同样要指到新根
  result.iniFixed = rewriteAvdIniPaths(to, from);
  // rmdir 只删得动空目录：非空即仍有残留，交由调用方按 failed 处理或保留
  try {
    fs.rmdirSync(path.join(from, 'devices'));
  } catch {
    // 非空或不存在
  }
  try {
    fs.rmdirSync(from);
  } catch {
    // 非空或不存在
  }
  return result;
}
