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
        fs.copyFileSync(legacy, settingsPath(root)); // sync-ok: KB 级引导配置，单文件
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
      mediaDir: parsed.mediaDir,
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
  // 截图与录屏（自定义了图像存储位置时该项不在数据根内，自然不随迁）
  'media',
  'screenshots',
  // 重定向后的 Android 系统镜像根（sdkImages.ts 建链到此处），换数据根必须随迁
  'sdk',
  'downloads.json',
];

function samePath(a: string, b: string): boolean {
  return path.relative(path.resolve(a), path.resolve(b)) === '';
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 递归统计目录字节数（元数据操作，用于迁移进度的总量与改名瞬时计入） */
function walkSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += walkSize(p);
    else if (e.isFile()) {
      try {
        total += fs.statSync(p).size;
      } catch {
        // 读不到大小的文件按 0 计
      }
    }
  }
  return total;
}

/** 流式复制单文件并逐块回报字节数（跨盘迁移的进度来源） */
async function copyFileProgress(
  src: string,
  dest: string,
  onBytes: (n: number) => void,
): Promise<void> {
  const rs = fs.createReadStream(src, { highWaterMark: 1 << 20 });
  const ws = fs.createWriteStream(dest);
  let wsErr: Error | undefined;
  ws.on('error', (e) => {
    wsErr = e;
  });
  const writeChunk = (b: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (wsErr) return reject(wsErr);
      if (ws.write(b)) return resolve();
      // drain 之外 error/close 也要唤醒：目标盘写满时等 drain 会永久挂起。
      // 三个监听互斥摘除，否则每个背压块都会在同一个流上累积 error/close 监听
      const settle = (err?: Error) => {
        ws.off('drain', onDrain);
        ws.off('error', onError);
        ws.off('close', onClose);
        const e = err ?? wsErr;
        if (e) reject(e);
        else resolve();
      };
      const onDrain = () => settle();
      const onError = (e: Error) => settle(e);
      const onClose = () => settle();
      ws.once('drain', onDrain);
      ws.once('error', onError);
      ws.once('close', onClose);
    });
  try {
    for await (const chunk of rs) {
      const buf = chunk as Buffer;
      await writeChunk(buf);
      onBytes(buf.length);
    }
    await new Promise<void>((resolve, reject) => {
      ws.once('finish', resolve);
      ws.once('error', reject);
      ws.end();
    });
  } catch (e) {
    rs.destroy();
    ws.destroy();
    throw e;
  }
}

/**
 * 把 src 移到 dest：目标已存在时递归合并，同名冲突以迁移源为准
 * （迁移的是当前生效数据，旧目标里缺失的项才从源补齐）。
 * 全程 fs.promises：大目录跨盘复制走线程池，不阻塞主进程事件循环
 * （迁移在 ipcMain handler 内执行，同步复制会把整窗卡成“未响应”）。
 * onBytes：本次移动实际落盘的字节数（改名瞬间计入整目录大小，复制逐块回报）。
 */
export async function moveInto(
  src: string,
  dest: string,
  onBytes?: (n: number) => void,
): Promise<void> {
  const srcStat = await fs.promises.stat(src);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  if (srcStat.isDirectory()) {
    let destStat: fs.Stats | undefined;
    try {
      destStat = await fs.promises.stat(dest);
    } catch {
      // 目标不存在
    }
    if (destStat && !destStat.isDirectory()) {
      // 同名文件挡路：以迁移源目录为准
      await fs.promises.rm(dest, { force: true, maxRetries: 10, retryDelay: 500 });
      destStat = undefined;
    }
    if (!destStat) {
      // 改名前先算大小：rename 后源已不在
      const size = walkSize(src);
      try {
        await fs.promises.rename(src, dest);
        onBytes?.(size);
        return;
      } catch {
        // 跨卷 rename（EXDEV）或目标目录已存在：退回逐项合并
      }
    }
    await fs.promises.mkdir(dest, { recursive: true });
    for (const entry of await fs.promises.readdir(src))
      await moveInto(path.join(src, entry), path.join(dest, entry), onBytes);
    await fs.promises.rm(src, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 500,
    });
    return;
  }
  // 同名目录挡路时以迁移源文件为准（文件 rename 不到目录上）
  try {
    if ((await fs.promises.stat(dest)).isDirectory())
      await fs.promises.rm(dest, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 500,
      });
  } catch {
    // 目标不存在，直接 rename
  }
  if (srcStat.size <= 64 * 1024 * 1024) {
    // 同卷改名是元数据操作；小文件跨卷复制也是瞬时，按整体计入
    try {
      await fs.promises.rename(src, dest);
      onBytes?.(srcStat.size);
      return;
    } catch {
      // EXDEV：复制后删源
    }
    await fs.promises.copyFile(src, dest);
    onBytes?.(srcStat.size);
    await fs.promises.rm(src, { force: true, maxRetries: 10, retryDelay: 500 });
    return;
  }
  // 大文件跨卷：流式复制逐块回报进度
  await copyFileProgress(src, dest, (n) => onBytes?.(n));
  await fs.promises.rm(src, { force: true, maxRetries: 10, retryDelay: 500 });
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
 * onProgress：字节级迁移进度（已迁移/总大小），节流约 0.45s 一帧，首帧与末帧必发。
 * 异步执行：每项之间让出事件循环，跨盘复制走线程池，主进程全程可响应。
 */
