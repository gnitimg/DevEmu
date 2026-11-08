import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.ts';
import { scopeDirs, scopeEnv } from './env.ts';
import { cmdlineTool } from './sdk.ts';
import type { AvdInfo, DeviceDef, Scope, SdkInfo } from './types.ts';

/** 解析 avdmanager list device 的 id/Name 对 */
export function parseDeviceList(stdout: string): DeviceDef[] {
  const defs: DeviceDef[] = [];
  let pendingId: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const idm = line.match(/^\s*id:\s*\d+\s+or\s+"([^"]+)"/);
    if (idm) {
      pendingId = idm[1]!;
      continue;
    }
    const nm = line.match(/^\s*Name:\s*(.+)$/);
    if (nm && pendingId) {
      defs.push({ id: pendingId, name: nm[1]!.trim() });
      pendingId = null;
    }
  }
  return defs;
}

/** 解析 AVD config.ini（key = value 行） */
export function parseConfigIni(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (m) map[m[1]!.trim()] = m[2]!.trim();
  }
  return map;
}

function imageDirToPkg(dir: string): string | undefined {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  // .../system-images/android-35/google_apis/x86_64
  const i = parts.lastIndexOf('system-images');
  if (i === -1 || parts.length - i < 4) return undefined;
  return `system-images;${parts[i + 1]};${parts[i + 2]};${parts[i + 3]}`;
}

/** 直接读 avdHome 目录（比 avdmanager 快得多）；顺带清理无 .ini 的残留目录 */
export function listAvds(dataRoot: string, scope: Scope): AvdInfo[] {
  const dirs = scopeDirs(dataRoot, scope);
  let entries: string[];
  try {
    entries = fs.readdirSync(dirs.avdHome);
  } catch {
    return [];
  }
  const inis = new Set(entries.filter((f) => f.endsWith('.ini')).map((f) => f.slice(0, -4)));
  for (const entry of entries) {
    // 只有 .avd 目录没有同名 .ini 的虚拟机无法被模拟器识别，属于创建中断的残留
    if (entry.endsWith('.avd') && !inis.has(entry.slice(0, -4))) {
      fs.rmSync(path.join(dirs.avdHome, entry), { recursive: true, force: true });
    }
  }
  const avds: AvdInfo[] = [];
  for (const name of inis) {
    const ini = `${name}.ini`;
    const iniPath = path.join(dirs.avdHome, ini);
    let imagePkg: string | undefined;
    let deviceName: string | undefined;
    try {
      const config = parseConfigIni(fs.readFileSync(path.join(dirs.avdHome, `${name}.avd`, 'config.ini'), 'utf8'));
      // 新版 avdmanager 写相对路径的 image.sysdir.1；老版本写绝对路径的 image.sysimg.1.dir
      const rawDir = config['image.sysdir.1'] ?? config['image.sysimg.1.dir'];
      if (rawDir) imagePkg = imageDirToPkg(rawDir);
      if (config['hw.device.name']) deviceName = config['hw.device.name'];
    } catch {
      // config.ini 读不到就只有名字
    }
    avds.push({ name, iniPath, imagePkg, deviceName });
  }
  return avds.sort((a, b) => a.name.localeCompare(b.name));
}

/** avdmanager 的 java 直调命令（绕开 .bat 与 cmd.exe 引号问题） */
function avdTool(sdk: SdkInfo, javaPath?: string | null): { exe: string; prefix: string[] } | null {
  if (!sdk.avdmanager) return null;
  return cmdlineTool(
    sdk.avdmanager,
    javaPath,
    'avdmanager-classpath.jar',
    'com.android.sdklib.tool.AvdManagerCli',
  );
}

/** 修改 AVD 的 config.ini 键值（存在则替换，不存在则追加）；写入失败会抛出，由调用方决定是否吞掉 */
export function patchAvdConfig(avdHome: string, name: string, patch: Record<string, string>): void {
  const file = path.join(avdHome, `${name}.avd`, 'config.ini');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const out = lines.map((line) => {
    const m = line.match(/^([^=]+?)\s*=/);
    const key = m ? m[1]!.trim() : null;
    return key && key in patch ? `${key} = ${patch[key]}` : line;
  });
  for (const [k, v] of Object.entries(patch)) {
    if (!out.some((l) => new RegExp(`^${k.replace(/\./g, '\\.')}\\s*=`).test(l))) {
      out.push(`${k} = ${v}`);
    }
  }
  fs.writeFileSync(file, out.join('\r\n'), 'utf8');
}

