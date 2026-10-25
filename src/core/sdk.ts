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

/** 解析 sdkmanager --list 的 Available packages 段（仅保留 system-images） */
export function parseSdkmanagerList(stdout: string): SdkmanagerEntry[] {
  const start = stdout.indexOf('Available Packages:');
  const end = stdout.indexOf('Available Updates:');
  if (start === -1) return [];
  const section = stdout.slice(start, end === -1 ? undefined : end);
  const entries: SdkmanagerEntry[] = [];
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^\s+(system-images;[^|]+)\|\s*([^|]+)\|\s*(.+)$/);
    if (!m) continue;
    entries.push({ pkg: m[1]!.trim(), version: m[2]!.trim(), desc: m[3]!.trim() });
  }
  return entries;
}

export function runSdkmanager(
  sdkmanager: string,
  args: string[],
  opts: { javaPath?: string | null; onLine?: (line: string) => void } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {};
  if (opts.javaPath && opts.javaPath !== 'java.exe') {
    env.JAVA_HOME = path.dirname(path.dirname(opts.javaPath));
  }
  return run(sdkmanager, args, { env, onLine: opts.onLine ? (l) => opts.onLine!(l) : undefined });
}
