import {
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  app,
  type IpcMainInvokeEvent,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadAppSettings,
  saveAppSettings,
  settingsPath,
  migrateDataRoot,
  DEFAULT_DATA_ROOT,
} from './core/settings.ts';
import { appendLog, clearLogs } from './core/log.ts';
import {
  storageItems,
  countAllAvds,
  clearAllAvds,
  factoryReset,
} from './core/maintenance.ts';
import {
  detectSdk,
  detectJava,
  listInstalledImages,
  runSdkmanager,
  listInstalledPkgs,
  parseSdkmanagerSections,
  SDK_PKG_GROUPS,
  cmdlineTool,
} from './core/sdk.ts';
import { probeSystemRoutes, type RouteProbe } from './core/net.ts';
import {
  detectHarmony,
  harmonyTargets,
  listHarmonyComponents,
  hdcInstall,
  hdcLaunch,
} from './core/harmony.ts';
import {
  checkEnvDir,
  resolveEnvPlan,
  installAndroidCmdtools,
  installJdk,
  ENV_LABELS,
  HARMONY_MANUAL_URL,
  type EnvKind,
} from './core/envinstall.ts';
import { importHap } from './core/hap.ts';
import {
  hasHuaweiLogin,
  openHuaweiLogin,
  watchHuaweiLogin,
} from './core/huawei.ts';
import {
  startDownload,
  startFileDownload,
  listDownloads,
  cancelDownload,
  removeFinished,
  onDownloadsChanged,
  initDownloadStore,
} from './core/downloads.ts';
import {
  listAvds,
  createAvd,
  deleteAvd,
  listDeviceDefs,
  updateAvdHardware,
  getAvdHardware,
  renameAvd,
  type AvdHardware,
} from './core/avd.ts';
import {
  launchEmulator,
  stopEmulator,
  findRunning,
  listRunning,
} from './core/emulator.ts';
import {
  adbDevices,
  avdNameOf,
  installApk,
  launchApp,
  screenshot,
  clearData,
  uninstall,
  waitBooted,
} from './core/adb.ts';
import {
  closeAllPills,
  closeLocationPanel,
  closeLocationPanels,
  closePill,
  handlePillAction,
  hasPill,
  openGroupSerials,
  openLocationPanel,
  openPill,
  startPillMove,
  type PillAction,
} from './core/shell.ts';
import {
  locationStatus,
  nudgeLocation,
  pauseLocation,
  parseRouteText,
  sanitizeLocationConfig,
  startLocation,
  stopAllLocations,
  stopLocation,
  teleportLocation,
  type NudgeKey,
} from './core/location.ts';
import {
  deleteRoute,
  listRoutes,
  loadPrefs,
  savePrefs,
  saveRoute,
  type LocationPrefs,
} from './core/locationStore.ts';
import { getShellGeometry } from './core/win.ts';
import {
  cancelUpdateDownload,
  compareVersions,
  downloadUpdate,
  fetchLatestRelease,
  spawnInstaller,
  type ReleaseInfo,
} from './core/updater.ts';

const PILL_ACTIONS: ReadonlySet<string> = new Set<PillAction>([
  'power',
  'powerLong',
  'volup',
  'voldown',
  'screenshot',
  'rotate',
  'back',
  'home',
  'recents',
]);
import { run as runCmd } from './core/exec.ts';
import { importApk, listApps, removeApp, apkFilePath } from './core/apk.ts';
import {
  createProject,
  listProjects,
  updateProject,
  deleteProject,
} from './core/projects.ts';
import { recordRun, listRuns } from './core/runs.ts';
import { scopeDirs, scopeKey } from './core/env.ts';
import { killEmulatorProcess, killAllEmulatorProcesses } from './core/win.ts';
import {
  DEFAULT_AGENT_PORT,
  agentBridgeInfo,
  agentBridgeRunning,
  agentScriptFile,
  agentSnippet,
  ensureAgentScript,
  generateAgentToken,
  startAgentBridge,
  stopAgentBridge,
} from './core/agent.ts';
import { createAgentOps } from './core/agentOps.ts';
import type { Scope, Settings } from './core/types.ts';

function ok<T>(data: T) {
  return { ok: true as const, data };
}
function fail(error: string) {
  return { ok: false as const, error };
}

type ProgressFn = (line: string) => void;

// 下载快照变化时广播到所有窗口（1 秒节流由 core 负责）
onDownloadsChanged(() => {
  const snap = listDownloads();
  broadcast('downloads:changed', snap);
});

/** 向所有存活窗口广播 */
function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed())
      w.webContents.send(channel, payload);
  }
}

// 启动后自动补装结果广播
type AutoInstallResult = {
  id: string;
  label: string;
  ok: boolean;
  error?: string;
};
function broadcastAutoInstall(payload: {
  avdName: string;
  results: AutoInstallResult[];
}): void {
  for (const w of BrowserWindow.getAllWindows()) {
    // 窗口已销毁时访问 webContents 会抛 Object has been destroyed：先查窗口
    if (!w.isDestroyed() && !w.webContents.isDestroyed())
      w.webContents.send('apk:autoinstall', payload);
  }
}

// 设备启动完成后把该作用域库中的所有应用补装到设备，结果经 apk:autoinstall 广播
function autoInstallAfterBoot(
  scope: Scope,
  avdName: string,
  serial: string,
): void {
  void (async () => {
    try {
      const { sdk, settings } = status();
      if (!sdk) return;
      const apps = listApps(scopeDirs(settings.dataRoot, scope).appsDir).filter(
        (a) => a.kind !== 'hap',
      );
      if (apps.length === 0) return;
      const booted = await waitBooted(sdk.adb, serial, 300_000);
      if (!booted) return; // 启动超时或中途关闭：静默放弃
      const results: AutoInstallResult[] = [];
      for (const a of apps) {
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
      broadcastAutoInstall({ avdName, results });
    } catch {
      // 等待启动失败（设备已被关闭等）：不提示
    }
  })();
}

// 自绘标题栏的窗口控制
ipcMain.handle('win:minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
  return ok(true);
});
ipcMain.handle('win:toggleMaximize', (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (w) w.isMaximized() ? w.unmaximize() : w.maximize();
  return ok(true);
});
ipcMain.handle('win:close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
  return ok(true);
});
ipcMain.handle('win:isMaximized', (event) => {
  return ok(
    BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false,
  );
});

function handle(channel: string, fn: (...args: never[]) => unknown): void {
  ipcMain.handle(
    channel,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const progress: ProgressFn = (line) => {
        if (!event.sender.isDestroyed())
          event.sender.send('sdk:progress', line);
      };
      try {
        return await (fn as (...a: unknown[]) => unknown)(...args, progress);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(loadAppSettings().dataRoot, `IPC ${channel} 失败：${msg}`);
        return fail(msg);
      }
    },
  );
}

// 作用域参数校验：projectId 不允许路径字符，防止逃逸
function parseScope(raw: unknown): Scope | null {
  if (raw && typeof raw === 'object') {
    const s = raw as { kind?: unknown; projectId?: unknown };
    if (s.kind === 'shared') return { kind: 'shared' };
    if (
      s.kind === 'project' &&
      typeof s.projectId === 'string' &&
      /^[^\\/]+$/.test(s.projectId)
    ) {
      return { kind: 'project', projectId: s.projectId };
    }
  }
  return null;
}

function status() {
  const settings = loadAppSettings();
  return {
    settings,
    sdk: detectSdk(settings.sdkPath),
    java: detectJava(settings.javaPath),
  };
}

// ---------- Agent 控制桥 ----------

const agentOps = createAgentOps();

