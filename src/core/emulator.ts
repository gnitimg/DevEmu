import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { run } from './exec.ts';
import { scopeDirs, scopeEnv } from './env.ts';
import { loadAppSettings } from './settings.ts';
import { cameraArgs } from './camera.ts';
import { stopLocation } from './location.ts';
import { prepareEmulatorSkin, readAvdConfig, WIPE_FLAG } from './avd.ts';
import {
  applyPortalProbes,
  installApk,
  preferCellularNetwork,
  restoreDeviceDecorations,
  setGuestDeviceName,
  waitBooted,
} from './adb.ts';
import { apkFilePath, listApps } from './apk.ts';
import { recordCrash } from './crashes.ts';
import { watchAndroidCrashes } from './crashwatch.ts';
import {
  getShellGeometry,
  repositionEmulatorWindow,
  startWindowGuard,
} from './win.ts';
import type { CameraMode, CrashRecord, Scope, SdkInfo } from './types.ts';

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
// pickPort 命中到 running.set 之间存在多个 await 的窗口：预留集挡住并发的
// 第二次 launch 选中同一端口（qemu 双实例同端口必然起不来）
const reservedPorts = new Set<number>();

/**
 * 运行中实例落盘：应用重启后 qemu 仍在跑，而 adb 只暴露 avd 名、不暴露
 * AVD_HOME。同名虚拟机可同时存在于设备池与项目作用域，只靠名字会认错实例，
 * 所以把 serial→scopeKey 存下来；只有 pid 仍存活的条目才算数。
 */
interface PersistedRunning {
  serial: string;
  avdName: string;
  scopeKey: string;
  port: number;
  pid?: number;
  startedAt: number;
}

let registryRoot: string | null = null;

function runningRegistryPath(root: string): string {
  return path.join(root, 'running-emulators.json');
}

function persistRunning(): void {
  if (!registryRoot) return;
  try {
    const entries: PersistedRunning[] = [...running.values()].map((e) => ({
      serial: e.serial,
      avdName: e.avdName,
      scopeKey: e.scopeKey,
      port: e.port,
      pid: e.pid,
      startedAt: e.startedAt,
    }));
    const file = runningRegistryPath(registryRoot);
    fs.mkdirSync(registryRoot, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // 仅用于重启后恢复作用域归属，写失败不影响启动
  }
}

// emu:list 3s 轮询每轮要读本注册表多次（runningScopeMap×2 + stop 兜底），
// 读盘 + 逐条 pidAlive 探测是重复成本：按 mtime 缓存，persistRunning 的
// rename 写入会改 mtime 自然失效；返回数组调用方只读不持有
let persistedCache: { mtimeMs: number; dataRoot: string; entries: PersistedRunning[] } | null = null;

export function listPersistedRunning(dataRoot: string): PersistedRunning[] {
  const file = runningRegistryPath(dataRoot);
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  if (persistedCache && persistedCache.dataRoot === dataRoot && persistedCache.mtimeMs === mtimeMs) {
    return persistedCache.entries;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    persistedCache = { mtimeMs, dataRoot, entries: [] };
    return [];
  }
  if (!Array.isArray(raw)) {
    persistedCache = { mtimeMs, dataRoot, entries: [] };
    return [];
  }
  const live: PersistedRunning[] = [];
  for (const item of raw) {
    const e = item as Partial<PersistedRunning> | null;
    if (!e || typeof e !== 'object') continue;
    if (typeof e.serial !== 'string' || !e.serial.startsWith('emulator-')) continue;
    if (typeof e.avdName !== 'string' || typeof e.scopeKey !== 'string') continue;
    if (typeof e.pid !== 'number' || !pidAlive(e.pid)) continue;
    live.push({
      serial: e.serial,
      avdName: e.avdName,
      scopeKey: e.scopeKey,
      port: Number(e.port) || 0,
      pid: e.pid,
      startedAt: Number(e.startedAt) || 0,
    });
  }
  persistedCache = { mtimeMs, dataRoot, entries: live };
  return live;
}

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
    if (used.has(port) || reservedPorts.has(port)) {
      port += 2;
      continue;
    }
    // 先占位再探测：has 与 add 之间隔着 await 时，并发两次 launch 会双双通过检查
    reservedPorts.add(port);
    if (await portFree(port)) return port;
    reservedPorts.delete(port);
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
  } catch (err) {
    // EPERM = 进程存在但无权限发信号，必须按存活处理，否则注册表被误清后双重启动
    return err instanceof Error && (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function broadcastCrash(record: CrashRecord): void {
  void import('electron')
    .then(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
        // 与 ipc.ts broadcast 同口径：药丸/定位面板不消费主窗频道
        if (w.getTitle().startsWith('devemu-')) continue;
        w.webContents.send('crash:recorded', record);
      }
    })
    .catch(() => undefined);
}

