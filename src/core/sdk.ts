import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run } from './exec.ts';
import type { SdkInfo, SystemImage } from './types.ts';

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function validateSdkRoot(root: string): SdkInfo | null {
  if (!root) return null;
  const adb = path.join(root, 'platform-tools', 'adb.exe');
  const emulator = path.join(root, 'emulator', 'emulator.exe');
  if (!exists(adb) || !exists(emulator)) return null;
  const cmdlineBin = path.join(root, 'cmdline-tools', 'latest', 'bin');
  const avdmanager = path.join(cmdlineBin, 'avdmanager.bat');
  const sdkmanager = path.join(cmdlineBin, 'sdkmanager.bat');
  return {
    root,
    adb,
    emulator,
    avdmanager: exists(avdmanager) ? avdmanager : undefined,
    sdkmanager: exists(sdkmanager) ? sdkmanager : undefined,
    aapt: findAapt(root),
  };
}

export function findAapt(root: string): string | undefined {
  const btDir = path.join(root, 'build-tools');
  if (!exists(btDir)) return undefined;
  const versions = fs
    .readdirSync(btDir)
    .filter((v) => exists(path.join(btDir, v, 'aapt.exe')))
    .sort((a, b) => parseFloat(b) - parseFloat(a));
  return versions.length ? path.join(btDir, versions[0], 'aapt.exe') : undefined;
}

export function detectSdk(explicit?: string): SdkInfo | null {
  const candidates = [
    explicit,
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk'),
    path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
  ];
  for (const c of candidates) {
    if (!c) continue;
    const info = validateSdkRoot(c);
    if (info) return info;
  }
  return null;
}

export function detectJava(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : undefined,
    path.join(process.env.ProgramFiles ?? '', 'Android', 'Android Studio', 'jbr', 'bin', 'java.exe'),
    'java.exe',
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (c === 'java.exe') return c; // 交给 PATH
    if (exists(c)) return c;
  }
  return null;
}

/** 扫描 system-images/<api>/<tag>/<abi> 目录 */
export function listInstalledImages(root: string): SystemImage[] {
  const base = path.join(root, 'system-images');
  if (!exists(base)) return [];
  const images: SystemImage[] = [];
  for (const apiDir of fs.readdirSync(base)) {
    const m = apiDir.match(/^android-(\d+)$/);
    if (!m) continue;
    const api = parseInt(m[1]!, 10);
    const tagDir = path.join(base, apiDir);
    for (const tag of fs.readdirSync(tagDir)) {
      const abiDir = path.join(tagDir, tag);
      let abis: string[] = [];
      try {
        abis = fs.readdirSync(abiDir).filter((f) => fs.statSync(path.join(abiDir, f)).isDirectory());
      } catch {
        continue;
      }
      for (const abi of abis) {
        images.push({ pkg: `system-images;${apiDir};${tag};${abi}`, api, tag, abi });
      }
    }
  }
  return images.sort((a, b) => b.api - a.api || a.tag.localeCompare(b.tag));
}

export interface SdkmanagerEntry {
  pkg: string;
  version: string;
  desc: string;
}

/** sdkmanager --list 里的包行：pkg | 版本 | 描述 */
function parseSection(section: string): SdkmanagerEntry[] {
  const entries: SdkmanagerEntry[] = [];
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^\s+([\w.-]+(?:;[\w.-]+)*)\s*\|\s*([^|]*)\|\s*(.*)$/);
    if (m) entries.push({ pkg: m[1]!, version: m[2]!.trim(), desc: m[3]!.trim() });
  }
  return entries;
}

/** 解析 sdkmanager --list 的 Installed 与 Available 两段 */
export function parseSdkmanagerSections(stdout: string): { installed: SdkmanagerEntry[]; available: SdkmanagerEntry[] } {
  const installedStart = stdout.indexOf('Installed packages:');
  const availableStart = stdout.indexOf('Available Packages:');
  const updatesStart = stdout.indexOf('Available Updates:');
  const grab = (from: number, to: number) => (from === -1 ? [] : parseSection(stdout.slice(from, to === -1 ? undefined : to)));
  return {
    installed: grab(installedStart, availableStart === -1 ? updatesStart : availableStart),
    available: grab(availableStart, updatesStart),
  };
}

/** sdkmanager 管理界面关心的包组 */
export const SDK_PKG_GROUPS = /^(platform-tools|emulator|cmdline-tools|build-tools|platforms;|system-images;)/;

export interface JavaTool {
  exe: string;
  prefix: string[];
}

/**
 * cmdline-tools 的 .bat 只是 java 包装；直接调 java 绕开 cmd.exe，
 * 否则镜像包名里的分号会被 cmd 的引号剥离规则切碎
 */
export function cmdlineTool(
  batPath: string,
  javaPath: string | null | undefined,
  jar: string,
  mainClass: string,
): JavaTool {
  const home = path.dirname(path.dirname(batPath)); // bin/.. = cmdline-tools/latest
  const exe = javaPath && javaPath !== 'java.exe' ? javaPath : 'java.exe';
  return {
    exe,
    prefix: [`-Dcom.android.sdkmanager.toolsdir=${home}`, '-classpath', path.join(home, 'lib', jar), mainClass],
  };
}

export function runSdkmanager(
  sdk: { sdkmanager?: string; root: string },
  args: string[],
  opts: { javaPath?: string | null; onLine?: (line: string) => void } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!sdk.sdkmanager) return Promise.resolve({ code: 1, stdout: '', stderr: 'SDK 缺少 cmdline-tools' });
  const tool = cmdlineTool(
    sdk.sdkmanager,
    opts.javaPath,
    'sdkmanager-classpath.jar',
    'com.android.sdklib.tool.sdkmanager.SdkManagerCli',
  );
  // 直调 java 无法像 .bat 那样从自身位置推断 SDK 根，必须显式指定
  return run(tool.exe, [...tool.prefix, `--sdk_root=${sdk.root}`, ...args], {
    onLine: opts.onLine ? (l) => opts.onLine!(l) : undefined,
  });
}
