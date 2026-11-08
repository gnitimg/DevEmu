import {
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  app,
  type IpcMainInvokeEvent,
} from 'electron';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
  importCommandlineTools,
} from './core/harmony.ts';
import { startHarmonyDirectDownload } from './core/harmonyDownload.ts';
import {
  acceptHosLicense,
  createHosAvd,
  deleteHosAvd,
  findHosEmulator,
  findHosEmulatorPid,
  hosLicenseNeeded,
  hosPillName,
  hosPillSerial,
  installHosImage,
  listHosAvds,
  listHosImages,
  listHosScreenProfiles,
  startHosAvd,
  stopHosAvd,
  uninstallHosImage,
  type CreateHosAvdOptions,
} from './core/hosemu.ts';
import { hosDeviceLabel, hosImageKey } from './core/hosLabels.ts';
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
  adoptPercentTask,
} from './core/downloads.ts';
import {
  listAvds,
  createAvd,
  deleteAvd,
  listDeviceDefs,
  updateAvdHardware,
  ensureAvdStorage,
  getAvdHardware,
  renameAvd,
  markAvdWipe,
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
  handleHosPillAction,
  handlePillAction,
  hasPill,
  openGroupSerials,
  openLocationPanel,
  openPill,
  startHosPillMove,
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
import { getShellGeometry, getShellGeometryByPid } from './core/win.ts';
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
import type { HarmonyInfo, Scope, Settings } from './core/types.ts';

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

// 自绘标题栏的窗口控制
ipcMain.handle('win:minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
  return ok(true);
});
ipcMain.handle('win:toggleMaximize', (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (w) {
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  }
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

/** MCP 桥脚本源：打包版经 extraResource 落在 resources/ 根（asar 外）；
 *  开发版在仓库 resources/ 目录。 */
function agentMcpSource(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'agent-mcp.mjs');
  }
  return path.join(app.getAppPath(), 'resources', 'agent-mcp.mjs');
}

