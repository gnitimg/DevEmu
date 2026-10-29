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