export async function migrateDataRoot(
  oldRoot: string,
  newRoot: string,
  options: { wipe?: boolean; onProgress?: (bytes: number, total: number) => void } = {},
): Promise<DataRootMigration> {
  const result: DataRootMigration = { moved: [], failed: [], iniFixed: 0 };
  const from = path.resolve(oldRoot);
  const to = path.resolve(newRoot);
  if (samePath(from, to)) return result;
  // 预计算总量（元数据遍历），给圆环一个稳定的分母
  const existing: string[] = [];
  let totalBytes = 0;
  for (const rel of MIGRATE_ITEMS) {
    const src = path.join(from, rel);
    // 新数据根落在某一项内部时该项不能动（目录移不进自己的子树）
    if (isInside(src, path.join(to, rel))) continue;
    if (
      await fs.promises
        .stat(src)
        .then(() => true, () => false)
    ) {
      existing.push(rel);
      totalBytes += walkSize(src);
    }
  }
  let movedBytes = 0;
  let lastEmit = 0;
  const emit = (force = false) => {
    const now = Date.now();
    if (force || now - lastEmit >= 450) {
      lastEmit = now;
      options.onProgress?.(movedBytes, totalBytes);
    }
  };
  options.onProgress?.(0, totalBytes);
  for (const rel of existing) {
    const src = path.join(from, rel);
    const dest = path.join(to, rel);
    if (options.wipe) {
      try {
        await fs.promises.rm(dest, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      } catch {
        // 抹不掉按合并语义兜底（同名以源为准）
      }
    }
    try {
      await moveInto(src, dest, (n) => {
        movedBytes += n;
        emit();
      });
      result.moved.push(rel);
    } catch {
      result.failed.push(rel);
    }
    // 每项完成强制发一帧，再让出一轮事件循环
    emit(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  emit(true);
  // 有部分项失败也不跳过改写：已迁走的 ini 同样要指到新根
  result.iniFixed = rewriteAvdIniPaths(to, from);

  // 源根清理（仅全部成功时执行；部分失败走调用方回滚，残局原样保留）：
  // 已迁走项的可丢弃残留——运行时状态（running-emulators.json 会重新生成）、
  // 旧引导配置（settings.json 仅当源根不是当前引导目录时才算残留）——删除后，
  // 源根无任何剩余内容即整目录删除；仍有未知内容（用户自放文件等）时保留，
  // 绝不误删
  if (result.failed.length === 0) {
    const movedSet = new Set(result.moved);
    const bootSelf = samePath(from, path.resolve(defaultDataRoot()));
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(from, { withFileTypes: true });
    } catch {
      return result;
    }
    for (const e of entries) {
      const disposable =
        movedSet.has(e.name) ||
        e.name === 'running-emulators.json' ||
        (e.name === 'settings.json' && !bootSelf);
      if (!disposable) continue;
      await fs.promises
        .rm(path.join(from, e.name), {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 300,
        })
        .catch(() => undefined);
    }
    // 空目录壳逐个移除（devices 三子项迁走后的外壳等）
    try {
      fs.rmdirSync(path.join(from, 'devices'));
    } catch {
      // 非空或不存在
    }
    try {
      fs.rmdirSync(from);
    } catch {
      // 仍有未知内容：源根保留
    }
  }
  return result;
}

/**
 * 并回（回滚）专用合并：旧根已有同名文件的一律保留原件、丢弃新根副本。
 * 迁移失败的中间态里，新根同名文件可能是写了一半的残缺副本（磁盘满/IO
 * 错误），moveInto 的 copyFile 覆盖语义会拿它盖掉旧根的完好原件。旧根
 * 缺失的条目（已改名迁走）才从新根搬回。
 */
async function mergeBack(src: string, dest: string): Promise<void> {
  const srcStat = await fs.promises.stat(src);
  if (!srcStat.isDirectory()) {
    let destExists = false;
    try {
      destExists = (await fs.promises.stat(dest)).isFile();
    } catch {
      // 旧根无此文件：整份搬回
    }
    if (destExists) {
      await fs.promises.rm(src, { force: true, maxRetries: 10, retryDelay: 500 });
      return;
    }
    try {
      await fs.promises.rename(src, dest);
    } catch {
      await fs.promises.copyFile(src, dest);
      await fs.promises.rm(src, { force: true, maxRetries: 10, retryDelay: 500 });
    }
    return;
  }
  await fs.promises.mkdir(dest, { recursive: true });
  for (const entry of await fs.promises.readdir(src))
    await mergeBack(path.join(src, entry), path.join(dest, entry));
  await fs.promises.rm(src, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 500,
  });
}

/**
 * 迁移半途失败时把已到新根的数据并回旧根：failed 项也可能是半迁移态
 * （moveInto 递归子项抛错时部分子内容已落新根），所以按"新根存在即并回"
 * 处理而非只看 moved。并回走 mergeBack：旧根仍存在的文件保留原件（失败项
 * 的新根副本可能是写一半的残缺文件），旧根缺失的才搬回。返回仍卡在新根、
 * 无法搬回的项。
 */
export async function rollbackMigration(
  migration: DataRootMigration,
  oldRoot: string,
  newRoot: string,
): Promise<string[]> {
  const stuck: string[] = [];
  const from = path.resolve(newRoot);
  const to = path.resolve(oldRoot);
  for (const rel of [...migration.moved, ...migration.failed].reverse()) {
    const src = path.join(from, rel);
    try {
      await fs.promises.stat(src);
    } catch {
      continue;
    }
    try {
      await mergeBack(src, path.join(to, rel));
    } catch {
      stuck.push(rel);
    }
  }
  // ini 已被改指新根，数据搬回旧根后必须改回
  rewriteAvdIniPaths(to, from);
  return stuck;
}
