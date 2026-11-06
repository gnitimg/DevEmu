import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run } from './exec.ts';
import { stageAsciiPath, unstage } from './staging.ts';
import type { HarmonyComponent, HarmonyInfo } from './types.ts';

/**
 * HarmonyOS 环境探测与 hdc 设备操作。
 *
 * SDK 目录结构（DevEco Studio 5.x 布局）：
 *   <root>/default/openharmony/{toolchains,previewer,sysroot,...}
 *   <root>/default/hms/{hms-ads,...}（部分安装没有）
 *   hdc 位于 <root>/default/openharmony/toolchains/hdc.exe
 * 旧版为 <root>/<版本号>/openharmony/...，探测时两种都认。
 */

/** 解析 `hdc list targets` 输出为 serial 列表。
 *  daemon 安装/连接提示等杂行（stderr 合并时更多）会被误当 serial：
 *  serial（127.0.0.1:5555、USB 序列号）不含空格，提示行含空格，按此过滤。 */
export function parseHdcTargets(out: string): string[] {
  return out
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l && l !== '[Empty]' && !l.startsWith('==='))
    .map((l) => l.replace(/\s*\[(offline|connecting|unknown)\]$/i, ''))
    .filter((l) => !/\s/.test(l));
}

/** hdc 在线设备列表 */
export async function harmonyTargets(hdc: string): Promise<string[]> {
  const res = await run(hdc, ['list', 'targets'], { timeoutMs: 10_000 });
  return parseHdcTargets(`${res.stdout}\n${res.stderr}`);
}

/** 常见 hdc 安装错误转中文 */
export function translateHdcInstallError(out: string): string {
  const s = out.trim();
  if (!s) return '安装失败';
  if (/signature|签名/i.test(s)) return '安装失败：签名校验不通过（需 Release/调试签名证书）';
  if (/not match|deviceType|device type/i.test(s)) return '安装失败：应用与设备类型不匹配';
  if (/space|storage/i.test(s)) return '安装失败：设备存储空间不足';
  if (/exist|already/i.test(s)) return '安装失败：应用已存在（可先卸载后重试）';
  if (/parse|format|invalid/i.test(s)) return '安装失败：安装包格式无效';
  if (/permission|权限/i.test(s)) return '安装失败：权限被拒绝';
  return `安装失败：${s.slice(0, 160)}`;
}

/** 经 hdc 安装 HAP 到指定设备 */
export async function hdcInstall(
  hdc: string,
  target: string,
  hapPath: string,
): Promise<{ ok: boolean; error?: string }> {
  const staged = await stageAsciiPath(hapPath);
  try {
    const res = await run(hdc, ['-t', target, 'install', staged], { timeoutMs: 120_000 });
    if (res.code !== 0 || /fail|error/i.test(res.stdout + res.stderr)) {
      return { ok: false, error: translateHdcInstallError(res.stderr || res.stdout) };
    }
    return { ok: true };
  } finally {
    unstage(staged, hapPath);
  }
}

/** 启动 HAP 的入口 ability */
export async function hdcLaunch(
  hdc: string,
  target: string,
  bundleName: string,
  ability: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await run(
    hdc,
    ['-t', target, 'shell', 'aa', 'start', '-a', ability, '-b', bundleName],
    { timeoutMs: 30_000 },
  );
  if (res.code !== 0) {
    return { ok: false, error: `启动失败：${(res.stderr || res.stdout).trim().slice(0, 160) || '未知错误'}` };
  }
  return { ok: true };
}

/** 读取组件目录内 uni-package.json 的 version 字段（无则 undefined） */
function readUniVersion(dir: string): string | undefined {
  for (const f of ['uni-package.json', 'oh-uni-package.json']) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const v = (JSON.parse(raw) as { version?: unknown }).version;
      if (typeof v === 'string' && v) return v;
    } catch {
      // 无该文件或解析失败：忽略
    }
  }
  return undefined;
}

