import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Settings } from './types.ts';
import { appendLog } from './log.ts';

/** v1.1.x 及此前版本的数据根与引导配置位置，升级时用于发现既有数据 */
export const LEGACY_DATA_ROOT = path.join(os.homedir(), 'DevEmu');

/**
 * 打包版的数据引导目录：安装目录下的 .data（默认数据根与 settings.json 都在这里，
 * NSIS 安装包允许用户自选安装目录，数据跟着装到所选盘）；dev（electron.exe）与
 * node 测试进程没有安装目录概念，沿用主目录传统位置，本地调试数据不迁移
 */
export function defaultDataRoot(): string {
  if (/^(electron|node)(\.exe)?$/i.test(path.basename(process.execPath))) return LEGACY_DATA_ROOT;
  return path.join(path.dirname(process.execPath), '.data');
}

export function settingsPath(dataRoot: string): string {
  return path.join(dataRoot, 'settings.json');
}

/**
 * settings.json 固定存放在 defaultDataRoot()（dataRoot 字段只是指向数据目录），
 * 否则修改 dataRoot 后主配置会"漂移"到新目录导致不生效。
 * 从 v1.1.x 升级上来时首次读取会把 ~/DevEmu 的引导配置复制进 .data：
 * dataRoot 保持指向既有数据目录（虚拟机不搬家），用户可在设置里再切换。
 */
export function loadAppSettings(): Settings {
  const root = defaultDataRoot();
  if (root !== LEGACY_DATA_ROOT && !fs.existsSync(settingsPath(root))) {
    const legacy = settingsPath(LEGACY_DATA_ROOT);
    if (fs.existsSync(legacy)) {
      try {
        fs.mkdirSync(root, { recursive: true });
        fs.copyFileSync(legacy, settingsPath(root));
      } catch {
        // 引导配置迁移失败按全新安装处理，不影响启动
      }
    }
  }
  return loadSettings(root);
}

/** 首次启动判定：引导配置不存在即首次安装（旧版升级在读取前已完成引导配置迁移） */
export function isBootstrapFresh(): boolean {
  return !fs.existsSync(settingsPath(defaultDataRoot()));
}

