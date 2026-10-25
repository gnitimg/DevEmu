import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Settings } from './types.ts';

export const DEFAULT_DATA_ROOT = path.join(os.homedir(), 'DevEmu');

export function settingsPath(dataRoot: string): string {
  return path.join(dataRoot, 'settings.json');
}

export function loadSettings(dataRoot: string): Settings {
  try {
    const raw = fs.readFileSync(settingsPath(dataRoot), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    if (typeof parsed.dataRoot !== 'string' || !parsed.dataRoot) throw new Error('bad');
    return { dataRoot: parsed.dataRoot, sdkPath: parsed.sdkPath, javaPath: parsed.javaPath };
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