/** 读取 AVD 的 config.ini */
export function readAvdConfig(avdHome: string, name: string): Record<string, string> {
  return parseConfigIni(fs.readFileSync(path.join(avdHome, `${name}.avd`, 'config.ini'), 'utf8'));
}

export function prepareEmulatorSkin(
  sdkRoot: string,
  avdHome: string,
  avdName: string,
  config: Record<string, string>,
): string[] {
  const candidates = [config['skin.path']];
  for (const name of [config['skin.name'], config['hw.device.name']]) {
    if (name && /^[\w.-]+$/.test(name) && name !== '.' && name !== '..')
      candidates.push(path.join(sdkRoot, 'skins', name));
  }
  for (const dir of candidates) {
    if (!dir || !path.isAbsolute(dir)) continue;
    try {
      if (!fs.statSync(path.join(dir, 'layout')).isFile()) continue;
    } catch {
      // SDK 迁移后旧 skin.path 可能失效，继续按机型查找。
      continue;
    }
    // Qt 的轮廓与屏幕遮罩另读 AVD 配置，单传 -skin 只会加载机身背景。
    if (config['skin.path'] !== dir) patchAvdConfig(avdHome, avdName, { 'skin.path': dir });
    return ['-skin', path.basename(dir), '-skindir', path.dirname(dir)];
  }
  return [];
}

export interface AvdHardware {
  ramMb?: number;
  cores?: number;
  storageGb?: number;
}

// 容量值有两种写法：ram 用 4096M，disk.dataPartition.size 既有字节数也有 avdmanager 的 10G。
// 直接 parseInt 会把 "10G" 截成 10 字节，详情页的数据分区因此显示为空。
const SIZE_RE = /^(\d+)([GM])?$/i;

/** 解析 config.ini 中的硬件配置（供编辑弹窗回显） */
export function hardwareOf(config: Record<string, string>): AvdHardware {
  const hw: AvdHardware = {};
  const ram = config['hw.ramSize']?.match(SIZE_RE);
  if (ram) hw.ramMb = ram[2]?.toUpperCase() === 'G' ? parseInt(ram[1]!, 10) * 1024 : parseInt(ram[1]!, 10);
  const cores = parseInt(config['hw.cpu.ncore'] ?? '', 10);
  if (cores > 0) hw.cores = cores;
  const disk = config['disk.dataPartition.size']?.match(SIZE_RE);
  if (disk) {
    const n = parseInt(disk[1]!, 10);
    const unit = disk[2]?.toUpperCase();
    const gb = unit === 'G' ? n : unit === 'M' ? n / 1024 : n / 1024 ** 3;
    if (gb > 0) hw.storageGb = Math.round(gb * 10) / 10;
  }
  return hw;
}

/** 写入硬件配置（留空的项不动） */
function hardwarePatch(hw: AvdHardware): Record<string, string> {
  const patch: Record<string, string> = {};
  if (hw.ramMb && hw.ramMb >= 512) patch['hw.ramSize'] = `${Math.round(hw.ramMb)}M`;
  if (hw.cores && hw.cores >= 1) patch['hw.cpu.ncore'] = String(Math.round(hw.cores));
  if (hw.storageGb && hw.storageGb >= 1) patch['disk.dataPartition.size'] = `${Math.round(hw.storageGb)}G`;
  return patch;
}