/** 按当前设置同步控制桥：落盘桥脚本、按需启停；返回启动失败原因（无则 undefined） */
async function syncAgentBridge(): Promise<string | undefined> {
  try {
    const settings = loadAppSettings();
    ensureAgentScript(settings.dataRoot, agentMcpSource());
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
  // 前序失败（含被取消）必须中止链路：继续装 emulator 只会白耗带宽，SDK 仍不可用
  const pt = await startDownload(
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
  if (!pt.ok) throw new Error(pt.error ?? 'platform-tools 安装失败');
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
/** HarmonyOS 虚拟机清单缓存：emu:list 每 3 秒轮询，-list -details 约 0.2 秒 */
let hosAvdsCache: {
  at: number;
  emu: string;
  avds: Awaited<ReturnType<typeof listHosAvds>>;
} | null = null;
const HOS_AVDS_CACHE_MS = 5_000;
const HOS_PILL_RE = /^hos-[A-Za-z0-9_-]{1,120}$/;

function isHosPillSerial(serial: string): boolean {
  return HOS_PILL_RE.test(serial);
}

/** 定位/药丸按设备寻址：Android adb 串号或 HarmonyOS 药丸 serial */
function isDeviceSerial(serial: string): boolean {
  return /^emulator-\d{1,5}$/.test(serial) || isHosPillSerial(serial);
}

function invalidateHosAvdsCache(): void {
  hosAvdsCache = null;
}

async function hosAvdsCached(): Promise<{
  emu: string;
  avds: Awaited<ReturnType<typeof listHosAvds>>;
} | null> {
  let emu: string;
  try {
    emu = hosEmu();
  } catch {
    return null;
  }
  const now = Date.now();
  if (
    hosAvdsCache &&
    hosAvdsCache.emu === emu &&
    now - hosAvdsCache.at < HOS_AVDS_CACHE_MS
  ) {
    return { emu, avds: hosAvdsCache.avds };
  }
  try {
    const avds = await listHosAvds(emu);
    hosAvdsCache = { at: now, emu, avds };
    return { emu, avds };
  } catch {
    hosAvdsCache = { at: now, emu, avds: [] };
    return { emu, avds: [] };
  }
}

/** 运行中的 HarmonyOS 虚拟机各开一枚药丸；解析进程 pid 后交给窗口守卫。
 *  已开的不再查询：palette 每次轮询只做字符串比较。 */
async function syncHosPills(hos: {
  emu: string;
  avds: Awaited<ReturnType<typeof listHosAvds>>;
}): Promise<void> {
  if (process.platform !== 'win32') return;
  const running = hos.avds.filter((a) => a.running);
  const runningSerials = new Set(running.map((a) => hosPillSerial(a.name)));
  const pillOn = loadAppSettings().pillEnabled !== false;
  if (pillOn) {
    for (const avd of running) {
      const serial = hosPillSerial(avd.name);
      if (hasPill(serial)) continue;
      const lastAttempt = pillRetryAt.get(serial) ?? 0;
      if (Date.now() - lastAttempt < PILL_RETRY_MS) continue;
      pillRetryAt.set(serial, Date.now());
      try {
        const pid = await findHosEmulatorPid(avd.name);
        if (!pid) continue;
        const geom = await getShellGeometryByPid(pid);
        if (!geom) continue;
        const [width, height] = (avd.resolution ?? '')
          .split('×')
          .map((n) => parseInt(n, 10));
        await openPill({
          ...geom,
          serial,
          avdName: avd.name,
          kind: 'hos',
          pid,
          hosEmu: hos.emu,
          hosHdc: harmonyInfoCached()?.hdc,
          resolution:
            Number.isFinite(width) && Number.isFinite(height)
              ? { width: width!, height: height! }
              : undefined,
        });
      } catch {
        // 单台设备失败不影响其它实例
      }
    }
  }
  for (const serial of openGroupSerials()) {
    if (!isHosPillSerial(serial)) continue;
    if (!pillOn || !runningSerials.has(serial)) {
      await stopLocation(serial).catch(() => undefined);
      closePill(serial);
      closeLocationPanel(serial);
    }
    if (!runningSerials.has(serial)) pillRetryAt.delete(serial);
  }
}

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

/** HarmonyOS 环境探测结果缓存：detectHarmony 全量扫描组件目录并逐个读
 *  uni-package.json，3 秒轮询下不能每轮都来一遍；路径变更即失效 */
let harmonyInfoCache: {
  at: number;
  path: string;
  info: HarmonyInfo | null;
} | null = null;

function harmonyInfoCached(): HarmonyInfo | null {
  const p = loadAppSettings().harmonySdkPath;
  const now = Date.now();
  if (
    harmonyInfoCache &&
    harmonyInfoCache.path === (p ?? '') &&
    now - harmonyInfoCache.at < 5_000
  ) {
    return harmonyInfoCache.info;
  }
  const info = detectHarmony(p);
  harmonyInfoCache = { at: now, path: p ?? '', info };
  return info;
}

/** HarmonyOS 模拟器：命令行工具包内的 Emulator.exe 才支持 -start/-create */
function hosEmu(): string {
  const harmony = detectHarmony(loadAppSettings().harmonySdkPath);
  if (!harmony) throw new Error('未检测到 HarmonyOS SDK');
  const emu = findHosEmulator(harmony.sdkRoot);
  if (!emu) throw new Error('未检测到 HarmonyOS 模拟器组件');
  return emu;
}

const HOS_NAME_RE = /^[^\\/:*?"<>|\r\n]+$/;

function parseHosName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || name.length > 64 || name === '.' || name === '..' || !HOS_NAME_RE.test(name)) return null;
  return name;
}

function parseHosText(raw: unknown, max = 80): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v.length > max || /[\r\n]/.test(v)) return null;
  return v;
}

