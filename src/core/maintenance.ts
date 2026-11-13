import fs from 'node:fs';
import path from 'node:path';
import { defaultDataRoot, settingsPath } from './settings.ts';
import { agentScriptFile } from './agent.ts';
import { logFile } from './log.ts';

export interface StorageItem {
  id: string;
  label: string;
  path: string;
}

/** 设置页“文件位置”清单：常用文件的存放位置（只读展示 + 一键打开） */
export function storageItems(dataRoot: string): StorageItem[] {
  return [
    { id: 'settings', label: '设置文件', path: settingsPath(defaultDataRoot()) },
    { id: 'logs', label: '应用日志', path: logFile(dataRoot) },
    { id: 'downloads', label: '下载记录', path: path.join(dataRoot, 'downloads.json') },
    { id: 'agent', label: 'Agent 接入脚本', path: agentScriptFile(dataRoot) },
    { id: 'avd', label: '共享虚拟机', path: path.join(dataRoot, 'devices', 'avd') },
    { id: 'apps', label: '共享应用库', path: path.join(dataRoot, 'devices', 'apps') },
    { id: 'crashes', label: '崩溃记录', path: path.join(dataRoot, 'devices', 'crashes') },
  ];
}

/** 所有作用域的虚拟机目录：共享库 + 每个项目一个 */
export function avdHomeDirs(dataRoot: string): string[] {
  const homes = [path.join(dataRoot, 'devices', 'avd')];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(path.join(dataRoot, 'projects'));
  } catch {
    return homes;
  }
  for (const entry of entries) {
    homes.push(path.join(dataRoot, 'projects', entry, 'avd'));
  }
  return homes;
}

/** 统计全部作用域的虚拟机数（按 .ini 计，一台一个） */
export function countAllAvds(dataRoot: string): number {
  let count = 0;
  for (const home of avdHomeDirs(dataRoot)) {
    try {
      count += fs.readdirSync(home).filter((f) => f.endsWith('.ini')).length;
    } catch {
      // 目录不存在按 0 台
    }
  }
  return count;
}

/**
 * 删除所有作用域（共享库 + 全部项目）里的虚拟机文件。
 * 直接删 <名称>.ini 与 <名称>.avd，与 listAvds 的目录扫描口径一致，
 * 不依赖 avdmanager（清除时可能 SDK 已被卸载）。
 * 异步删除：AVD 目录可达数 GB，同步 rm 会冻结主进程所有窗口。
 */
export async function clearAllAvds(dataRoot: string): Promise<number> {
  let deleted = 0;
  for (const home of avdHomeDirs(dataRoot)) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(home);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.ini') && !entry.endsWith('.avd')) continue;
      try {
        await fs.promises.rm(path.join(home, entry), {
          recursive: true,
          force: true,
        });
        if (entry.endsWith('.avd')) deleted++;
      } catch {
        // 单个删除失败不阻塞其余
      }
    }
  }
  return deleted;
}

/**
 * 软件重置的落盘清理：只删 DevEmu 自己的已知文件/目录，
 * 绝不动数据根目录本身（用户可能把 dataRoot 指向了自选目录）。
 * settingsRoot 为 settings.json 实际所在目录（固定默认数据目录），测试时可指向临时目录。
 * 返回未能删除的目标清单（调用前应确保模拟器进程已全部退出）。
 */
export async function factoryReset(
  dataRoot: string,
  settingsRoot: string = defaultDataRoot(),
): Promise<string[]> {
  const targets = [
    path.join(dataRoot, 'projects'),
    // devices 拆成子目录：avd 被残留进程锁住时，应用库与崩溃记录仍能清掉
    path.join(dataRoot, 'devices', 'avd'),
    path.join(dataRoot, 'devices', 'apps'),
    path.join(dataRoot, 'devices', 'crashes'),
    path.join(dataRoot, 'agent'),
    path.join(dataRoot, 'logs'),
    path.join(dataRoot, 'downloads.json'),
    settingsPath(dataRoot),
    // settings.json 固定在默认数据目录；重置必须删它才能回到默认设置
    settingsPath(settingsRoot),
  ];
  // 单个目标失败（进程残留占用文件锁）不阻塞其余目标，失败清单交调用方记录；
  // 异步删除避免数 GB 清理期间冻结主进程
  const failed: string[] = [];
  for (const target of targets) {
    try {
      await fs.promises.rm(target, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 1000,
      });
    } catch {
      failed.push(target);
    }
  }
  // 子目录全清后移除空壳 devices（非空或不存在都忽略）
  try {
    fs.rmdirSync(path.join(dataRoot, 'devices'));
  } catch {
    // 非空（有锁残留）或不存在：忽略
  }
  return failed;
}
