import fs from 'node:fs';
import path from 'node:path';
import type { Scope } from './types.ts';

export interface ScopeDirs {
  avdHome: string;
  appsDir: string;
  runsDir: string;
}

export function scopeKey(scope: Scope): string {
  return scope.kind === 'shared' ? 'shared' : `project:${scope.projectId}`;
}

export function scopeDirs(dataRoot: string, scope: Scope): ScopeDirs {
  if (scope.kind === 'shared') {
    const dirs = {
      avdHome: path.join(dataRoot, 'devices', 'avd'),
      appsDir: path.join(dataRoot, 'devices', 'apps'),
      runsDir: path.join(dataRoot, 'devices', 'runs'),
    };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    return dirs;
  }
  const base = path.join(dataRoot, 'projects', scope.projectId);
  const dirs = {
    avdHome: path.join(base, 'avd'),
    appsDir: path.join(base, 'apps'),
    runsDir: path.join(base, 'runs'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

/** 项目隔离的关键：虚拟机文件按作用域分开 */
export function scopeEnv(dirs: ScopeDirs): Record<string, string> {
  return { ANDROID_AVD_HOME: dirs.avdHome };
}