export function saveAppSettings(settings: Settings): void {
  ensureDataDirs(settings.dataRoot);
  const file = settingsPath(defaultDataRoot());
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// settings.json 读取缓存：emu:list 等轮询热路径每轮要 loadAppSettings 多次，
// readFileSync+JSON.parse 每次都是重复 IO。按 mtime 失效（保存写入与外部手改
// 都会变 mtime），命中返回浅拷贝——Settings 全为标量字段，浅拷贝即调用方隔离
const settingsCache = new Map<string, { mtimeMs: number; settings: Settings }>();

export function loadSettings(dataRoot: string): Settings {
  const file = settingsPath(dataRoot);
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  const hit = settingsCache.get(dataRoot);
  if (hit && mtimeMs !== -1 && hit.mtimeMs === mtimeMs) return { ...hit.settings };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    if (typeof parsed.dataRoot !== 'string' || !parsed.dataRoot)
      throw new Error('bad');
    const settings: Settings = {
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
    settingsCache.set(dataRoot, { mtimeMs, settings });
    return { ...settings };
  } catch (e) {
    // 全新安装尚未保存过设置是正常态，不能当损坏报
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      // 缓存"缺失"态（mtime -1 哨兵），文件落盘出现即自然失效
      settingsCache.set(dataRoot, { mtimeMs: -1, settings: { dataRoot } });
      return { dataRoot };
    }
    // JSON 损坏时自定义数据根会"丢失"（数据仍在盘上）：改名留证并记日志
    settingsCache.delete(dataRoot);
    try {
      fs.renameSync(file, `${file}.corrupt.bak`);
    } catch {
      // 已被删或不可写
    }
    appendLog(
      dataRoot,
      `settings.json 解析失败（${e instanceof Error ? e.message : String(e)}），已按默认设置启动，原文件保留为 settings.json.corrupt.bak`,
    );
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
  path.join('devices', 'crashes'),
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

export interface DataRootConflicts {
  /** 新根落在旧根子树内（信息位：仅当同时落入随迁项内部才是硬冲突） */
  nested: boolean;
  /** 新根落在随迁数据项（projects/devices 等）内部：迁移会静默跳过该项导致数据分裂，必须拒绝 */
  blocked: boolean;
  /** 改写指向旧数据根的 AVD ini 数量 */
  projects: DataRootConflict[];
}

export interface DataRootConflict {
  id: string;
  name: string;
}

/**
 * 迁移前置检查：随迁项内部不能作为新根（否则该项会搬进自己的子树被静默跳过，
 * 切换后数据分裂）；目标里已存在同 ID 项目时迁移会覆盖，需要先告知用户。
 * 新根是旧根的直接子目录（如升级到 <旧根>\.data 新版式）且不在随迁项内时允许。
 */
export function dataRootConflicts(
  oldRoot: string,
  newRoot: string,
): DataRootConflicts {
  const from = path.resolve(oldRoot);
  const to = path.resolve(newRoot);
  const nested = isInside(from, to) && !samePath(from, to);
  const blocked =
    nested &&
    MIGRATE_ITEMS.some((rel) => {
      const itemDir = path.join(from, rel);
      return isInside(itemDir, to) && !samePath(itemDir, to);
    });
  const projects: DataRootConflict[] = [];
  if (nested || samePath(from, to)) return { nested, blocked, projects };
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(path.join(from, 'projects'));
  } catch {
    return { nested, blocked, projects };
  }
  for (const id of ids) {
    const file = path.join(to, 'projects', id, 'project.json');
    if (!fs.existsSync(file)) continue;
    let name = id;
    try {
      const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        name?: unknown;
      };
      if (typeof meta.name === 'string' && meta.name.trim()) name = meta.name;
    } catch {
      // 目标里同 ID 目录不是完整项目：仍按 ID 提示覆盖风险
    }
    projects.push({ id, name });
  }
  return { nested, blocked, projects };
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
 * wipe：迁入前抹掉目标中同名数据项（"保留"模式覆盖目标旧数据）；
 * 缺省为合并语义（同名以源为准递归归并，目标独有内容保留）。
 * onProgress：每处理完一项回调（含失败项），供迁移进度圆环展示。
 */
export function migrateDataRoot(
  oldRoot: string,
  newRoot: string,
  options: { wipe?: boolean; onProgress?: (done: number, total: number) => void } = {},
): DataRootMigration {
  const result: DataRootMigration = { moved: [], failed: [], iniFixed: 0 };
  const from = path.resolve(oldRoot);
  const to = path.resolve(newRoot);
  if (samePath(from, to)) return result;
  let processed = 0;
  for (const rel of MIGRATE_ITEMS) {
    const src = path.join(from, rel);
    const dest = path.join(to, rel);
    // 新数据根落在某一项内部时该项不能动（目录移不进自己的子树）
    if (isInside(src, dest)) continue;
    const exists = (() => {
      try {
        fs.statSync(src);
        return true;
      } catch {
        return false;
      }
    })();
    if (exists && options.wipe) {
      try {
        fs.rmSync(dest, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      } catch {
        // 抹不掉按合并语义兜底（同名以源为准）
      }
    }
    if (exists) {
      try {
        moveInto(src, dest);
        result.moved.push(rel);
      } catch {
        result.failed.push(rel);
      }
    }
    processed += 1;
    options.onProgress?.(processed, MIGRATE_ITEMS.length);
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

/**
 * 迁移半途失败时把已到新根的数据并回旧根：failed 项也可能是半迁移态
 * （moveInto 递归子项抛错时部分子内容已落新根），所以按"新根存在即并回"
 * 处理而非只看 moved。并回沿用 moveInto 的合并语义：极少数同名冲突以新根
 * 副本为准——保数据不保位置。返回仍卡在新根、无法搬回的项。
 */
export function rollbackMigration(
  migration: DataRootMigration,
  oldRoot: string,
  newRoot: string,
): string[] {
  const stuck: string[] = [];
  const from = path.resolve(newRoot);
  const to = path.resolve(oldRoot);
  for (const rel of [...migration.moved, ...migration.failed].reverse()) {
    const src = path.join(from, rel);
    try {
      fs.statSync(src);
    } catch {
      continue;
    }
    try {
      moveInto(src, path.join(to, rel));
    } catch {
      stuck.push(rel);
    }
  }
  // ini 已被改指新根，数据搬回旧根后必须改回
  rewriteAvdIniPaths(to, from);
  return stuck;
}