function parseHosCreate(raw: unknown): CreateHosAvdOptions | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = parseHosName(o.name);
  const deviceType = parseHosText(o.deviceType);
  const osVersion = parseHosText(o.osVersion);
  if (!name || !deviceType || !osVersion) return null;
  let screenProfile: string | undefined;
  if (o.screenProfile !== undefined) {
    const v = parseHosText(o.screenProfile, 64);
    if (!v) return null;
    screenProfile = v;
  }
  const memoryGb = o.memoryGb === undefined ? undefined : Number(o.memoryGb);
  const storageGb = o.storageGb === undefined ? undefined : Number(o.storageGb);
  const cpuCores = o.cpuCores === undefined ? undefined : Number(o.cpuCores);
  if (memoryGb !== undefined && (!Number.isInteger(memoryGb) || memoryGb < 2 || memoryGb > 32)) return null;
  if (storageGb !== undefined && (!Number.isInteger(storageGb) || storageGb < 2 || storageGb > 1023)) return null;
  if (cpuCores !== undefined && (!Number.isInteger(cpuCores) || cpuCores < 1 || cpuCores > 16)) return null;
  return { name, deviceType, osVersion, screenProfile, memoryGb, storageGb, cpuCores };
}

let hosLicenseOk = false;

/** 协议只接受一次；本进程内接受后不再重复查询 */
async function hosNeedsLicense(emu: string): Promise<boolean> {
  if (hosLicenseOk) return false;
  hosLicenseOk = !(await hosLicenseNeeded(emu));
  return !hosLicenseOk;
}

