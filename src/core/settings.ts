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
    if (typeof parsed.dataRoot !== 'string' || !parsed.dataRoot) throw new Error('bad');
    return {
      dataRoot: parsed.dataRoot,
      sdkPath: parsed.sdkPath,
      javaPath: parsed.javaPath,
      harmonySdkPath: parsed.harmonySdkPath,
      gpuMode: parsed.gpuMode,
      proxyEnabled: parsed.proxyEnabled,
      proxyPort: parsed.proxyPort,
      // 旧版单一 downloadRoute 迁移为 Android 线路
      androidDownloadRoute:
        parsed.androidDownloadRoute ?? (parsed as Partial<Settings> & { downloadRoute?: 'direct' | 'proxy' }).downloadRoute,
      harmonyDownloadRoute: parsed.harmonyDownloadRoute,
      maxDownloadKbps: parsed.maxDownloadKbps,
      parallelDownloads: parsed.parallelDownloads,
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