/** 把该作用域库中的应用补装到设备（已装跳过），结果广播到各窗口。
 *  调用方须保证系统已 boot（挂到启动链路的 waitBooted 就绪点上，
 *  不再自起第二个轮询循环）。UI 与 Agent 桥两条启动路径行为一致。 */
function autoInstallAfterBoot(
  sdk: SdkInfo,
  scope: Scope,
  avdName: string,
  serial: string,
): void {
  void (async () => {
    try {
      const settings = loadAppSettings();
      const apps = listApps(
        scopeDirs(settings.dataRoot, scope).appsDir,
      ).filter((a) => a.kind !== 'hap');
      if (apps.length === 0) return;
      const results: { id: string; label: string; ok: boolean; error?: string }[] =
        [];
      for (const a of apps) {
        // 补装语义：已装的应用跳过——每次开机都 -r 重装会让冷启动后再空转
        // 一轮包管理器，且不断弹"已安装"噪音；更新走应用库的"更新"按钮
        try {
          const chk = await run(
            sdk.adb,
            ['-s', serial, 'shell', 'pm', 'path', a.packageName ?? ''],
            { timeoutMs: 15_000 },
          );
          if (chk.code === 0 && /package:/.test(chk.stdout)) continue;
        } catch {
          // 探测失败按未安装处理，继续尝试安装
        }
        const r = await installApk(
          sdk.adb,
          serial,
          apkFilePath(scopeDirs(settings.dataRoot, scope).appsDir, a.id),
        ).catch((err: unknown) => ({
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        }));
        results.push({
          id: a.id,
          label: a.label ?? a.fileName,
          ok: !!r.ok,
          error: r.ok ? undefined : r.error,
        });
      }
      if (results.length === 0) return;
      const { BrowserWindow } = await import('electron');
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && !w.webContents.isDestroyed())
          w.webContents.send('apk:autoinstall', { avdName, results });
      }
    } catch {
      // 设备已关闭等：静默
    }
  })();
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
  registryRoot = dataRoot;
  const prev = running.get(key);
  if (prev && pidAlive(prev.pid)) {
    return Promise.reject(new Error('该虚拟机已在运行'));
  }
  // 注册表残留（qemu 已退出但 exit 未清理）：清掉放行重新启动
  if (running.delete(key)) persistRunning();
  return pickPort().then((port) =>
    startOnPort(sdk, dataRoot, dirs, scope, sKey, avdName, port, opts).catch((e) => {
      // spawn 前失败（config/端口/相机馈送抛错）：释放预留端口，否则池被占死
      reservedPorts.delete(port);
      throw e;
    }),
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
  // 运行期提速参数；硬件（内存/核数）以各虚拟机 config.ini 为准，不再命令行覆盖
  const config = readAvdConfig(dirs.avdHome, avdName);
  // 扩容替换过数据镜像后旧快照已失效，首次启动必须冷启动
  const avdDir = path.join(dirs.avdHome, `${avdName}.avd`);
  const coldBootFlag = path.join(avdDir, '.cold-boot-required');
  const wipeFlag = path.join(avdDir, WIPE_FLAG);
  const wipeData = fs.existsSync(wipeFlag);
  // 重建数据分区同样不能回放旧快照
  const coldBoot = wipeData || opts.noSnapshotLoad === true || fs.existsSync(coldBootFlag);
  const args = [
    '-avd',
    avdName,
    '-port',
    String(port),
    '-no-boot-anim',
    ...prepareEmulatorSkin(sdk.root, dirs.avdHome, avdName, config),
    '-netdelay',
    'none',
    '-netspeed',
    'full',
  ];
  // 不指定时 slirp 沿用启动时的宿主 DNS，宿主换网/多网卡/VPN 残留会让 10.0.2.3
  // 整段超时（guest 表现为“已连接但打不开网页”），固定成国内公共解析器
  args.push('-dns-server', '223.5.5.5,119.29.29.29');
  let grpcPort = port + 3000;
  for (;;) {
    if (reservedPorts.has(grpcPort)) {
      grpcPort++;
      continue;
    }
    // 与 pickPort 同口径先占位再探测，防并发 launch 选到同值
    reservedPorts.add(grpcPort);
    if (await portFree(grpcPort)) break;
    reservedPorts.delete(grpcPort);
    grpcPort++;
  }
  args.push('-grpc', String(grpcPort), '-grpc-use-token');
  // swiftshader_indirect 在 API 35+ 预览镜像上整屏全黑（2026-10 实测 guest/窗口 0% 点亮），
  // angle_indirect 双路正常；个别机器 angle 黑屏时可在设置切回软件渲染
  const gpu = opts.gpu ?? (process.platform === 'win32' ? 'angle_indirect' : undefined);
  if (gpu) args.push('-gpu', gpu);
  if (opts.httpProxy) args.push('-http-proxy', opts.httpProxy);
  if (wipeData) args.push('-wipe-data');
  if (coldBoot) args.push('-no-snapshot-load');
  let entry: RunningEmu;
  let child: ChildProcess;
  try {
    // 相机来源：屏幕模式先启动截屏馈送，等首帧落盘再拉起模拟器（避免相机源读到空文件回退默认相机）
    if (opts.camera === 'screen') {
      const { startScreenFeed, screenFeedReady } = await import('./camera.ts');
      args.push(...cameraArgs('screen', startScreenFeed(dataRoot)));
      await screenFeedReady();
    } else {
      args.push(...cameraArgs(opts.camera, '', opts.webcam));
    }
    child = spawn(sdk.emulator, args, {
      env: { ...process.env, ...scopeEnv(dirs) },
      cwd: path.dirname(sdk.emulator),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    entry = {
      avdName,
      scopeKey: sKey,
      port,
      serial: `emulator-${port}`,
      pid: child.pid,
      startedAt: Date.now(),
      child,
    };
    // spawn 即在册：确认窗口与此前各 await 期间再来的 emu:launch 不再因
    // 注册表滞后选中同一端口
    running.set(`${avdName}@${sKey}`, entry);
    persistRunning();
    reservedPorts.delete(port);
    reservedPorts.delete(grpcPort);
  } catch (e) {
    // spawn 前失败：预留端口必须释放，否则端口池被永久占死
    reservedPorts.delete(port);
    reservedPorts.delete(grpcPort);
    throw e;
  }

  let stderrTail = '';
  child.stderr?.on('data', (c: Buffer) => {
    if (stderrTail.length < 8000) stderrTail += c.toString('utf8');
  });
  // stdout 是 pipe 却无人消费：OS 管道缓冲（约 64KB）写满后 qemu 会阻塞在
  // stdout 写入上，表现为模拟器卡死/黑屏假死——必须持续丢弃
  child.stdout?.on('data', () => undefined);

  // 崩溃与启动并行监听：能收到开机阶段 system_server 等系统进程的崩溃
  const labels = new Map<string, string>();
  for (const app of listApps(dirs.appsDir)) {
    if (app.packageName) labels.set(app.packageName, app.label ?? app.fileName);
  }
  let crashWatch: { stop(): void } | undefined = watchAndroidCrashes(
    sdk.adb,
    entry.serial,
    (event) => {
      try {
        const record = recordCrash(
          dirs.crashesDir,
          {
            os: 'android',
            at: event.at.toISOString(),
            device: avdName,
            source: event.source,
            sourceLabel:
              event.source === 'SYSTEM' ? undefined : labels.get(event.source),
            kind: event.kind,
            summary: event.summary,
          },
          event.log || event.summary,
        );
        broadcastCrash(record);
      } catch {
        // 记录落盘失败不能影响模拟器运行
      }
    },
  );
  const stopCrashWatch = () => {
    crashWatch?.stop();
    crashWatch = undefined;
  };

  return new Promise((resolve, reject) => {
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
      persistRunning();
      stopCrashWatch();
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
      stopCrashWatch();
      // spawn 失败只发 error 不发 exit：注册表须同步清掉
      running.delete(`${avdName}@${sKey}`);
      persistRunning();
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        if (coldBoot && pidAlive(child.pid)) {
          // 进程已存活才清除标记：启动失败时保留，重试仍走冷启动
          try {
            fs.rmSync(coldBootFlag, { force: true });
            if (wipeData) fs.rmSync(wipeFlag, { force: true });
          } catch {
            // 清除失败无碍，最多下次仍冷启动
          }
        }
        if (process.platform === 'win32') {
          // 级联偏移避免多开重叠；基准 y 保证在屏幕可见区内
          const n = running.size;
          const x = 96 + ((n - 1) % 6) * 48;
          const y = 96 + ((n - 1) % 6) * 36;
          void repositionEmulatorWindow(avdName, x, y).catch(() => undefined);
          startWindowGuard(avdName, entry.serial);
        }
        void waitBooted(sdk.adb, entry.serial, 300_000)
          .then(async (ok) => {
            if (!ok || running.get(`${avdName}@${sKey}`) !== entry) return;
            // 设备内「设备名称」（设置 → 关于）与 DevEmu、窗口标题保持同一名称
            await setGuestDeviceName(sdk.adb, entry.serial, avdName).catch(
              () => undefined,
            );
            // 自动补装挂到同一就绪点（不再自起第二个 waitBooted 轮询循环）
            autoInstallAfterBoot(sdk, scope, avdName, entry.serial);
            if (process.platform === 'win32' && loadAppSettings().pillEnabled !== false) {
              void (async () => {
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
              })().catch(() => undefined);
            }
            await restoreDeviceDecorations(sdk.adb, entry.serial, config['hw.device.name'] ?? '')
              .catch(() => undefined);
            const probesChanged = await applyPortalProbes(sdk.adb, entry.serial).catch(
              () => false,
            );
            await preferCellularNetwork(sdk.adb, entry.serial, probesChanged).catch(
              () => undefined,
            );
          })
          .catch(() => undefined);
        resolve(entry);
      }
    }, 3000);
  });
}

/** 关闭（优先优雅）：emu kill 后等待 qemu 自行退出（快照保存大内存 AVD 可超 20 秒），
 *  超时才强杀进程树——强杀会截断快照，下次启动只能冷启动（表现为黑屏时间大幅变长） */
export async function stopEmulator(
  sdk: SdkInfo,
  entry: RunningEmu,
): Promise<boolean> {
  const key = `${entry.avdName}@${entry.scopeKey}`;
  try {
    await run(sdk.adb, ['-s', entry.serial, 'emu', 'kill'], {
      timeoutMs: 8000,
    });
  } catch {
    // adb 不通就直接杀进程
  }
  for (let i = 0; i < 40; i++) {
    if (!running.has(key)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
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
    if (!running.has(key)) return true;
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
