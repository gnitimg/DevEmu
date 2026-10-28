import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { run } from './exec.ts';
import { scopeDirs, scopeEnv } from './env.ts';
import { loadAppSettings } from './settings.ts';
import { cameraArgs } from './camera.ts';
import { stopLocation } from './location.ts';
import {
  applyPortalProbes,
  disableDeviceDecorations,
  startDecorWatch,
  waitBooted,
} from './adb.ts';
import {
  getShellGeometry,
  repositionEmulatorWindow,
  startWindowGuard,
} from './win.ts';
import type { CameraMode, Scope, SdkInfo } from './types.ts';

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

export function findRunning(
  scopeKey: string,
  avdName: string,
): RunningEmu | undefined {
  return running.get(`${avdName}@${scopeKey}`);
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** 5554 起偶数端口；既看内部注册表，也探测系统实际占用（外部进程启动的模拟器不算在册） */
export async function pickPort(): Promise<number> {
  const used = new Set([...running.values()].map((e) => e.port));
  let port = 5554;
  while (port <= 5700) {
    if (!used.has(port) && (await portFree(port))) return port;
    port += 2;
  }
  throw new Error('没有可用的模拟器端口（5554-5700）');
}

export interface LaunchOptions {
  gpu?: string;
  noSnapshotLoad?: boolean;
  /** 设备网络代理，如 http://127.0.0.1:7890 */
  httpProxy?: string;
  /** 相机画面来源（Android 虚拟机），缺省 emulated */
  camera?: CameraMode;
  /** camera=webcam 时使用的摄像头 id（webcam0/webcam1...），缺省 webcam0 */
  webcam?: string;
}

function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  const sKey =
    scope.kind === 'shared' ? 'shared' : `project:${scope.projectId}`;
  const key = `${avdName}@${sKey}`;
  const prev = running.get(key);
  if (prev && pidAlive(prev.pid)) {
    return Promise.reject(new Error('该虚拟机已在运行'));
  }
  // 注册表残留（qemu 已退出但 exit 未清理）：清掉放行重新启动
  running.delete(key);
  return pickPort().then((port) =>
    startOnPort(sdk, dataRoot, dirs, scope, sKey, avdName, port, opts),
  );
}

async function startOnPort(
  sdk: SdkInfo,
  dataRoot: string,
  dirs: ReturnType<typeof scopeDirs>,
  scope: Scope,
  sKey: string,
  avdName: string,
  port: number,
  opts: LaunchOptions,
): Promise<RunningEmu> {
  void scope;
  // 运行期提速参数；硬件（内存/核数）以各虚拟机 config.ini 为准，不再命令行覆盖
  const args = [
    '-avd',
    avdName,
    '-port',
    String(port),
    '-no-boot-anim',
    '-netdelay',
    'none',
    '-netspeed',
    'full',
  ];
  let grpcPort = port + 3000;
  while (!(await portFree(grpcPort))) grpcPort++;
  args.push('-grpc', String(grpcPort), '-grpc-use-token');
  const gpu =
    opts.gpu ??
    (process.platform === 'win32' ? 'swiftshader_indirect' : undefined);
  if (gpu) args.push('-gpu', gpu);
  if (opts.httpProxy) args.push('-http-proxy', opts.httpProxy);
  if (opts.noSnapshotLoad) args.push('-no-snapshot-load');
  // 相机来源：屏幕模式先启动截屏馈送，等首帧落盘再拉起模拟器（避免相机源读到空文件回退默认相机）
  if (opts.camera === 'screen') {
    const { startScreenFeed, screenFeedReady } = await import('./camera.ts');
    args.push(...cameraArgs('screen', startScreenFeed(dataRoot)));
    await screenFeedReady();
  } else {
    args.push(...cameraArgs(opts.camera, '', opts.webcam));
  }
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
    // 屏幕相机馈送随模拟器退出/启动失败而释放；exit 与 error 可能双发，只释放一次
    let feedHeld = opts.camera === 'screen';
    const releaseFeed = () => {
      if (!feedHeld) return;
      feedHeld = false;
      void import('./camera.ts')
        .then((m) => m.stopScreenFeed())
        .catch(() => undefined);
    };
    const onExit = () => {
      running.delete(`${avdName}@${sKey}`);
      // 药丸窗口随模拟器一起关闭（electron 未加载时静默跳过）
      stopLocation(entry.serial);
      void import('./shell.ts')
        .then((m) => {
          m.closePill(entry.serial);
          m.closeLocationPanel(entry.serial);
        })
        .catch(() => undefined);
      releaseFeed();
      if (!settled) {
        settled = true;
        reject(new Error(translateEmulatorError(stderrTail)));
      }
    };
    child.on('exit', onExit);
    child.on('error', (err) => {
      releaseFeed();
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
          startWindowGuard(avdName, entry.serial);
        }
        // 开机后就绪链路：去圆角/刘海 overlay（后台监视防翻回）→ 联网验证探测源修正 → 药丸窗口（可在设置关闭）
        void waitBooted(sdk.adb, entry.serial, 300_000)
          .then(async (ok) => {
            if (!ok) return;
            await disableDeviceDecorations(sdk.adb, entry.serial);
            startDecorWatch(sdk.adb, entry.serial);
            await applyPortalProbes(sdk.adb, entry.serial);
            if (process.platform !== 'win32') return;
            if (loadAppSettings().pillEnabled === false) return;
            const geom = await getShellGeometry(avdName);
            if (!geom) return;
            const { openPill } = await import('./shell.ts');
            await openPill({
              serial: entry.serial,
              avdName,
              x: geom.x,
              y: geom.y,
              screenW: geom.screenW,
              screenH: geom.screenH,
            });
          })
          .catch(() => undefined);
        resolve(entry);
      }
    }, 3000);
  });
}

/** 关闭（强制）：2.5 秒优雅期后强杀进程树 */
export async function stopEmulator(
  sdk: SdkInfo,
  entry: RunningEmu,
): Promise<boolean> {
  try {
    await run(sdk.adb, ['-s', entry.serial, 'emu', 'kill'], {
      timeoutMs: 8000,
    });
  } catch {
    // adb 不通就直接杀进程
  }
  await new Promise((r) => setTimeout(r, 2500));
  if (!running.has(`${entry.avdName}@${entry.scopeKey}`)) return true;
  if (entry.pid !== undefined) {
    if (process.platform === 'win32') {
      await run('taskkill.exe', ['/PID', String(entry.pid), '/T', '/F'], {
        timeoutMs: 15_000,
      }).catch(() => undefined);
    } else {
      entry.child.kill('SIGKILL');
    }
  } else {
    entry.child.kill('SIGKILL');
  }
  // 等注册表清掉（exit 事件），最多 10 秒
  for (let i = 0; i < 20; i++) {
    if (!running.has(`${entry.avdName}@${entry.scopeKey}`)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
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