function agentStatus() {
  const s = loadAppSettings();
  const port = s.agentPort ?? DEFAULT_AGENT_PORT;
  const info = agentBridgeInfo();
  return {
    enabled: s.agentEnabled === true,
    running: info.running,
    port: info.port ?? port,
    token: s.agentToken ?? '',
    scriptPath: agentScriptFile(s.dataRoot),
    snippet: agentSnippet(s.dataRoot, port, s.agentToken ?? ''),
  };
}

/** 按当前设置同步控制桥：落盘桥脚本、按需启停；返回启动失败原因（无则 undefined） */
async function syncAgentBridge(): Promise<string | undefined> {
  try {
    const settings = loadAppSettings();
    ensureAgentScript(settings.dataRoot, app.getAppPath());
    if (!settings.agentEnabled) {
      if (agentBridgeRunning()) await stopAgentBridge();
      return undefined;
    }
    let token = settings.agentToken;
    if (!token) {
      // 无令牌时落盘一枚，保证下方比较与外部接入拿到的是同一个值
      token = generateAgentToken();
      saveAppSettings({ ...settings, agentToken: token });
    }
    const port = settings.agentPort ?? DEFAULT_AGENT_PORT;
    // 端口与令牌都一致才保持不动，避免设置页自动保存打断进行中的 agent 会话
    const info = agentBridgeInfo();
    if (info.running && info.port === port && info.token === token)
      return undefined;
    return await startAgentBridge(agentOps, { token, port }).then(
      () => undefined,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function adbAlias(sdk: NonNullable<ReturnType<typeof detectSdk>>): string {
  return sdk.adb;
}

/** 按系统取生效线路（缺省直连）；仅当选中“本地代理”且配了端口才走代理 */
function proxyOf(
  settings: {
    androidDownloadRoute?: 'direct' | 'proxy';
    harmonyDownloadRoute?: 'direct' | 'proxy';
    proxyPort?: number;
  },
  system: 'android' | 'harmonyos' = 'android',
): { port: number } | undefined {
  const route =
    system === 'harmonyos'
      ? settings.harmonyDownloadRoute
      : settings.androidDownloadRoute;
  return route === 'proxy' && settings.proxyPort
    ? { port: settings.proxyPort }
    : undefined;
}

/** SDK 包操作共用的 sdkmanager 调用（应用下载线路设置） */
function sdkRun(
  settings: ReturnType<typeof status>['settings'],
  java: string | null,
  args: string[],
  progress?: ProgressFn,
) {
  const sdk = detectSdk(settings.sdkPath);
  if (!sdk?.sdkmanager) return null;
  return runSdkmanager(sdk, args, {
    javaPath: java,
    proxy: proxyOf(settings),
    onLine: progress,
  });
}

/** 前端传来的硬件配置做数字与范围校验 */
function parseHardware(raw: unknown): AvdHardware {
  const hw: AvdHardware = {};
  const o = (raw ?? {}) as {
    ramMb?: unknown;
    cores?: unknown;
    storageGb?: number;
  };
  const ram = Number(o.ramMb);
  if (Number.isFinite(ram) && ram >= 512 && ram <= 32768)
    hw.ramMb = Math.round(ram);
  const cores = Number(o.cores);
  if (Number.isFinite(cores) && cores >= 1 && cores <= 16)
    hw.cores = Math.round(cores);
  const disk = Number(o.storageGb);
  if (Number.isFinite(disk) && disk >= 1 && disk <= 256)
    hw.storageGb = Math.round(disk);
  return hw;
}

const ENV_KINDS: EnvKind[] = ['android', 'harmonyos', 'java'];
function parseEnvKind(raw: unknown): EnvKind | null {
  return typeof raw === 'string' && (ENV_KINDS as string[]).includes(raw)
    ? (raw as EnvKind)
    : null;
}

/** 环境安装共用的下载选项（限速/并行取自设置，线路按 Android 线路） */
function envDownloadOpts(settings: ReturnType<typeof loadAppSettings>) {
  const proxy = proxyOf(settings, 'android');
  const kbps = Number(settings.maxDownloadKbps);
  return {
    proxy,
    maxBps: Number.isFinite(kbps) && kbps > 0 ? kbps * 1024 : 0,
    parallel: settings.parallelDownloads,
    upstreamPort:
      settings.androidDownloadRoute === 'proxy' && settings.proxyPort
        ? settings.proxyPort
        : undefined,
  };
}

/**
 * Android 命令行工具就位后链式补装核心组件：先静默接受许可，
 * 再把 platform-tools 与 emulator 排入下载队列（完成后 adb/emulator 齐备，SDK 才算可用）。
 */
async function chainAndroidComponents(
  dir: string,
  settings: ReturnType<typeof loadAppSettings>,
): Promise<void> {
  const sm = path.join(dir, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat');
  if (!fs.existsSync(sm)) throw new Error('cmdline-tools 未就位');
  const java = detectJava(settings.javaPath);
  if (!java) {
    throw new Error(
      '未检测到 Java：请先在“Java 路径”一行配置或安装 Java，然后重新选择 SDK 目录以补装组件',
    );
  }
  // 直调 java 而非 .bat：exec 的 cmd /c 分支会把含空格路径（--sdk_root）裂成多个参数
  const tool = cmdlineTool(
    sm,
    java,
    'sdkmanager-classpath.jar',
    'com.android.sdklib.tool.sdkmanager.SdkManagerCli',
  );
  // sdkmanager 首次安装会逐条询问许可；一次性喂入足量 y（已全部接受时立即退出）
  await runCmd(tool.exe, [...tool.prefix, `--sdk_root=${dir}`, '--licenses'], {
    stdin: 'y\n'.repeat(24),
    timeoutMs: 180_000,
  }).catch(() => undefined);
  const dl = envDownloadOpts(settings);
  const lite = { root: dir, sdkmanager: sm }; // startDownload 仅用到 root 与 sdkmanager
  await startDownload(
    lite,
    java,
    dl.proxy,
    'platform-tools',
    'platform-tools',
    undefined,
    {
      parallel: dl.parallel,
      maxBps: dl.maxBps,
      upstreamPort: dl.upstreamPort,
    },
  );
  await startDownload(lite, java, dl.proxy, 'emulator', 'emulator', undefined, {
    parallel: dl.parallel,
    maxBps: dl.maxBps,
    upstreamPort: dl.upstreamPort,
  });
}

// ---------- emu:list 轮询缓存（UI 每 3 秒拉一次，避免每轮全量 spawn 子进程） ----------

/** serial → avd 名：运行期不变，按 serial 缓存免去每轮 adb 调用 */
const avdNameCache = new Map<string, string>();
/** 上次尝试为该设备打开药丸的时间（几何未就绪时的退避） */
const pillRetryAt = new Map<string, number>();
const PILL_RETRY_MS = 60_000;
/** HarmonyOS 在线设备查询结果缓存（hdc 进程 spawn 昂贵） */
let harmonyTargetsCache: { at: number; targets: string[] } | null = null;
const HARMONY_TARGETS_CACHE_MS = 5_000;

async function avdNameCached(
  adb: string,
  serial: string,
): Promise<string | undefined> {
  const hit = avdNameCache.get(serial);
  if (hit) return hit;
  const name = await avdNameOf(adb, serial).catch(() => undefined);
  if (name) avdNameCache.set(serial, name);
  return name;
}

export function registerIpc(): void {
  initDownloadStore(loadAppSettings().dataRoot);
  handle('env:status', () => {
    const settings = loadAppSettings();
    const sdk = detectSdk(settings.sdkPath);
    const java = detectJava(settings.javaPath);
    const harmony = detectHarmony(settings.harmonySdkPath);
    return ok({
      settings,
      sdk,
      java,
      harmony,
      version: app.getVersion(),
      images: sdk ? listInstalledImages(sdk.root) : [],
    });
  });

  handle('harmony:targets', async () => {
    const harmony = detectHarmony(loadAppSettings().harmonySdkPath);
    if (!harmony) return fail('未检测到 HarmonyOS SDK');
    try {
      return ok(await harmonyTargets(harmony.hdc));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  // 仅允许删除当前扫描到的组件目录，防止任意路径删除
  handle('harmony:uninstall', (dir: unknown) => {
    if (typeof dir !== 'string' || !dir) return fail('参数错误');
    const harmony = detectHarmony(loadAppSettings().harmonySdkPath);
    if (!harmony) return fail('未检测到 HarmonyOS SDK');
    const resolved = path.resolve(dir);
    // hdc 位于 <set>/openharmony/toolchains/hdc.exe，回退三层得到 SDK 集
    const setDir = path.dirname(path.dirname(path.dirname(harmony.hdc)));
    const scanned = listHarmonyComponents(setDir);
    if (!scanned.some((c) => path.resolve(c.dir) === resolved))
      return fail('该目录不是已安装的组件');
    fs.rmSync(resolved, { recursive: true, force: true });
    return ok(true);
  });

  handle('open:url', (url: unknown) => {
    if (typeof url !== 'string' || !/^https:\/\/[\w.-]+/i.test(url))
      return fail('仅支持 https 链接');
    void shell.openExternal(url);
    return ok(true);
  });

  // 华为开发者账号：HarmonyOS SDK 下载依赖登录 Cookie，供侧栏提醒卡片查询
  handle('huawei:state', async () => ok({ loggedIn: await hasHuaweiLogin() }));
  handle('huawei:login', () => {
    openHuaweiLogin(() => broadcast('huawei:changed', { loggedIn: true }));
    return ok(true);
  });
  watchHuaweiLogin((loggedIn) => broadcast('huawei:changed', { loggedIn }));

  handle('settings:save', async (raw: unknown) => {
    const s = raw as {
      dataRoot?: string;
      sdkPath?: string;
      javaPath?: string;
      harmonySdkPath?: string;
      gpuMode?: string;
      cameraMode?: string;
      webcam?: string;
      pillEnabled?: boolean;
      proxyEnabled?: boolean;
      proxyPort?: number;
      androidDownloadRoute?: string;
      harmonyDownloadRoute?: string;
      maxDownloadKbps?: number;
      parallelDownloads?: number;
      autoCheckUpdate?: boolean;
    };
    if (!s.dataRoot || typeof s.dataRoot !== 'string')
      return fail('数据根不能为空');
    const gpu =
      s.gpuMode &&
      ['angle_indirect', 'swiftshader_indirect', 'host'].includes(s.gpuMode)
        ? s.gpuMode
        : undefined;
    const cameraMode =
      s.cameraMode && ['emulated', 'webcam', 'screen'].includes(s.cameraMode)
        ? (s.cameraMode as Settings['cameraMode'])
        : undefined;
    const webcam =
      s.webcam && /^webcam\d+$/.test(s.webcam) ? s.webcam : undefined;
    const harmonyPath =
      typeof s.harmonySdkPath === 'string' &&
      s.harmonySdkPath.trim() &&
      !/[<>"|?*]/.test(s.harmonySdkPath)
        ? s.harmonySdkPath.trim()
        : undefined;
    const port = Number(s.proxyPort);
    const proxyPort =
      Number.isFinite(port) && port >= 1 && port <= 65535
        ? Math.round(port)
        : undefined;
    const routeOf = (v: unknown) =>
      v === 'proxy' || v === 'direct' ? v : undefined;
    const kbps = Number(s.maxDownloadKbps);
    const parallel = Number(s.parallelDownloads);
    // agent 桥字段由 agent:apply 单独管理，普通设置保存不覆盖
    const agent = loadAppSettings();
    const pillWasOn = agent.pillEnabled !== false;
    const pillOn = s.pillEnabled !== false;
    // 数据根变更：先随迁全部数据再切换；迁不完（源被占用）则放弃切换，避免数据两边分裂后被当成已迁移
    const oldRoot = path.resolve(agent.dataRoot);
    const newRoot = path.resolve(s.dataRoot);
    if (path.relative(oldRoot, newRoot) !== '') {
      // 虚拟机磁盘文件被进程持有，不关干净迁移必留残缺
      if (listRunning().length > 0)
        return fail('有虚拟机正在运行，请先全部关闭后再更改数据根目录');
      // 桥进程持有旧数据根里的脚本路径，先停，保存完成后按新数据根重启
      if (agentBridgeRunning()) await stopAgentBridge().catch(() => undefined);
      const migration = migrateDataRoot(oldRoot, newRoot);
      if (migration.failed.length) {
        appendLog(
          DEFAULT_DATA_ROOT,
          `数据根迁移失败：${migration.failed.join('、')} 未迁完，数据根保持不变`,
        );
        return fail(
          `以下内容未能迁入新数据根（可能被占用）：${migration.failed.join('、')}，数据根未变更`,
        );
      }
      // 下载记录已迁到新根，下载存储改挂新位置，否则后续任务会把文件写回旧根
      initDownloadStore(newRoot);
      appendLog(
        DEFAULT_DATA_ROOT,
        `数据根迁移：${migration.moved.length} 项已迁至 ${newRoot}（改写 ${migration.iniFixed} 个虚拟机配置）`,
      );
    }
    saveAppSettings({
      dataRoot: s.dataRoot,
      sdkPath: s.sdkPath,
      javaPath: s.javaPath,
      harmonySdkPath: harmonyPath,
      gpuMode: gpu,
      // 保存过设置即视为已确认图形后端选择，swiftshader 一次性迁移不再重复
      gpuSwiftshaderMigrated: true,
      cameraMode,
      webcam,
      pillEnabled: pillOn,
      proxyEnabled: s.proxyEnabled === true,
      proxyPort,
      androidDownloadRoute: routeOf(s.androidDownloadRoute),
      harmonyDownloadRoute: routeOf(s.harmonyDownloadRoute),
      maxDownloadKbps:
        Number.isFinite(kbps) && kbps >= 0 ? Math.round(kbps) : undefined,
      parallelDownloads:
        Number.isFinite(parallel) && parallel >= 1 && parallel <= 4
          ? Math.round(parallel)
          : undefined,
      // 关于页单独传开关；设置页保存不携带该字段时保持现值
      autoCheckUpdate:
        typeof s.autoCheckUpdate === 'boolean'
          ? s.autoCheckUpdate
          : agent.autoCheckUpdate,
      agentEnabled: agent.agentEnabled,
      agentPort: agent.agentPort,
      agentToken: agent.agentToken,
    });
    // 操作中心开关实时生效：关闭立即收掉所有药丸，开启立即为在跑的模拟器补建
    if (process.platform === 'win32' && pillWasOn !== pillOn) {
      if (!pillOn) {
        closeAllPills();
      } else {
        for (const entry of listRunning()) {
          void getShellGeometry(entry.avdName)
            .then((geom) => {
              if (!geom) return;
              return openPill({
                serial: entry.serial,
                avdName: entry.avdName,
                x: geom.x,
                y: geom.y,
                screenW: geom.screenW,
                screenH: geom.screenH,
              });
            })
            .catch(() => undefined);
        }
      }
    }
    // 数据目录变化后桥脚本要重新落盘；已在目标端口运行则同步是空操作
    void syncAgentBridge();
    return ok(loadAppSettings());
  });

  handle('settings:probe', async (rawSystem: unknown) => {
    const system = rawSystem === 'harmonyos' ? 'harmonyos' : 'android';
    const { settings } = status();
    const results: RouteProbe[] = await probeSystemRoutes(
      system,
      settings.proxyEnabled ? settings.proxyPort : undefined,
    );
    return ok(results);
  });

  // ---------- 存储维护（设置页存储分区） ----------

  /** 等待 adb 中不再有模拟器条目（qemu 退出含快照保存，文件锁释放晚于命令返回；最长 waitMs） */
  async function waitEmulatorsGone(
    adb: string,
    waitMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        const devices = await adbDevices(adb);
        if (!devices.some((d) => d.serial.startsWith('emulator-'))) return true;
      } catch {
        // adb 探测失败按未退出处理，继续等
      }
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  /**
   * 关闭所有 Android 模拟器：先停在册实例，再对 adb 在线设备兜底 emu kill
   * （覆盖应用重启后注册表丢失的）；等进程真正退出，超时则强杀全部 qemu，
   * 否则 AVD 文件锁不释放，后续删除会 EPERM。
   */
  async function stopAllEmulators(): Promise<void> {
    const { sdk } = status();
    for (const entry of listRunning()) {
      if (sdk) await stopEmulator(sdk, entry).catch(() => undefined);
    }
    if (!sdk) return;
    try {
      const devices = await adbDevices(sdk.adb);
      for (const d of devices) {
        if (d.serial.startsWith('emulator-') && d.state === 'device') {
          await runCmd(sdk.adb, ['-s', d.serial, 'emu', 'kill'], {
            timeoutMs: 8000,
          }).catch(() => undefined);
        }
      }
    } catch {
      // adb 不可用时直接走进程硬杀
    }
    if (!(await waitEmulatorsGone(sdk.adb, 30_000))) {
      await killAllEmulatorProcesses().catch(() => undefined);
      await waitEmulatorsGone(sdk.adb, 10_000);
    }
    // 进程退出后文件锁仍可能被杀毒/索引器短暂持有，留出释放窗口
    await new Promise((r) => setTimeout(r, 2000));
  }

  handle('storage:info', () => {
    const settings = loadAppSettings();
    return ok({
      items: storageItems(settings.dataRoot),
      avdCount: countAllAvds(settings.dataRoot),
    });
  });

  // 在资源管理器中定位文件；仅允许数据目录内的条目，防任意路径打开
  handle('storage:reveal', (rawPath: unknown) => {
    if (typeof rawPath !== 'string' || !rawPath) return fail('参数错误');
    const settings = loadAppSettings();
    const resolved = path.resolve(rawPath);
    const underRoot = (root: string) => {
      const rel = path.relative(path.resolve(root), resolved);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    };
    if (
      !underRoot(settings.dataRoot) &&
      resolved !== path.resolve(settingsPath(DEFAULT_DATA_ROOT))
    ) {
      return fail('路径不在数据目录内');
    }
    shell.showItemInFolder(resolved);
    return ok(true);
  });

  handle('storage:clearLogs', () => {
    const dataRoot = loadAppSettings().dataRoot;
    const removed = clearLogs(dataRoot);
    // 留一条审计记录，app.log 会立即重建
    appendLog(dataRoot, `清除日志：删除 ${removed} 个日志文件`);
    return ok(removed);
  });

  handle('storage:clearAvds', async () => {
    const settings = loadAppSettings();
    await stopAllLocations();
    closeLocationPanels();
    await stopAllEmulators();
    closeAllPills();
    const deleted = clearAllAvds(settings.dataRoot);
    appendLog(settings.dataRoot, `清除所有虚拟机：删除 ${deleted} 台`);
    return ok(deleted);
  });

  handle('storage:reset', async () => {
    const settings = loadAppSettings();
    await stopAllLocations();
    closeLocationPanels();
    closeAllPills();
    await stopAllEmulators();
    await stopAgentBridge().catch(() => undefined);
    const failed = factoryReset(settings.dataRoot);
    appendLog(
      DEFAULT_DATA_ROOT,
      failed.length
        ? `软件重置：完成，但 ${failed.length} 个位置被占用未能删除（${failed.map((f) => path.basename(f)).join('、')}）`
        : `软件重置：已清除数据并恢复默认设置 v${app.getVersion()}`,
    );
    // 延迟重启，给渲染层留出展示提示的时间
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 500);
    return ok(true);
  });

  // 环境目录检测：浏览选择的目录里是否有对应环境痕迹
  handle('env:checkDir', (rawKind: unknown, rawDir: unknown) => {
    const kind = parseEnvKind(rawKind);
    const dir = typeof rawDir === 'string' ? rawDir : '';
    if (!kind || !dir) return fail('参数错误');
    return ok({ found: checkEnvDir(kind, dir) });
  });

  // 环境安装：从官方最新版下载 → 解压到所选目录（进度进下载管理）
  handle('env:install', async (rawKind: unknown, rawDir: unknown) => {
    const kind = parseEnvKind(rawKind);
    const dir = typeof rawDir === 'string' ? rawDir.trim() : '';
    if (!kind || !dir || !path.isAbsolute(dir)) return fail('参数错误');
    if (kind === 'harmonyos') {
      return ok({
        manual: true,
        url: HARMONY_MANUAL_URL,
        label: ENV_LABELS[kind],
      });
    }
    const settings = loadAppSettings();
    if (!fs.existsSync(dir)) return fail('所选目录不存在');
    const dl = envDownloadOpts(settings);
    let plan;
    try {
      plan = await resolveEnvPlan(kind, {
        viaProxy: !!dl.proxy,
        proxyPort: dl.proxy?.port,
      });
    } catch (err) {
      return fail(
        `解析官方最新版失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    startFileDownload({
      key: plan.key,
      desc: plan.desc,
      host: plan.host,
      path: plan.path,
      fileName: plan.fileName,
      viaProxy: !!dl.proxy,
      proxyPort: dl.proxy?.port,
      maxBps: dl.maxBps,
      postProcess:
        kind === 'android'
          ? async (filePath, setPct) => {
              await installAndroidCmdtools(filePath, dir, setPct);
              await chainAndroidComponents(dir, settings);
            }
          : async (filePath, setPct) => {
              const javaExe = await installJdk(filePath, dir, setPct);
              // 自动把 Java 路径指向解压出的 java.exe，安装完成即可用
              saveAppSettings({ ...loadAppSettings(), javaPath: javaExe });
            },
      onDone: (r) => {
        if (r.ok) broadcast('env:changed', { kind });
        broadcast('env:installResult', {
          label: plan.desc,
          ok: r.ok,
          cancelled: r.cancelled === true,
          error: r.ok || r.cancelled ? undefined : r.error,
        });
      },
    });
    return ok({
      manual: false,
      key: plan.key,
      desc: plan.desc,
      label: ENV_LABELS[kind],
    });
  });

  // 最近一次检查到的发布缓存：手动与自动检查共用，下载/安装不重发请求
  let lastRelease: ReleaseInfo | null = null;
  let downloading = false;

  handle('app:checkUpdate', async () => {
    const release = await fetchLatestRelease();
    lastRelease = release;
    const current = app.getVersion();
    return ok({
      latest: release.version,
      current,
      upToDate: compareVersions(release.version, current) <= 0,
      url: release.htmlUrl,
      notes: release.notes,
      hasAsset: !!release.setupAsset,
    });
  });

  let downloadedExePath: string | null = null;
  let lastProgressAt = 0;

  handle('update:download', async () => {
    if (downloading) return ok(true);
    const release = lastRelease;
    if (!release) return fail('请先检查更新');
    downloading = true;
    // “设备网络代理”是本机通用代理入口，更新下载跟随它；限速沿用全局下载限速
    const settings = loadAppSettings();
    const viaProxy = settings.proxyEnabled === true && !!settings.proxyPort;
    try {
      const exePath = await downloadUpdate(release, {
        viaProxy,
        proxyPort: viaProxy ? settings.proxyPort : undefined,
        maxBps:
          settings.maxDownloadKbps && settings.maxDownloadKbps > 0
            ? settings.maxDownloadKbps * 1024
            : undefined,
        onProgress: (received, total) => {
          // 进度事件 1 秒节流，收尾一帧必发
          const now = Date.now();
          if (now - lastProgressAt < 1000 && received < total) return;
          lastProgressAt = now;
          broadcast('update:progress', { received, total });
        },
      });
      downloadedExePath = exePath;
      broadcast('update:downloaded', { version: release.version });
      return ok(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 用户主动取消不上报错误（net 层取消统一抛“已取消”）
      if (msg !== '已取消') broadcast('update:error', { message: msg });
      return fail(msg);
    } finally {
      downloading = false;
    }
  });

  handle('update:cancel', () => {
    cancelUpdateDownload();
    return ok(true);
  });

  handle('update:install', () => {
    if (!downloadedExePath) return fail('请先下载更新');
    const exePath = downloadedExePath;
    // 略等当前 invoke 返回、界面收尾，再交给 Squirrel 安装器；退出走 before-quit 清理
    setTimeout(() => {
      spawnInstaller(exePath);
      setTimeout(() => app.quit(), 1500);
    }, 300);
    return ok(true);
  });

  // 自动检查：仅打包版启用（开发版版本号是 package.json 值，对着线上 release 必然误报）；
  // 失败与“已是最新”都不打扰，发现新版本才广播弹窗事件
  const AUTO_CHECK_DELAY = 30_000;
  const AUTO_CHECK_INTERVAL = 6 * 60 * 60_000;
  async function autoCheckUpdate(): Promise<void> {
    if (downloading) return;
    if (loadAppSettings().autoCheckUpdate === false) return;
    try {
      const release = await fetchLatestRelease();
      lastRelease = release;
      if (compareVersions(release.version, app.getVersion()) > 0)
        broadcast('update:available', {
          latest: release.version,
          current: app.getVersion(),
          notes: release.notes,
        });
    } catch {
      // 自动检查静默失败
    }
  }
  if (app.isPackaged) {
    const timer = setTimeout(() => void autoCheckUpdate(), AUTO_CHECK_DELAY);
    const interval = setInterval(
      () => void autoCheckUpdate(),
      AUTO_CHECK_INTERVAL,
    );
    timer.unref();
    interval.unref();
  }

  handle('sdk:installed', async () => {
    const { sdk, java, settings } = status();
    if (!sdk?.sdkmanager) return fail('SDK 缺少 cmdline-tools，无法管理组件');
    const list = await listInstalledPkgs(sdk, { javaPath: java });
    void settings;
    return ok(list.filter((e) => SDK_PKG_GROUPS.test(e.pkg)));
  });

  handle('sdk:available', async (_raw: unknown, progress?: ProgressFn) => {
    const { settings, java } = status();
    const res = await sdkRun(settings, java, ['--list'], progress);
    if (!res) return fail('SDK 缺少 cmdline-tools');
    if (res.code !== 0)
      return fail(
        'sdkmanager 执行失败：' + (res.stderr || res.stdout).slice(0, 300),
      );
    return ok(
      parseSdkmanagerSections(res.stdout).available.filter((e) =>
        SDK_PKG_GROUPS.test(e.pkg),
      ),
    );
  });

  const PKG_RE = /^[\w.-]+(;[\w.-]+)*$/;
  handle('sdk:install', async (pkg: string, progress?: ProgressFn) => {
    const { settings, java, sdk } = status();
    if (typeof pkg !== 'string' || !PKG_RE.test(pkg)) return fail('非法的包名');
    if (!sdk?.sdkmanager) return fail('SDK 缺少 cmdline-tools');
    // 限速与并行数来自设置；走整形代理时上游按线路设置串接
    const kbps = Number(settings.maxDownloadKbps);
    const dlOpts = {
      parallel: settings.parallelDownloads,
      maxBps: Number.isFinite(kbps) && kbps > 0 ? kbps * 1024 : 0,
      upstreamPort:
        settings.androidDownloadRoute === 'proxy' && settings.proxyPort
          ? settings.proxyPort
          : undefined,
    };
    const r = await startDownload(
      sdk,
      java,
      proxyOf(settings),
      pkg,
      pkg,
      progress,
      dlOpts,
    );
    if (!r.ok) return fail(r.error ?? '安装失败');
    return ok(true);
  });

  handle('downloads:list', () => ok(listDownloads()));
  handle('downloads:cancel', (pkg: string) => ok(cancelDownload(pkg)));
  // 删除历史记录：完成安装的 SDK 包同步执行卸载（与 SDK 管理页"卸载"同语义），
  // 失败/取消的记录或卸载失败时仅删记录
  handle('downloads:remove', async (pkg: string, startedAt: number) => {
    if (typeof pkg !== 'string' || !PKG_RE.test(pkg)) return fail('非法的包名');
    const { settings, java } = status();
    const res = await sdkRun(settings, java, ['--uninstall', pkg]);
    const uninstalled = !!res && res.code === 0;
    return ok(removeFinished(pkg, Number(startedAt)) || uninstalled);
  });

  handle('sdk:uninstall', async (pkg: string, progress?: ProgressFn) => {
    const { settings, java } = status();
    if (typeof pkg !== 'string' || !PKG_RE.test(pkg)) return fail('非法的包名');
    const res = await sdkRun(settings, java, ['--uninstall', pkg], progress);
    if (!res) return fail('SDK 缺少 cmdline-tools');
    if (res.code !== 0)
      return fail(
        '卸载失败：' + (res.stderr || res.stdout).trim().split(/\r?\n/).pop(),
      );
    return ok(true);
  });

  handle('project:list', () => ok(listProjects(loadAppSettings().dataRoot)));
  handle('project:create', (name: string, note?: string) => {
    if (!name?.trim()) return fail('项目名不能为空');
    return ok(createProject(loadAppSettings().dataRoot, name, note));
  });
  handle(
    'project:update',
    (id: string, patch: { name?: string; note?: string }) =>
      ok(updateProject(loadAppSettings().dataRoot, id, patch)),
  );
  handle('project:delete', (id: string) =>
    ok(deleteProject(loadAppSettings().dataRoot, id)),
  );

  handle('avd:list', (rawScope: unknown) => {
    const scope = parseScope(rawScope);
    if (!scope) return fail('非法的作用域');
    return ok(listAvds(loadAppSettings().dataRoot, scope));
  });
  handle(
    'avd:create',
    async (
      rawScope: unknown,
      name: string,
      imagePkg: string,
      deviceDefId: string,
      hw?: unknown,
    ) => {
      const scope = parseScope(rawScope);
      const { sdk, java, settings } = status();
      if (!scope) return fail('非法的作用域');
      if (!sdk) return fail('未检测到 Android SDK，请到设置页配置');
      if (!/^[\w.-]{1,50}$/.test(name))
        return fail('虚拟机名称仅限字母、数字、下划线、点、短横线');
      const hardware = parseHardware(hw);
      return ok(
        await createAvd(
          sdk,
          settings.dataRoot,
          scope,
          name,
          imagePkg,
          deviceDefId,
          java,
          hardware,
        ),
      );
    },
  );
  handle('avd:hardware', (rawScope: unknown, name: string) => {
    const scope = parseScope(rawScope);
    if (!scope) return fail('非法的作用域');
    return ok(getAvdHardware(loadAppSettings().dataRoot, scope, name));
  });
  handle('avd:setHardware', (rawScope: unknown, name: string, hw: unknown) => {
    const scope = parseScope(rawScope);
    if (!scope) return fail('非法的作用域');
    // qemu 退出时会用启动时的内存值回写 config.ini，运行中修改必被覆盖
    if (findRunning(scopeKey(scope), name))
      return fail('请先关闭虚拟机再修改硬件配置');
    return ok(
      updateAvdHardware(
        loadAppSettings().dataRoot,
        scope,
        name,
        parseHardware(hw),
      ),
    );
  });
  handle(
    'avd:rename',
    (rawScope: unknown, oldName: string, newName: string) => {
      const scope = parseScope(rawScope);
      if (!scope) return fail('非法的作用域');
      if (findRunning(scopeKey(scope), oldName))
        return fail('请先关闭虚拟机再重命名');
      return ok(renameAvd(loadAppSettings().dataRoot, scope, oldName, newName));
    },
  );
  handle('avd:delete', async (rawScope: unknown, name: string) => {
    const scope = parseScope(rawScope);
    const { sdk, java, settings } = status();
    if (!scope || !sdk) return fail('未检测到 Android SDK');
    // UI 层按 3 秒轮询状态禁用删除按钮，存在滞后：运行中的磁盘文件被锁，删必失败
    if (findRunning(scopeKey(scope), name)) return fail('请先关闭虚拟机再删除');
    return ok(await deleteAvd(sdk, settings.dataRoot, scope, name, java));
  });
  handle('avd:deviceDefs', async () => {
    const { sdk, java } = status();
    if (!sdk) return fail('未检测到 Android SDK');
    return ok(await listDeviceDefs(sdk, java));
  });
  // 设置页相机设备下拉：枚举 emulator 可直通的宿主摄像头
  handle('camera:webcams', async () => {
    const { sdk } = status();
    if (!sdk) return fail('未检测到 Android SDK');
    const { listWebcams } = await import('./core/camera.ts');
    return ok(await listWebcams(sdk.emulator));
  });

  handle('emu:launch', async (rawScope: unknown, avdName: string) => {
    const scope = parseScope(rawScope);
    const { sdk, settings } = status();
    if (!scope || !sdk) return fail('未检测到 Android SDK');
    const gpu =
      settings.gpuMode ??
      (process.platform === 'win32' ? 'angle_indirect' : undefined);
    const httpProxy =
      settings.proxyEnabled && settings.proxyPort
        ? `http://127.0.0.1:${settings.proxyPort}`
        : undefined;
    const entry = await launchEmulator(sdk, settings.dataRoot, scope, avdName, {
      gpu,
      httpProxy,
      camera: settings.cameraMode,
      webcam: settings.webcam,
    });
    appendLog(settings.dataRoot, `启动虚拟机 ${avdName}（${entry.serial}）`);
    autoInstallAfterBoot(scope, avdName, entry.serial);
    return ok({
      avdName: entry.avdName,
      port: entry.port,
      serial: entry.serial,
    });
  });
  handle('pill:action', async (rawSerial: unknown, rawAction: unknown) => {
    const { sdk, settings } = status();
    if (!sdk) return fail('未检测到 Android SDK');
    const serial = typeof rawSerial === 'string' ? rawSerial : '';
    if (
      !serial.startsWith('emulator-') ||
      typeof rawAction !== 'string' ||
      !PILL_ACTIONS.has(rawAction)
    ) {
      return fail('非法参数');
    }
    // 必须 await：Promise 不能塞进返回对象（Electron 结构化克隆会抛 cannot be cloned）
    return ok(
      await handlePillAction(
        sdk,
        settings.dataRoot,
        serial,
        rawAction as PillAction,
      ),
    );
  });
  handle('pill:move-start', (rawSerial: unknown) => {
    const serial = typeof rawSerial === 'string' ? rawSerial : '';
    if (!serial.startsWith('emulator-')) return fail('非法参数');
    return ok(startPillMove(serial));
  });

  // ---------- 虚拟定位 ----------
  handle('pill:open-location', (rawSerial: unknown) => {
    const serial = typeof rawSerial === 'string' ? rawSerial : '';
    if (!serial.startsWith('emulator-')) return fail('非法参数');
    void openLocationPanel(serial).catch((err: unknown) => {
      appendLog(
        loadAppSettings().dataRoot,
        `打开定位面板失败：${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return ok(true);
  });
  handle('location:start', async (rawSerial: unknown, rawConfig: unknown) => {
    const serial = typeof rawSerial === 'string' ? rawSerial : '';
    if (!serial.startsWith('emulator-')) return fail('仅支持 Android 模拟器');
    const { sdk } = status();
    if (!sdk) return fail('未检测到 Android SDK');
    const c = sanitizeLocationConfig(rawConfig);
    if (!c.ok) return fail(c.error);
    const r = await startLocation({ adbPath: sdk.adb }, serial, c.config);
    appendLog(
      loadAppSettings().dataRoot,
      `虚拟定位启动 ${serial}（${c.config.mode}，${c.config.speedMps}m/s）`,
    );
    return r.ok ? ok(true) : fail(r.error ?? '启动失败');
  });
  handle('location:stop', async (rawSerial: unknown) => {
    const serial = typeof rawSerial === 'string' ? rawSerial : '';
    if (!serial.startsWith('emulator-')) return fail('非法参数');
    await stopLocation(serial);
    return ok(true);
  });
  handle('location:pause', (rawSerial: unknown, paused: unknown) => {
    if (typeof rawSerial !== 'string' || !/^emulator-\d{1,5}$/.test(rawSerial) || typeof paused !== 'boolean')
      return fail('非法参数');
    pauseLocation(rawSerial, paused);
    return ok(true);
  });
  handle('location:status', (rawSerial: unknown) => {
    const serial = typeof rawSerial === 'string' ? rawSerial : '';
    return ok(locationStatus(serial));
  });
  handle(
    'location:nudge',
    (rawSerial: unknown, rawKey: unknown, rawPressed: unknown) => {
      const serial = typeof rawSerial === 'string' ? rawSerial : '';
      const keys: NudgeKey[] = ['up', 'down', 'left', 'right'];
      if (!serial.startsWith('emulator-') || !keys.includes(rawKey as NudgeKey))
        return fail('非法参数');
      nudgeLocation(serial, rawKey as NudgeKey, rawPressed === true);
      return ok(true);
    },
  );
  handle(
    'location:teleport',
    (rawSerial: unknown, rawLat: unknown, rawLon: unknown) => {
      const serial = typeof rawSerial === 'string' ? rawSerial : '';
      const lat = Number(rawLat);
      const lon = Number(rawLon);
      if (!serial.startsWith('emulator-') || !Number.isFinite(lat) || !Number.isFinite(lon))
        return fail('非法参数');
      if (!teleportLocation(serial, lat, lon))
        return fail('当前没有进行中的手动定位');
      return ok(true);
    },
  );

  // ---------- 路线库与面板偏好 ----------
  handle('route:save', (rawName: unknown, rawPoints: unknown) => {
    if (typeof rawName !== 'string' || !Array.isArray(rawPoints))
      return fail('非法参数');
    const { settings } = status();
    const r = saveRoute(settings.dataRoot, rawName, rawPoints as never);
    appendLog(settings.dataRoot, `保存路线「${rawName.slice(0, 30)}」`);
    return r.ok ? ok(r.id) : fail(r.error);
  });
  handle('route:list', () => {
    const { settings } = status();
    return ok(listRoutes(settings.dataRoot));
  });
  handle('route:parse', (rawText: unknown) => {
    if (typeof rawText !== 'string' || rawText.length > 2_000_000) return fail('路线文件过大');
    const points = parseRouteText(rawText);
    return points.length >= 2 ? ok(points) : fail('路线至少需要两个位置');
  });
  handle('route:delete', (rawId: unknown) => {
    if (typeof rawId !== 'string') return fail('非法参数');
    const { settings } = status();
    deleteRoute(settings.dataRoot, rawId);
    return ok(true);
  });
  handle('locprefs:load', () => {
    const { settings } = status();
    return ok(loadPrefs(settings.dataRoot));
  });
  handle('locprefs:save', (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return fail('非法参数');
    const r = raw as Record<string, unknown>;
    const clampN = (
      v: unknown,
      lo: number,
      hi: number,
      dflt: number,
    ): number => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
    };
    const prefs: LocationPrefs = {
      mode: r.mode === 'manual' ? 'manual' : 'route',
      loop: r.loop === true,
      speedMps: clampN(r.speedMps, 0.3, 12, 1.4),
      cadenceSpm: clampN(r.cadenceSpm, 40, 240, 112),
      strideM: clampN(r.strideM, 0.2, 3, 0.75),
      speedJitterPct: clampN(r.speedJitterPct, 0, 50, 8),
      strideJitterPct: clampN(r.strideJitterPct, 0, 50, 8),
      cadenceJitterPct: clampN(r.cadenceJitterPct, 0, 50, 8),
      gpsNoiseM: clampN(r.gpsNoiseM, 0, 50, 5),
      altitudeM: clampN(r.altitudeM, -500, 9000, 12),
      headingDeg: clampN(r.headingDeg, 0, 359, 0),
      accelerationMps2: clampN(r.accelerationMps2, 0.1, 5, 1.2),
      mapCompatibility: r.mapCompatibility === true,
      anchor: r.anchor && typeof r.anchor === 'object' &&
        typeof (r.anchor as {lat?: unknown}).lat === 'number' && typeof (r.anchor as {lon?: unknown}).lon === 'number' &&
        Number.isFinite((r.anchor as {lat: number}).lat) && Number.isFinite((r.anchor as {lon: number}).lon) &&
        Math.abs((r.anchor as {lat: number}).lat) <= 85 && Math.abs((r.anchor as {lon: number}).lon) <= 180
        ? r.anchor as {lat: number; lon: number} : undefined,
      lastRouteId:
        typeof r.lastRouteId === 'string' ? r.lastRouteId : undefined,
    };
    const { settings } = status();
    savePrefs(settings.dataRoot, prefs);
    return ok(true);
  });
  handle('emu:stop', async (rawScope: unknown, avdName: string) => {
    const scope = parseScope(rawScope);
    if (!scope) return fail('非法的作用域');
    const { sdk } = status();
    if (!sdk) return fail('未检测到 Android SDK');
    const entry = findRunning(scopeKey(scope), avdName);
    if (entry) {
      await stopEmulator(sdk, entry);
      appendLog(loadAppSettings().dataRoot, `关闭虚拟机 ${avdName}`);
      return ok(true);
    }
    // 注册表丢失（应用重启过）：按 adb 设备兜底，先优雅后强杀
    const devices = await adbDevices(sdk.adb);
    const matches: string[] = [];
    for (const d of devices) {
      if (!d.serial.startsWith('emulator-') || d.state !== 'device') continue;
      if ((await avdNameOf(sdk.adb, d.serial)) === avdName)
        matches.push(d.serial);
    }
    if (matches.length === 0) return fail('该虚拟机未在运行');
    for (const serial of matches) {
      await runCmd(adbAlias(sdk), ['-s', serial, 'emu', 'kill'], {
        timeoutMs: 8000,
      }).catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 3000));
    const after = await adbDevices(sdk.adb);
    let still = false;
    for (const d of after) {
      if (!d.serial.startsWith('emulator-') || d.state !== 'device') continue;
      if ((await avdNameOf(sdk.adb, d.serial)) === avdName) still = true;
    }
    if (still) await killEmulatorProcess(avdName);
    appendLog(loadAppSettings().dataRoot, `关闭虚拟机 ${avdName}`);
    return ok(true);
  });
  handle('emu:list', async () => {
    const { sdk } = status();
    const result: {
      serial: string;
      state: string;
      avdName?: string;
      type: 'android' | 'harmonyos';
    }[] = [];
    if (sdk) {
      const devices = await adbDevices(sdk.adb);
      for (const d of devices) {
        if (d.serial.startsWith('emulator-')) {
          const avdName = await avdNameCached(sdk.adb, d.serial);
          if (process.platform === 'win32' && d.state === 'device' && avdName && loadAppSettings().pillEnabled !== false && !hasPill(d.serial)) {
            // 开机期窗口几何尚未就绪：失败后 60 秒内不重试，避免 3 秒轮询每次
            // 都 spawn PowerShell 查询（冷启动期间持续空转拖慢整机）
            const lastAttempt = pillRetryAt.get(d.serial) ?? 0;
            if (Date.now() - lastAttempt >= PILL_RETRY_MS) {
              pillRetryAt.set(d.serial, Date.now());
              const geom = await getShellGeometry(avdName);
              if (geom) await openPill({ ...geom, serial: d.serial, avdName });
            }
          }
          result.push({
            ...d,
            avdName,
            type: 'android',
          });
        }
      }
      // adb 失联但在册的实例仍按运行中上报（qemu 进程存活），否则界面显示
      // 已停止、启动却被注册表拒绝，状态自相矛盾
      for (const e of listRunning()) {
        if (!result.some((r) => r.serial === e.serial)) {
          result.push({
            serial: e.serial,
            state: 'device',
            avdName: e.avdName,
            type: 'android',
          });
        }
      }
      // 设备已消失但窗口组还在（守卫未生效或崩溃时的兜底）：刷新时同步回收
      for (const serial of openGroupSerials()) {
        if (!result.some((r) => r.serial === serial)) {
          await stopLocation(serial).catch(() => undefined);
          closePill(serial);
          closeLocationPanel(serial);
        }
      }
      // 回收已下线设备的缓存（端口可能被新实例复用）
      for (const serial of [...avdNameCache.keys(), ...pillRetryAt.keys()]) {
        if (!result.some((r) => r.serial === serial)) {
          avdNameCache.delete(serial);
          pillRetryAt.delete(serial);
        }
      }
    }
    // HarmonyOS 在线设备（hdc）与 adb 设备可并存；查询失败不影响 Android 列表
    const harmony = detectHarmony(loadAppSettings().harmonySdkPath);
    if (harmony) {
      try {
        // 3 秒轮询下结果缓存 5 秒，避免每轮都 spawn hdc
        const now = Date.now();
        if (
          !harmonyTargetsCache ||
          now - harmonyTargetsCache.at >= HARMONY_TARGETS_CACHE_MS
        ) {
          harmonyTargetsCache = {
            at: now,
            targets: await harmonyTargets(harmony.hdc),
          };
        }
        for (const t of harmonyTargetsCache.targets) {
          if (!result.some((r) => r.serial === t)) {
            result.push({ serial: t, state: 'device', type: 'harmonyos' });
          }
        }
      } catch {
        harmonyTargetsCache = null;
        // hdc 服务未起或无设备：忽略
      }
    }
    return ok(result);
  });

  handle('dialog:openApk', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择应用包',
      filters: [
        { name: '应用包', extensions: ['apk', 'hap'] },
        { name: 'APK', extensions: ['apk'] },
        { name: 'HAP', extensions: ['hap'] },
      ],
      properties: ['openFile'],
    });
    return ok(r.canceled ? null : (r.filePaths[0] ?? null));
  });

  handle('dialog:openDir', async (title: string) => {
    const r = await dialog.showOpenDialog({
      title: typeof title === 'string' && title ? title : '选择文件夹',
      properties: ['openDirectory'],
    });
    return ok(r.canceled ? null : (r.filePaths[0] ?? null));
  });

  handle('apk:import', async (rawScope: unknown, filePath: string) => {
    const scope = parseScope(rawScope);
    if (!scope) return fail('非法的作用域');
    const { sdk, settings } = status();
    const dirs = scopeDirs(settings.dataRoot, scope);
    if (/\.hap$/i.test(filePath))
      return ok(await importHap(dirs.appsDir, filePath));
    return ok(await importApk(dirs.appsDir, filePath, sdk?.aapt));
  });
  handle('apk:list', (rawScope: unknown) => {
    const scope = parseScope(rawScope);
    if (!scope) return fail('非法的作用域');
    const dirs = scopeDirs(loadAppSettings().dataRoot, scope);
    return ok(listApps(dirs.appsDir));
  });
  handle('apk:remove', (rawScope: unknown, id: string) => {
    const scope = parseScope(rawScope);
    if (!scope) return fail('非法的作用域');
    const dirs = scopeDirs(loadAppSettings().dataRoot, scope);
    return ok(removeApp(dirs.appsDir, id));
  });

  handle(
    'test:install',
    async (rawScope: unknown, apkId: string, serial: string) => {
      const scope = parseScope(rawScope);
      const { sdk, settings } = status();
      if (!scope) return fail('非法的作用域');
      const dirs = scopeDirs(settings.dataRoot, scope);
      const meta = listApps(dirs.appsDir).find((a) => a.id === apkId);
      if (!meta) return fail('应用不存在');
      if (meta.kind === 'hap') {
        const harmony = detectHarmony(settings.harmonySdkPath);
        if (!harmony) return fail('未检测到 HarmonyOS SDK');
        return ok(
          await hdcInstall(
            harmony.hdc,
            serial,
            path.join(dirs.appsDir, `${apkId}.hap`),
          ),
        );
      }
      if (!sdk) return fail('未检测到 Android SDK');
      const booted = await waitBooted(sdk.adb, serial, 300_000);
      if (!booted) return fail('设备启动超时（5 分钟），未能完成安装');
      return ok(
        await installApk(sdk.adb, serial, apkFilePath(dirs.appsDir, apkId)),
      );
    },
  );

  handle(
    'test:launch',
    async (rawScope: unknown, apkId: string, serial: string) => {
      const scope = parseScope(rawScope);
      const { sdk, settings } = status();
      if (!scope) return fail('非法的作用域');
      const dirs = scopeDirs(settings.dataRoot, scope);
      const meta = listApps(dirs.appsDir).find((a) => a.id === apkId);
      if (!meta?.packageName) return fail('该应用缺少包名信息，无法启动');
      if (meta.kind === 'hap') {
        const harmony = detectHarmony(settings.harmonySdkPath);
        if (!harmony) return fail('未检测到 HarmonyOS SDK');
        return ok(
          await hdcLaunch(
            harmony.hdc,
            serial,
            meta.packageName,
            meta.activity ?? 'EntryAbility',
          ),
        );
      }
      if (!sdk) return fail('未检测到 Android SDK');
      return ok(
        await launchApp(sdk.adb, serial, meta.packageName, meta.activity),
      );
    },
  );

  handle('test:screenshot', async (serial: string) => {
    const { sdk } = status();
    if (!sdk) return fail('未检测到 Android SDK');
    const buf = await screenshot(sdk.adb, serial);
    return ok(buf.toString('base64'));
  });

  handle('test:logcat', async (serial: string) => {
    const { sdk } = status();
    if (!sdk) return fail('未检测到 Android SDK');
    const res = await runCmd(
      sdk.adb,
      ['-s', serial, 'logcat', '-d', '-t', '600'],
      { timeoutMs: 20_000 },
    );
    return ok(res.stdout);
  });

  handle(
    'test:clearData',
    async (rawScope: unknown, apkId: string, serial: string) => {
      const scope = parseScope(rawScope);
      const { sdk, settings } = status();
      if (!scope || !sdk) return fail('未检测到 Android SDK');
      const dirs = scopeDirs(settings.dataRoot, scope);
      const meta = listApps(dirs.appsDir).find((a) => a.id === apkId);
      if (!meta?.packageName) return fail('该 APK 缺少包名信息');
      return ok(await clearData(sdk.adb, serial, meta.packageName));
    },
  );

  handle(
    'test:uninstall',
    async (rawScope: unknown, apkId: string, serial: string) => {
      const scope = parseScope(rawScope);
      const { sdk, settings } = status();
      if (!scope || !sdk) return fail('未检测到 Android SDK');
      const dirs = scopeDirs(settings.dataRoot, scope);
      const meta = listApps(dirs.appsDir).find((a) => a.id === apkId);
      if (!meta?.packageName) return fail('该 APK 缺少包名信息');
      return ok(await uninstall(sdk.adb, serial, meta.packageName));
    },
  );

  handle('run:record', async (rawScope: unknown, payload: unknown) => {
    const scope = parseScope(rawScope);
    const { sdk, settings } = status();
    if (!scope || !sdk) return fail('未检测到 Android SDK');
    const p = payload as {
      avdName: string;
      serial: string;
      apkId?: string;
      result: string;
      note?: string;
    };
    const dirs = scopeDirs(settings.dataRoot, scope);
    const meta = p.apkId
      ? listApps(dirs.appsDir).find((a) => a.id === p.apkId)
      : undefined;
    let shot: Buffer | undefined;
    let log: string | undefined;
    try {
      shot = await screenshot(sdk.adb, p.serial);
    } catch {
      // 截图失败不阻塞记录
    }
    try {
      const res = await runCmd(
        sdk.adb,
        ['-s', p.serial, 'logcat', '-d', '-t', '800'],
        { timeoutMs: 20_000 },
      );
      log = res.stdout;
    } catch {
      // 同上
    }
    const rec = recordRun(
      dirs.runsDir,
      {
        avdName: p.avdName,
        apkLabel: meta?.label,
        packageName: meta?.packageName,
        result: (
          ['ok', 'install-failed', 'launch-failed', 'manual'] as const
        ).includes(p.result as never)
          ? (p.result as 'ok')
          : 'manual',
        note: p.note,
      },
      { screenshot: shot, logcat: log },
    );
    return ok(rec);
  });

  handle('run:list', (rawScope: unknown) => {
    const scope = parseScope(rawScope);
    if (!scope) return fail('非法的作用域');
    const dirs = scopeDirs(loadAppSettings().dataRoot, scope);
    return ok(listRuns(dirs.runsDir));
  });

  handle('agent:status', () => ok(agentStatus()));

  handle('agent:apply', async (raw: unknown) => {
    const p = (raw ?? {}) as { enabled?: unknown; port?: unknown };
    const cur = loadAppSettings();
    const portN = Number(p.port);
    const port =
      Number.isFinite(portN) && portN >= 1024 && portN <= 65535
        ? Math.round(portN)
        : DEFAULT_AGENT_PORT;
    saveAppSettings({
      ...cur,
      agentEnabled: p.enabled === true,
      agentPort: port,
      agentToken: cur.agentToken || generateAgentToken(),
    });
    const startError = await syncAgentBridge();
    return ok({ ...agentStatus(), startError });
  });

  handle('agent:regenerateToken', async () => {
    saveAppSettings({ ...loadAppSettings(), agentToken: generateAgentToken() });
    const startError = await syncAgentBridge();
    return ok({ ...agentStatus(), startError });
  });

  // 应用启动即按设置拉起控制桥（未启用时是空操作）
  void syncAgentBridge();
}