export async function createAvd(
  sdk: SdkInfo,
  dataRoot: string,
  scope: Scope,
  name: string,
  imagePkg: string,
  deviceDefId: string,
  javaPath?: string | null,
  hw?: AvdHardware,
): Promise<{ ok: boolean; error?: string }> {
  const tool = avdTool(sdk, javaPath);
  if (!tool) return { ok: false, error: 'SDK 缺少 cmdline-tools，无法创建虚拟机' };
  const dirs = scopeDirs(dataRoot, scope);
  const env = scopeEnv(dirs);
  const res = await run(
    tool.exe,
    [...tool.prefix, 'create', 'avd', '-n', name, '-k', imagePkg, '-d', deviceDefId],
    { env, stdin: 'no\n', timeoutMs: 120_000 },
  );
  if (res.code !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || '创建失败').trim().split(/\r?\n/).pop() };
  }
  // avdmanager 默认 hw.gpu.enabled=no，Windows 上软件渲染会让启动极慢，强制改回宿主 GPU
  // 手机机型模板默认 hw.keyboard=no，宿主键盘不会转发进系统，测试输入全靠软键盘；统一打开
  // config.ini 不存在等问题不阻塞创建流程
  try {
    patchAvdConfig(dirs.avdHome, name, {
      'hw.gpu.enabled': 'yes',
      'hw.gpu.mode': 'auto',
      'hw.keyboard': 'yes',
    });
    // 用户自定义硬件配置；留空项保持 avdmanager 的机型默认值（即推荐配置）
    const patch = hardwarePatch(hw ?? {});
    if (Object.keys(patch).length > 0) patchAvdConfig(dirs.avdHome, name, patch);
  } catch {
    /* 创建流程不因配置微调失败而失败 */
  }
  return { ok: true };
}

export async function deleteAvd(
  sdk: SdkInfo,
  dataRoot: string,
  scope: Scope,
  name: string,
  javaPath?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const tool = avdTool(sdk, javaPath);
  if (!tool) return { ok: false, error: 'SDK 缺少 cmdline-tools，无法删除虚拟机' };
  const dirs = scopeDirs(dataRoot, scope);
  const env = scopeEnv(dirs);
  const res = await run(tool.exe, [...tool.prefix, 'delete', 'avd', '-n', name], { env, timeoutMs: 60_000 });
  if (res.code !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || '删除失败').trim().split(/\r?\n/).pop() };
  }
  return { ok: true };
}

export async function listDeviceDefs(
  sdk: SdkInfo,
  javaPath?: string | null,
): Promise<{ ok: boolean; defs?: DeviceDef[]; error?: string }> {
  const tool = avdTool(sdk, javaPath);
  if (!tool) return { ok: false, error: 'SDK 缺少 cmdline-tools' };
  const res = await run(tool.exe, [...tool.prefix, 'list', 'device'], { timeoutMs: 60_000 });
  if (res.code !== 0) return { ok: false, error: '读取设备定义失败' };
  return { ok: true, defs: parseDeviceList(res.stdout) };
}

/** 修改已存在（且已停止）虚拟机的硬件配置 */
export function updateAvdHardware(
  dataRoot: string,
  scope: Scope,
  name: string,
  hw: AvdHardware,
): { ok: boolean; error?: string } {
  if (!/^[\w.-]{1,50}$/.test(name)) return { ok: false, error: '非法的虚拟机名称' };
  const dirs = scopeDirs(dataRoot, scope);
  const configPath = path.join(dirs.avdHome, `${name}.avd`, 'config.ini');
  if (!fs.existsSync(configPath)) return { ok: false, error: '虚拟机不存在' };
  const patch = hardwarePatch(hw);
  if (Object.keys(patch).length === 0) return { ok: true };
  // 缩小数据分区会在开机时截断镜像，落在新容量之外的已用数据直接丢失，故只允许扩容
  let current: AvdHardware = {};
  try {
    current = hardwareOf(readAvdConfig(dirs.avdHome, name));
  } catch {
    // 读不到配置时跳过校验，交给下方写入分支报错
  }
  if (
    hw.storageGb !== undefined &&
    hw.storageGb >= 1 &&
    current.storageGb !== undefined &&
    Math.round(hw.storageGb) < current.storageGb
  ) {
    return {
      ok: false,
      error: `硬盘容量只能扩容（当前 ${current.storageGb} GB）`,
    };
  }
  try {
    patchAvdConfig(dirs.avdHome, name, patch);
  } catch {
    // 设备运行中 qemu 可能持有该文件，静默成功会让用户误以为已生效（退出时还会被 qemu 回写覆盖）
    return { ok: false, error: '配置写入失败：文件可能被占用，请停止虚拟机后重试' };
  }
  return { ok: true };
}

