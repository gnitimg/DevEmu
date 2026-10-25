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

/** 直接读 avdHome 目录（比 avdmanager 快得多） */
export function listAvds(dataRoot: string, scope: Scope): AvdInfo[] {
  const dirs = scopeDirs(dataRoot, scope);
  let names: string[];
  try {
    names = fs.readdirSync(dirs.avdHome).filter((f) => f.endsWith('.ini'));
  } catch {
    return [];
  }
  const avds: AvdInfo[] = [];
  for (const ini of names) {
    const name = ini.slice(0, -4);
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

export async function createAvd(
  sdk: SdkInfo,
  dataRoot: string,
  scope: Scope,
  name: string,
  imagePkg: string,
  deviceDefId: string,
  javaPath?: string | null,
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
  patchAvdConfig(dirs.avdHome, name, { 'hw.gpu.enabled': 'yes', 'hw.gpu.mode': 'auto' });
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
