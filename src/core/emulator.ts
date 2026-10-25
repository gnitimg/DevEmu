import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { run } from './exec.ts';
import { scopeDirs, scopeEnv } from './env.ts';
import { repositionEmulatorWindow } from './win.ts';
import type { Scope, SdkInfo } from './types.ts';

export interface RunningEmu {
  avdName: string;
  scopeKey: string;
  port: number;
  serial: string;
  pid: number | undefined;
  startedAt: number;
  child: ChildProcess;
}

const running = new Map<string, RunningEmu>(); // key: avdName@scopeKey

export function listRunning(): RunningEmu[] {
  return [...running.values()];
}

export function findRunning(scopeKey: string, avdName: string): RunningEmu | undefined {
  return running.get(`${avdName}@${scopeKey}`);
}

function pickPort(): number {
  const used = new Set([...running.values()].map((e) => e.port));
  let port = 5554;
  while (used.has(port) || port > 5700) port += 2;
  return port;
}

export interface LaunchOptions {
  gpu?: string;
  noSnapshotLoad?: boolean;
}

/** 启动模拟器；3 秒内退出视为启动失败并翻译错误 */
export function launchEmulator(
  sdk: SdkInfo,
  dataRoot: string,
  scope: Scope,
  avdName: string,
  opts: LaunchOptions = {},
): Promise<RunningEmu> {
  const dirs = scopeDirs(dataRoot, scope);
  const sKey = scope.kind === 'shared' ? 'shared' : `project:${scope.projectId}`;
  if (running.has(`${avdName}@${sKey}`)) {
    return Promise.reject(new Error('该虚拟机已在运行'));
  }
  const port = pickPort();
  // 对标 Android Studio 的启动参数：多核 + 足量内存 + 跳过开机动画 + 全速网络 + 快照快速启动
  const args = [
    '-avd',
    avdName,
    '-port',
    String(port),
    '-no-boot-anim',
    '-cores',
    '4',
    '-memory',
    '3072',
    '-netdelay',
    'none',
    '-netspeed',
    'full',
  ];
  // Windows 上 host GPU（gfxstream）易触发图形编码断言导致系统服务崩溃，angle_indirect 是稳定选择
  const gpu = opts.gpu ?? (process.platform === 'win32' ? 'angle_indirect' : undefined);
  if (gpu) args.push('-gpu', gpu);
  if (opts.noSnapshotLoad) args.push('-no-snapshot-load');
  const child = spawn(sdk.emulator, args, {
    env: { ...process.env, ...scopeEnv(dirs) },
    cwd: path.dirname(sdk.emulator),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrTail = '';
  child.stderr?.on('data', (c: Buffer) => {
    if (stderrTail.length < 8000) stderrTail += c.toString('utf8');
  });

  return new Promise((resolve, reject) => {
    const entry: RunningEmu = {
      avdName,
      scopeKey: sKey,
      port,
      serial: `emulator-${port}`,
      pid: child.pid,
      startedAt: Date.now(),
      child,
    };
    let settled = false;
    const onExit = () => {
      running.delete(`${avdName}@${sKey}`);
      if (!settled) {
        settled = true;
        reject(new Error(translateEmulatorError(stderrTail)));
      }
    };
    child.on('exit', onExit);
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        running.set(`${avdName}@${sKey}`, entry);
        if (process.platform === 'win32') {
          // 级联偏移避免多开重叠；基准 y 保证在屏幕可见区内
          const n = running.size;
          const x = 96 + ((n - 1) % 6) * 48;
          const y = 96 + ((n - 1) % 6) * 36;
          void repositionEmulatorWindow(avdName, x, y).catch(() => undefined);
        }
        resolve(entry);
      }
    }, 3000);
  });
}

export async function stopEmulator(sdk: SdkInfo, entry: RunningEmu): Promise<boolean> {
  try {
    await run(sdk.adb, ['-s', entry.serial, 'emu', 'kill'], { timeoutMs: 10_000 });
  } catch {
    // adb 不通就直接杀进程
  }
  for (let i = 0; i < 20; i++) {
    if (!running.has(`${entry.avdName}@${entry.scopeKey}`)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  entry.child.kill();
  return true;
}

/** 常见模拟器报错转中文提示 */
export function translateEmulatorError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (/whpx|hyperv|haxm|vt-x|virtualization|wsl2.*hypervisor/.test(s)) {
    return '启动失败：虚拟化不可用。检查 BIOS 虚拟化（VT-x/AMD-V）是否开启，或 Windows 的 Hyper-V/虚拟机平台设置';
  }
  if (/another emulator instance|running multiple emulator/.test(s)) {
    return '启动失败：同名虚拟机实例已在运行';
  }
  if (/avd's system directory is missing|image.*missing/.test(s)) {
    return '启动失败：系统镜像缺失，请删除该虚拟机后用已安装的镜像重建';
  }
  const last = stderr.trim().split(/\r?\n/).filter(Boolean).pop();
  return last ? `启动失败：${last.slice(0, 200)}` : '启动失败';
}