/** 重命名虚拟机：重命名 .ini 与 .avd 目录并改写内部路径（须在停止状态） */
export function renameAvd(
  dataRoot: string,
  scope: Scope,
  oldName: string,
  newName: string,
): { ok: boolean; error?: string } {
  if (!/^[\w.-]{1,50}$/.test(newName)) return { ok: false, error: '名称仅限字母、数字、下划线、点、短横线' };
  if (oldName === newName) return { ok: true };
  const dirs = scopeDirs(dataRoot, scope);
  const oldIni = path.join(dirs.avdHome, `${oldName}.ini`);
  const oldDir = path.join(dirs.avdHome, `${oldName}.avd`);
  if (!fs.existsSync(oldIni)) return { ok: false, error: '虚拟机不存在' };
  if (fs.existsSync(path.join(dirs.avdHome, `${newName}.ini`))) {
    return { ok: false, error: '已存在同名虚拟机' };
  }
  try {
    fs.renameSync(oldDir, path.join(dirs.avdHome, `${newName}.avd`));
    fs.writeFileSync(
      path.join(dirs.avdHome, `${newName}.ini`),
      `avd.ini.encoding=UTF-8\r\npath=${path.join(dirs.avdHome, `${newName}.avd`)}\r\npath.rel=avd\\${newName}.avd\r\n`,
      'utf8',
    );
    fs.rmSync(oldIni);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `重命名失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

// Play Store 镜像的 userdata 底层是 qcow2，运行时再叠一层 qcow2 覆盖层；模拟器只在
// 底层是裸 ext4 时才会在开机时扩容，覆盖层存在时改 config 不会让 guest 看到变化。
// 下面直接拍平覆盖层、扩大文件并调用 SDK 自带的 resize2fs，避免依赖开机路径。
const QCOW2_MAGIC = Buffer.from([0x51, 0x46, 0x49, 0xfb]);
const EXT4_MAGIC = [0x53, 0xef];

function readAt(file: string, offset: number, length: number): Buffer | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, offset);
    return read === length ? buf : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function isQcow2Image(file: string): boolean {
  const head = readAt(file, 0, 4);
  return !!head && head.equals(QCOW2_MAGIC);
}

/** ext4 超级块魔数位于镜像偏移 1080（0x438）处 */
function isExt4Image(file: string): boolean {
  const magic = readAt(file, 1080, 2);
  return !!magic && magic[0] === EXT4_MAGIC[0] && magic[1] === EXT4_MAGIC[1];
}

/** 模拟器目录下的工具（qemu-img 在根目录，e2fsprogs 在 bin64） */
function emulatorTool(sdk: SdkInfo, ...parts: string[]): string | null {
  const file = path.join(path.dirname(sdk.emulator), ...parts) + (process.platform === 'win32' ? '.exe' : '');
  return fs.existsSync(file) ? file : null;
}

function tailError(r: { stdout: string; stderr: string }, fallback: string): string {
  return (r.stderr || r.stdout).trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 200) || fallback;
}

async function growExt4Image(
  sdk: SdkInfo,
  file: string,
  targetBytes: number,
  allowRepair: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const resize2fs = emulatorTool(sdk, 'bin64', 'resize2fs');
  if (!resize2fs) return { ok: false, error: '当前模拟器缺少 resize2fs，无法扩容' };
  let res = await run(resize2fs, [file], { timeoutMs: 10 * 60_000 });
  if (res.code !== 0 && allowRepair) {
    // quickboot 保存的是运行中的内存状态，文件系统通常没有干净卸载，回放日志后才能扩容
    const e2fsck = emulatorTool(sdk, 'bin64', 'e2fsck');
    if (e2fsck) {
      const chk = await run(e2fsck, ['-f', '-y', file], { timeoutMs: 30 * 60_000 });
      // e2fsck 退出码 0/1/2 都表示已修复，4 及以上才是无法修复
      if (chk.code < 4) res = await run(resize2fs, [file], { timeoutMs: 10 * 60_000 });
    }
  }
  if (res.code !== 0) return { ok: false, error: `扩容文件系统失败：${tailError(res, '未知错误')}` };
  // resize2fs 退出成功但容量没变时不能静默成功，否则界面显示的容量依旧是假的
  const tune2fs = emulatorTool(sdk, 'bin64', 'tune2fs');
  if (tune2fs) {
    const info = await run(tune2fs, ['-l', file], { timeoutMs: 60_000 });
    const blocks = Number(/Block count:\s+(\d+)/.exec(info.stdout)?.[1]);
    const blockSize = Number(/Block size:\s+(\d+)/.exec(info.stdout)?.[1]);
    const bytes = blocks * blockSize;
    if (info.code === 0 && bytes > 0 && bytes < targetBytes - 64 * 1024 ** 2) {
      return { ok: false, error: '文件系统扩容未生效' };
    }
  }
  return { ok: true };
}

/** 下次启动由模拟器以 -wipe-data 重建数据分区（加密镜像扩容的唯一可行路径） */
export const WIPE_FLAG = '.wipe-data-required';

/**
 * 确保数据分区至少为 targetGb。调用方必须保证虚拟机已停止。
 * 已是裸 ext4 时原地扩文件与文件系统；qcow2 覆盖层存在时先拍平再扩容，
 * 原镜像改名保留为 `.resize-bak-*`，失败自动回滚。
 * Play Store 等镜像的 /data 经 dm-default-key 加密，宿主机读不到 ext4 超级块，
 * guest 用户版又没有 root，无法原地扩容；此时返回 needsWipe，由调用方征得用户同意后重建。
 */
export async function ensureAvdStorage(
  sdk: SdkInfo,
  dataRoot: string,
  scope: Scope,
  name: string,
  targetGb: number,
): Promise<{ ok: boolean; error?: string; needsWipe?: boolean }> {
  if (!/^[\w.-]{1,50}$/.test(name)) return { ok: false, error: '非法的虚拟机名称' };
  const targetBytes = Math.round(targetGb) * 1024 ** 3;
  if (targetBytes <= 0) return { ok: true };
  const dirs = scopeDirs(dataRoot, scope);
  const dir = path.join(dirs.avdHome, `${name}.avd`);
  const base = path.join(dir, 'userdata-qemu.img');
  const overlay = `${base}.qcow2`;
  if (!fs.existsSync(base)) return { ok: false, error: '找不到数据镜像，无法扩容' };
  const qemuImg = emulatorTool(sdk, 'qemu-img');
  if (!qemuImg) return { ok: false, error: 'SDK 缺少 qemu-img，无法扩容' };
  const hasOverlay = fs.existsSync(overlay);

  if (!hasOverlay && !isQcow2Image(base) && isExt4Image(base)) {
    // 上次扩容后的常态：原地只扩文件尾部，不会动已有数据
    if (fs.statSync(base).size < targetBytes) {
      const res = await run(qemuImg, ['resize', '-f', 'raw', base, `${Math.round(targetGb)}G`], {
        timeoutMs: 60 * 60_000,
      });
      if (res.code !== 0) return { ok: false, error: `扩展数据镜像失败：${tailError(res, '未知错误')}` };
    }
    // 此处不做自动修复：没有覆盖层说明虚拟机是正常关机的，脏镜像不应被静默改写
    return growExt4Image(sdk, base, targetBytes, false);
  }

  const src = hasOverlay ? overlay : base;
  const info = await run(qemuImg, ['info', '--output=json', src], { timeoutMs: 60_000 });
  let virtualSize = 0;
  try {
    virtualSize = Number((JSON.parse(info.stdout) as Record<string, unknown>)['virtual-size']);
  } catch {
    // 由下方统一报错
  }
  if (!(virtualSize > 0)) return { ok: false, error: '无法读取数据镜像大小，扩容中止' };
  try {
    const st = fs.statfsSync(dir);
    if (Number(st.bavail) * Number(st.bsize) < virtualSize + 512 * 1024 ** 2) {
      return {
        ok: false,
        error: `磁盘剩余空间不足，扩容需要约 ${Math.ceil(virtualSize / 1024 ** 3)} GB 临时空间`,
      };
    }
  } catch {
    // 空间查询失败不拦截，交给转换过程报错
  }

  const tmp = `${base}.grow-raw`;
  fs.rmSync(tmp, { force: true });
  // 这版 qemu-img 在 Windows 上创建 raw 目标时会把文件截断在 2 GiB，先按虚拟大小自行预分配
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.ftruncateSync(fd, virtualSize);
  } finally {
    fs.closeSync(fd);
  }
  let res = await run(qemuImg, ['convert', '-n', '-O', 'raw', '-U', src, tmp], { timeoutMs: 60 * 60_000 });
  if (res.code !== 0) {
    fs.rmSync(tmp, { force: true });
    return { ok: false, error: `数据镜像转换失败：${tailError(res, '未知错误')}` };
  }
  if (!isExt4Image(tmp)) {
    // 转换成功但拍平后看不到 ext4 超级块：数据是块级加密的密文，宿主机无法扩容
    fs.rmSync(tmp, { force: true });
    return {
      ok: false,
      needsWipe: true,
      error: '数据分区已加密，无法在不丢失数据的前提下扩容',
    };
  }
  if (fs.statSync(tmp).size < targetBytes) {
    res = await run(qemuImg, ['resize', '-f', 'raw', tmp, `${Math.round(targetGb)}G`], {
      timeoutMs: 60 * 60_000,
    });
    if (res.code !== 0) {
      fs.rmSync(tmp, { force: true });
      return { ok: false, error: `扩展数据镜像失败：${tailError(res, '未知错误')}` };
    }
  }
  const fsRes = await growExt4Image(sdk, tmp, targetBytes, true);
  if (!fsRes.ok) {
    fs.rmSync(tmp, { force: true });
    return fsRes;
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backupPath = (file: string) => {
    let candidate = `${file}.resize-bak-${stamp}`;
    for (let i = 1; fs.existsSync(candidate); i++) candidate = `${file}.resize-bak-${stamp}-${i}`;
    return candidate;
  };
  const moved: [string, string][] = [];
  try {
    if (hasOverlay) {
      const to = backupPath(overlay);
      fs.renameSync(overlay, to);
      moved.push([overlay, to]);
    }
    const to = backupPath(base);
    fs.renameSync(base, to);
    moved.push([base, to]);
    fs.renameSync(tmp, base);
  } catch (e) {
    for (const [from, to] of moved.reverse()) {
      try {
        fs.renameSync(to, from);
      } catch {
        // 回滚失败时保留已改名的文件，至少数据还在
      }
    }
    fs.rmSync(tmp, { force: true });
    return { ok: false, error: `数据镜像替换失败：${e instanceof Error ? e.message : String(e)}` };
  }
  // 旧快照记录的是被替换掉的镜像链，下次启动必须冷启动重建覆盖层
  try {
    fs.writeFileSync(path.join(dir, '.cold-boot-required'), '1', 'utf8');
  } catch {
    // 标记写不进去最多导致首次仍尝试加载旧快照，模拟器会自行回退冷启动
  }
  return { ok: true };
}

/** 标记下次启动重建数据分区；容量配置须在调用前写入 config.ini */
export function markAvdWipe(
  dataRoot: string,
  scope: Scope,
  name: string,
): { ok: boolean; error?: string } {
  if (!/^[\w.-]{1,50}$/.test(name)) return { ok: false, error: '非法的虚拟机名称' };
  const dir = path.join(scopeDirs(dataRoot, scope).avdHome, `${name}.avd`);
  if (!fs.existsSync(dir)) return { ok: false, error: '虚拟机不存在' };
  try {
    fs.writeFileSync(path.join(dir, WIPE_FLAG), '1', 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `写入重建标记失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 读取虚拟机当前硬件配置 */
export function getAvdHardware(
  dataRoot: string,
  scope: Scope,
  name: string,
): AvdHardware | null {
  const dirs = scopeDirs(dataRoot, scope);
  try {
    return hardwareOf(readAvdConfig(dirs.avdHome, name));
  } catch {
    return null;
  }
}