const hosImageTasks = new Map<string, ChildProcess>();

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
  handle('harmony:uninstall', async (dir: unknown) => {
    if (typeof dir !== 'string' || !dir) return fail('参数错误');
    const harmony = detectHarmony(loadAppSettings().harmonySdkPath);
    if (!harmony) return fail('未检测到 HarmonyOS SDK');
    const resolved = path.resolve(dir);
    // hdc 位于 <set>/openharmony/toolchains/hdc.exe，回退三层得到 SDK 集
    const setDir = path.dirname(path.dirname(path.dirname(harmony.hdc)));
    const scanned = listHarmonyComponents(setDir);
    if (!scanned.some((c) => path.resolve(c.dir) === resolved))
      return fail('该目录不是已安装的组件');
    // 组件可达数 GB：异步删除，不冻结主进程
    await fs.promises.rm(resolved, { recursive: true, force: true });
    return ok(true);
  });

  // ---------- HarmonyOS 虚拟机（Emulator.exe） ----------

  handle('hos:list', async () => {
    const emu = hosEmu();
    const avds = await listHosAvds(emu);
    hosAvdsCache = { at: Date.now(), emu, avds };
    return ok(avds);
  });

  handle('hos:images', async () => ok(await listHosImages(hosEmu())));

  handle('hos:screenProfiles', async (rawType: unknown) => {
    const deviceType = parseHosText(rawType, 40);
    if (!deviceType) return fail('参数错误');
    return ok(await listHosScreenProfiles(hosEmu(), deviceType));
  });

  handle('hos:acceptLicense', async () => {
    await acceptHosLicense(hosEmu());
    hosLicenseOk = true;
    return ok(true);
  });

  handle('hos:start', async (rawName: unknown) => {
    const name = parseHosName(rawName);
    if (!name) return fail('参数错误');
    const emu = hosEmu();
    if (await hosNeedsLicense(emu)) return ok({ needLicense: true });
    startHosAvd(emu, name, (message) =>
      broadcast('hos:startFailed', { name, error: message }),
    );
    invalidateHosAvdsCache();
    return ok({ started: true });
  });

  handle('hos:stop', async (rawName: unknown) => {
    const name = parseHosName(rawName);
    if (!name) return fail('参数错误');
    await stopHosAvd(hosEmu(), name);
    invalidateHosAvdsCache();
    return ok(true);
  });

  handle('hos:delete', async (rawName: unknown) => {
    const name = parseHosName(rawName);
    if (!name) return fail('参数错误');
    await deleteHosAvd(hosEmu(), name);
    invalidateHosAvdsCache();
    return ok(true);
  });

  handle('hos:create', async (raw: unknown) => {
    const opts = parseHosCreate(raw);
    if (!opts) return fail('参数错误');
    const emu = hosEmu();
    if (await hosNeedsLicense(emu)) return ok({ needLicense: true });
    await createHosAvd(emu, opts);
    invalidateHosAvdsCache();
    return ok({ created: true });
  });

  handle('hos:downloadImage', async (rawType: unknown, rawOs: unknown) => {
    const deviceType = parseHosText(rawType);
    const osVersion = parseHosText(rawOs);
    if (!deviceType || !osVersion) return fail('参数错误');
    const emu = hosEmu();
    if (await hosNeedsLicense(emu)) return ok({ started: false, key: '', needLicense: true });
    const key = hosImageKey(deviceType, osVersion);
    if (hosImageTasks.has(key)) return ok({ started: false, key });
    const task = adoptPercentTask({
      key,
      desc: `${hosDeviceLabel(deviceType)} · ${osVersion}`,
      cancel: () => hosImageTasks.get(key)?.kill(),
      onDone: (r) => {
        hosImageTasks.delete(key);
        if (!r.ok) {
          appendLog(loadAppSettings().dataRoot, `HarmonyOS 镜像下载失败：${r.error ?? '已取消'}`);
        }
      },
    });
    const child = installHosImage(
      emu,
      deviceType,
      osVersion,
      (percent) => task.progress(percent),
      (error) => (error ? task.fail(error) : task.complete()),
    );
    hosImageTasks.set(key, child);
    return ok({ started: true, key });
  });

  handle('hos:uninstallImage', async (rawType: unknown, rawOs: unknown) => {
    const deviceType = parseHosText(rawType);
    const osVersion = parseHosText(rawOs);
    if (!deviceType || !osVersion) return fail('参数错误');
    await uninstallHosImage(hosEmu(), deviceType, osVersion);
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

  // 后台抓取华为官方签名直链并直接下载，解压到已配置目录（没有则落到系统
  // 默认 HarmonyOS SDK 目录），完成后写设置并广播
  handle('huawei:downloadCenter', (rawDir?: unknown) => {
    const settings = loadAppSettings();
    const picked =
      typeof rawDir === 'string' && path.isAbsolute(rawDir) ? rawDir : '';
    const dir =
      picked ||
      settings.harmonySdkPath?.trim() ||
      path.join(os.homedir(), 'AppData', 'Local', 'Huawei', 'Sdk');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return fail('无法创建 HarmonyOS SDK 目录');
    }
    const proxy = proxyOf(settings, 'harmonyos');
    const kbps = Number(settings.maxDownloadKbps);
    return ok(
      startHarmonyDirectDownload({
        targetDir: dir,
        viaProxy: !!proxy,
        proxyPort: proxy?.port,
        maxBps: Number.isFinite(kbps) && kbps > 0 ? kbps * 1024 : 0,
        onDone: (r) => {
          if (r.ok) {
            saveAppSettings({ ...loadAppSettings(), harmonySdkPath: dir });
            appendLog(loadAppSettings().dataRoot, `HarmonyOS 命令行工具下载完成并落位：${dir}`);
            broadcast('env:changed', { kind: 'harmonyos' });
          }
        },
      }),
    );
  });

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
    const deleted = await clearAllAvds(settings.dataRoot);
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
    const failed = await factoryReset(settings.dataRoot);
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
    // 失败一律经 update:error 广播：UpdatePrompt 只信广播，避免 invoke
    // 返回 fail 但弹窗没人通知、卡在“下载中”
    if (!release) {
      broadcast('update:error', { message: '请先检查更新' });
      return fail('请先检查更新');
    }
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
    // 立即清空：退出被延迟时重复点击会 spawn 第二个安装器
    downloadedExePath = null;
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
    if (typeof pkg !== 'string') return fail('非法的包名');
    if (pkg.startsWith('hos-image:')) {
      const [deviceType, osVersion] = pkg.slice('hos-image:'.length).split('|');
      if (!deviceType || !osVersion) return fail('非法的包名');
      const uninstalled = await uninstallHosImage(hosEmu(), deviceType, osVersion).then(
        () => true,
        () => false,
      );
      return ok(removeFinished(pkg, Number(startedAt)) || uninstalled);
    }
    if (!PKG_RE.test(pkg)) return fail('非法的包名');
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
  handle('project:delete', async (id: string) =>
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
  handle('avd:setHardware', async (rawScope: unknown, name: string, rawHw: unknown, rawOpts?: unknown) => {
    const scope = parseScope(rawScope);
    if (!scope) return fail('非法的作用域');
    // qemu 退出时会用启动时的内存值回写 config.ini，运行中修改必被覆盖
    if (findRunning(scopeKey(scope), name))
      return fail('请先关闭虚拟机再修改硬件配置');
    const { sdk, settings } = status();
    const hardware = parseHardware(rawHw);
    const wipeData =
      typeof rawOpts === 'object' && rawOpts !== null && (rawOpts as { wipeData?: boolean }).wipeData === true;
    // 只改 config.ini 不会让 guest 的数据分区变大，扩容必须先处理镜像
    const targetGb = hardware.storageGb ? Math.round(hardware.storageGb) : undefined;
    const currentGb = getAvdHardware(settings.dataRoot, scope, name)?.storageGb;
    const grows = targetGb !== undefined && (currentGb === undefined || targetGb > Math.round(currentGb));
    if (wipeData && grows) {
      // 加密镜像无法原地扩容：落配置并标记，下次启动由模拟器 -wipe-data 按新容量重建
      const updated = updateAvdHardware(settings.dataRoot, scope, name, hardware);
      if (!updated.ok) return ok(updated);
      return ok(markAvdWipe(settings.dataRoot, scope, name));
    }
    // 缩容由 updateAvdHardware 统一拒绝；容量未变化（只改内存/核数）时不碰镜像，
    // 避免为了校验再拍平十几 GB 的覆盖层
    if (grows) {
      if (!sdk) return fail('未检测到 Android SDK');
      let grown: { ok: boolean; error?: string; needsWipe?: boolean };
      try {
        grown = await ensureAvdStorage(sdk, settings.dataRoot, scope, name, targetGb);
      } catch (e) {
        // 磁盘满、文件被占用等异常必须转成可读错误，否则渲染层会一直停在“保存中”
        grown = { ok: false, error: `扩容失败：${e instanceof Error ? e.message : String(e)}` };
      }
      if (!grown.ok) {
        if (grown.needsWipe) {
          // 交给渲染层弹确认框：用户同意后再带 wipeData 重新提交
          return { ok: false as const, error: grown.error ?? '数据分区无法原地扩容', needsWipe: true };
        }
        return fail(grown.error ?? '扩容失败');
      }
    }
    return ok(
      updateAvdHardware(settings.dataRoot, scope, name, hardware),
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
    // 自动补装已并入核心启动链路（Agent 桥启动同样生效）
    return ok({
      avdName: entry.avdName,
      port: entry.port,
      serial: entry.serial,
    });
  });
  handle('pill:action', async (rawSerial: unknown, rawAction: unknown) => {
    const { sdk, settings } = status();
    const serial = typeof rawSerial === 'string' ? rawSerial : '';
    if (
      typeof rawAction !== 'string' ||
      !PILL_ACTIONS.has(rawAction)
    ) {
      return fail('非法参数');
    }
    if (isHosPillSerial(serial)) {
      const result = await handleHosPillAction(
        settings.dataRoot,
        serial,
        rawAction as PillAction,
      );
      appendLog(
        settings.dataRoot,
        `HarmonyOS 药丸动作 ${rawAction}${result.ok ? '' : `失败：${result.error ?? '未知错误'}`}`,
      );
      return ok(result);
    }
    if (!sdk) return fail('未检测到 Android SDK');
    if (!serial.startsWith('emulator-')) return fail('非法参数');
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
    if (isHosPillSerial(serial)) return ok(startHosPillMove(serial));
    if (!serial.startsWith('emulator-')) return fail('非法参数');
    return ok(startPillMove(serial));
  });

  // ---------- 虚拟定位 ----------
  handle('pill:open-location', (rawSerial: unknown) => {
    const serial = typeof rawSerial === 'string' ? rawSerial : '';
    if (!isDeviceSerial(serial)) return fail('非法参数');
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
    if (!isDeviceSerial(serial)) return fail('非法参数');
    const c = sanitizeLocationConfig(rawConfig);
    if (!c.ok) return fail(c.error);
    if (isHosPillSerial(serial)) {
      let emu: string;
      try { emu = hosEmu(); } catch { return fail('未检测到 HarmonyOS 模拟器组件'); }
      const instance = hosPillName(serial);
      if (!instance) return fail('非法参数');
      const r = await startLocation(
        { adbPath: '', hosGps: { emu, instance } },
        serial,
        c.config,
      );
      appendLog(
        loadAppSettings().dataRoot,
        `虚拟定位启动 ${instance}（${c.config.mode}，${c.config.speedMps}m/s）`,
      );
      return r.ok ? ok(true) : fail(r.error ?? '启动失败');
    }
    const { sdk } = status();
    if (!sdk) return fail('未检测到 Android SDK');
    const r = await startLocation({ adbPath: sdk.adb }, serial, c.config);
    appendLog(
      loadAppSettings().dataRoot,
      `虚拟定位启动 ${serial}（${c.config.mode}，${c.config.speedMps}m/s）`,
    );
    return r.ok ? ok(true) : fail(r.error ?? '启动失败');
  });
  handle('location:stop', async (rawSerial: unknown) => {
    const serial = typeof rawSerial === 'string' ? rawSerial : '';
    if (!isDeviceSerial(serial)) return fail('非法参数');
    await stopLocation(serial);
    return ok(true);
  });
  handle('location:pause', (rawSerial: unknown, paused: unknown) => {
    if (typeof rawSerial !== 'string' || !isDeviceSerial(rawSerial) || typeof paused !== 'boolean')
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
      if (!isDeviceSerial(serial) || !keys.includes(rawKey as NudgeKey))
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
      if (!isDeviceSerial(serial) || !Number.isFinite(lat) || !Number.isFinite(lon))
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
    // 等 qemu 自行退出（快照保存大内存 AVD 可超 20 秒）再兜底强杀；
    // 按 serial 判断退出即可，不必每轮都经控制台反查 avd 名
    const matchSet = new Set(matches);
    let still = true;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const after = await adbDevices(sdk.adb).catch(() => []);
      still = after.some((d) => matchSet.has(d.serial));
      if (!still) break;
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
      const pillOn = loadAppSettings().pillEnabled !== false;
      for (const d of devices) {
        if (d.serial.startsWith('emulator-')) {
          const avdName = await avdNameCached(sdk.adb, d.serial);
          if (process.platform === 'win32' && d.state === 'device' && avdName && pillOn && !hasPill(d.serial)) {
            try {
              // 开机期窗口几何尚未就绪：失败后 60 秒内不重试，避免 3 秒轮询每次
              // 都 spawn PowerShell 查询（冷启动期间持续空转拖慢整机）
              const lastAttempt = pillRetryAt.get(d.serial) ?? 0;
              if (Date.now() - lastAttempt >= PILL_RETRY_MS) {
                pillRetryAt.set(d.serial, Date.now());
                const geom = await getShellGeometry(avdName);
                if (geom) await openPill({ ...geom, serial: d.serial, avdName });
              }
            } catch {
              // 外部 AVD 名可能超出可嵌入脚本的字符集：该设备跳过药丸，列表照常返回
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
      // 设备已消失但窗口组还在（守卫未生效或崩溃时的兜底）：刷新时同步回收。
      // adb 瞬时故障（server 重启/协议错误）可能返回空列表：还有在册实例时视为
      // adb 异常而非全部下线，跳过回收——否则一次抖动就会杀掉所有定位会话
      if (devices.length > 0 || listRunning().length === 0) {
        for (const serial of openGroupSerials()) {
          if (isHosPillSerial(serial)) continue;
          if (!result.some((r) => r.serial === serial)) {
            await stopLocation(serial).catch(() => undefined);
            closePill(serial);
            closeLocationPanel(serial);
          }
        }
        // 回收已下线设备的缓存（端口可能被新实例复用）
        for (const serial of [...avdNameCache.keys(), ...pillRetryAt.keys()]) {
          if (isHosPillSerial(serial)) continue;
          if (!result.some((r) => r.serial === serial)) {
            avdNameCache.delete(serial);
            pillRetryAt.delete(serial);
          }
        }
      }
    }
    // HarmonyOS 在线设备（hdc）与 adb 设备可并存；查询失败不影响 Android 列表
    const harmony = harmonyInfoCached();
    if (harmony) {
      // 3 秒轮询下结果缓存 5 秒（失败同样缓存）：hdc 服务挂起时每次 list targets
      // 都要等满 10s 超时，不能让每轮轮询都排队 spawn 一次
      const now = Date.now();
      const stale =
        !harmonyTargetsCache ||
        now - harmonyTargetsCache.at >= HARMONY_TARGETS_CACHE_MS;
      if (stale) {
        try {
          harmonyTargetsCache = {
            at: now,
            targets: await harmonyTargets(harmony.hdc),
          };
        } catch {
          harmonyTargetsCache = { at: now, targets: [] };
          // hdc 服务未起或无设备：忽略
        }
      }
      const cached = harmonyTargetsCache;
      if (cached) {
        for (const t of cached.targets) {
          if (!result.some((r) => r.serial === t)) {
            result.push({ serial: t, state: 'device', type: 'harmonyos' });
          }
        }
      }
    }
    const hos = await hosAvdsCached();
    if (hos) await syncHosPills(hos);
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

  handle('dialog:openZip', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择下载的 HarmonyOS 命令行工具压缩包',
      filters: [
        { name: '压缩包', extensions: ['zip'] },
        { name: '全部文件', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    return ok(r.canceled ? null : (r.filePaths[0] ?? null));
  });

  // 华为命令行工具无匿名直链：应用内下载页接管失败时，用户也可手动下载 zip
  // 再导入。包内布局（commandline-tools/...）不是标准 SDK 集结构，落位后
  // 递归找 hdc 验证，detectHarmony 对显式路径有同款兜底。
  handle('harmony:importZip', async (zipPath: unknown, rawDir: unknown) => {
    if (
      typeof zipPath !== 'string' ||
      !zipPath ||
      !/\.zip$/i.test(zipPath) ||
      !fs.existsSync(zipPath)
    ) {
      return fail('请选择下载的 .zip 压缩包');
    }
    const dir =
      typeof rawDir === 'string' && path.isAbsolute(rawDir) ? rawDir : '';
    if (!dir || !fs.existsSync(dir)) return fail('请选择解压目标目录');
    try {
      const hdc = await importCommandlineTools(zipPath, dir);
      saveAppSettings({ ...loadAppSettings(), harmonySdkPath: dir });
      broadcast('env:changed', { kind: 'harmonyos' });
      appendLog(loadAppSettings().dataRoot, `HarmonyOS 工具包导入落位：${dir}（hdc：${hdc}）`);
      return ok({ hdc });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
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