/** 扫描 openharmony/hms 下的组件目录 */
export function listHarmonyComponents(sdkSet: string): HarmonyComponent[] {
  const out: HarmonyComponent[] = [];
  for (const group of ['openharmony', 'hms']) {
    const groupDir = path.join(sdkSet, group);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(groupDir, { withFileTypes: true });
    } catch {
      continue; // 没有 hms 属正常
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      out.push({ name: `${group}/${e.name}`, dir: path.join(groupDir, e.name), version: readUniVersion(path.join(groupDir, e.name)) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 判断目录是否为有效 SDK 集（形如 <set>/openharmony/toolchains） */
function isSdkSet(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'openharmony', 'toolchains')).isDirectory();
  } catch {
    return false;
  }
}

/** 在 sdk 根下找到有效 SDK 集（default 或版本号目录），返回 {root, set} */
function findSdkSet(root: string): { root: string; set: string } | null {
  for (const cand of [path.join(root, 'default'), root]) {
    if (isSdkSet(cand)) return { root, set: cand };
  }
  // 旧版：<root>/<版本号>/openharmony
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const cand = path.join(root, e.name);
      if (isSdkSet(cand)) return { root, set: cand };
    }
  } catch {
    // 根目录不可读：继续
  }
  return null;
}

/** 在目录下递归找 hdc.exe（限深、跳过常见噪音目录）。
 *  命令行工具 zip 解压出的布局（commandline-tools/...）不在标准 SDK 集
 *  （<set>/openharmony/toolchains）结构里，标准探测找不到，导入落位后靠它兜底。 */
export function findHdcAny(root: string, maxDepth = 4): string | undefined {
  const SKIP = new Set(['node_modules', '.git']);
  const walk = (dir: string, depth: number): string | undefined => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === 'hdc.exe') return full;
    }
    if (depth >= maxDepth) return undefined;
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      const hit = walk(path.join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(root, 0);
}

function findHdc(set: string, deveco?: string): string | undefined {
  const cands = [path.join(set, 'openharmony', 'toolchains', 'hdc.exe')];
  if (deveco) {
    cands.push(path.join(deveco, 'tools', 'hdc', 'hdc.exe'));
  }
  for (const c of cands) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // 不存在：下一个
    }
  }
  return undefined;
}

function findEmulator(deveco: string): string | undefined {
  for (const rel of [
    path.join('tools', 'emulator', 'bin', 'emulator.exe'),
    path.join('tools', 'emulator', 'emulator.exe'),
  ]) {
    const c = path.join(deveco, rel);
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // 不存在：下一个
    }
  }
  return undefined;
}

/**
 * 探测 HarmonyOS 环境：优先用户显式配置的路径，
 * 其次环境变量与常见 DevEco Studio 安装位置。
 */
export function detectHarmony(explicitPath?: string): HarmonyInfo | null {
  const develcos: string[] = [];
  if (process.env.DEVECO_HOME) develcos.push(process.env.DEVECO_HOME);
  develcos.push('C:\\Program Files\\Huawei\\DevEco Studio');
  try {
    const huawei = 'C:\\Program Files\\Huawei';
    for (const e of fs.readdirSync(huawei, { withFileTypes: true })) {
      if (e.isDirectory() && /^DevEco Studio/i.test(e.name)) develcos.push(path.join(huawei, e.name));
    }
  } catch {
    // 目录不存在：忽略
  }

  const roots: string[] = [];
  const explicit = explicitPath?.trim();
  if (explicit) roots.push(explicit);
  for (const env of [process.env.DEVECO_SDK_HOME, process.env.HOS_SDK_HOME]) {
    if (env) roots.push(env);
  }
  for (const d of develcos) roots.push(path.join(d, 'sdk'));
  roots.push(path.join(os.homedir(), 'AppData', 'Local', 'Huawei', 'Sdk'));

  const seen = new Set<string>();
  for (const root of roots) {
    const key = path.resolve(root);
    if (seen.has(key)) continue;
    seen.add(key);
    const found = findSdkSet(root);
    if (!found) {
      // 用户显式指定的路径允许兜底：命令行工具 zip 落位后的布局
      // （commandline-tools/...）不是标准 SDK 集结构，但里面有 hdc 就能用
      if (explicit && path.resolve(root) === path.resolve(explicit)) {
        const hdc = findHdcAny(root);
        if (hdc)
          return {
            sdkRoot: root,
            hdc,
            apiVersion: readUniVersion(root),
            components: listHarmonyComponents(root),
          };
      }
      continue;
    }
    const hdc = findHdc(found.set, develcos.find((d) => key.startsWith(path.resolve(d))));
    if (!hdc) continue;
    const deveco = develcos.find((d) => key.startsWith(path.resolve(d)));
    return {
      sdkRoot: root,
      hdc,
      deveco,
      emulator: deveco ? findEmulator(deveco) : undefined,
      apiVersion: readUniVersion(path.join(found.set, 'openharmony')),
      components: listHarmonyComponents(found.set),
    };
  }
  return null;
}
