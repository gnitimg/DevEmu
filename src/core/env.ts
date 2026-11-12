import fs from 'node:fs';
import path from 'node:path';
import type { Scope } from './types.ts';

export interface ScopeDirs {
  avdHome: string;
  appsDir: string;
  crashesDir: string;
}

export function scopeKey(scope: Scope): string {
  return scope.kind === 'shared' ? 'shared' : `project:${scope.projectId}`;
}

export function scopeDirs(dataRoot: string, scope: Scope): ScopeDirs {
  if (scope.kind === 'shared') {
    const dirs = {
      avdHome: path.join(dataRoot, 'devices', 'avd'),
      appsDir: path.join(dataRoot, 'devices', 'apps'),
      crashesDir: path.join(dataRoot, 'devices', 'crashes'),
    };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    return dirs;
  }
  const base = path.join(dataRoot, 'projects', scope.projectId);
  const dirs = {
    avdHome: path.join(base, 'avd'),
    appsDir: path.join(base, 'apps'),
    crashesDir: path.join(base, 'crashes'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

/** 项目隔离的关键：虚拟机文件按作用域分开 */
export function scopeEnv(dirs: ScopeDirs): Record<string, string> {
  return { ANDROID_AVD_HOME: dirs.avdHome };
}

/**
 * 该名称的虚拟机出现在哪些作用域。adb 只能拿到 avd 名，重启后注册表丢失时
 * 用它判定在线实例属于哪个作用域；同名存在于多个作用域时无法判定，返回全部。
 */
export function avdScopeKeys(dataRoot: string, avdName: string): string[] {
  if (!/^[\w.-]+$/.test(avdName)) return [];
  const has = (home: string): boolean =>
    fs.existsSync(path.join(home, `${avdName}.ini`));
  const keys: string[] = [];
  if (has(path.join(dataRoot, 'devices', 'avd'))) keys.push('shared');
  let projects: string[] = [];
  try {
    projects = fs.readdirSync(path.join(dataRoot, 'projects'));
  } catch {
    // 无项目目录
  }
  for (const p of projects) {
    if (has(path.join(dataRoot, 'projects', p, 'avd')))
      keys.push(`project:${p}`);
  }
  return keys;
}
