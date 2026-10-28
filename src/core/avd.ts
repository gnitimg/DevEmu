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

/** 修改 AVD 的 config.ini 键值（存在则替换，不存在则追加） */
export function patchAvdConfig(avdHome: string, name: string, patch: Record<string, string>): void {
  const file = path.join(avdHome, `${name}.avd`, 'config.ini');
  try {
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
  } catch {
    // config.ini 不存在等问题不阻塞创建流程
  }
}

/** 读取 AVD 的 config.ini */
export function readAvdConfig(avdHome: string, name: string): Record<string, string> {
  return parseConfigIni(fs.readFileSync(path.join(avdHome, `${name}.avd`, 'config.ini'), 'utf8'));
}

export interface AvdHardware {
  ramMb?: number;
  cores?: number;
  storageGb?: number;
}

const HW_RE = { ram: /^(\d+)([GM])?$/i };

/** 解析 config.ini 中的硬件配置（供编辑弹窗回显） */
export function hardwareOf(config: Record<string, string>): AvdHardware {
  const hw: AvdHardware = {};
  const ram = config['hw.ramSize']?.match(HW_RE.ram);
  if (ram) hw.ramMb = ram[2]?.toUpperCase() === 'G' ? parseInt(ram[1]!, 10) * 1024 : parseInt(ram[1]!, 10);
  const cores = parseInt(config['hw.cpu.ncore'] ?? '', 10);
  if (cores > 0) hw.cores = cores;
  const disk = parseInt(config['disk.dataPartition.size'] ?? '', 10);
  if (disk > 0) hw.storageGb = Math.round((disk / 1024 ** 3) * 10) / 10;
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
  patchAvdConfig(dirs.avdHome, name, {
    'hw.gpu.enabled': 'yes',
    'hw.gpu.mode': 'auto',
    'hw.keyboard': 'yes',
  });
  // 用户自定义硬件配置；留空项保持 avdmanager 的机型默认值（即推荐配置）
  const patch = hardwarePatch(hw ?? {});
  if (Object.keys(patch).length > 0) patchAvdConfig(dirs.avdHome, name, patch);
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
  patchAvdConfig(dirs.avdHome, name, patch);
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
