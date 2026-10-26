import { BrowserWindow, ipcMain, dialog, shell, app, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { loadAppSettings, saveAppSettings } from './core/settings.ts';
import { detectSdk, detectJava, listInstalledImages, runSdkmanager, listInstalledPkgs, parseSdkmanagerSections, SDK_PKG_GROUPS } from './core/sdk.ts';
import { probeSystemRoutes, type RouteProbe } from './core/net.ts';
import { detectHarmony, harmonyTargets, listHarmonyComponents, hdcInstall, hdcLaunch } from './core/harmony.ts';
import {
  checkEnvDir, resolveEnvPlan, installAndroidCmdtools, installJdk, ENV_LABELS, HARMONY_MANUAL_URL,
  type EnvKind,
} from './core/envinstall.ts';
import { importHap } from './core/hap.ts';
import { startDownload, startFileDownload, listDownloads, cancelDownload, removeFinished, onDownloadsChanged, initDownloadStore } from './core/downloads.ts';
import { listAvds, createAvd, deleteAvd, listDeviceDefs, updateAvdHardware, getAvdHardware, renameAvd, type AvdHardware } from './core/avd.ts';
import { launchEmulator, stopEmulator, findRunning } from './core/emulator.ts';
import { adbDevices, avdNameOf, installApk, launchApp, screenshot, clearData, uninstall, waitBooted } from './core/adb.ts';
import { run as runCmd } from './core/exec.ts';
import { importApk, listApps, removeApp, apkFilePath } from './core/apk.ts';
import { createProject, listProjects, updateProject, deleteProject } from './core/projects.ts';
import { recordRun, listRuns } from './core/runs.ts';
import { scopeDirs, scopeKey } from './core/env.ts';
import { killEmulatorProcess } from './core/win.ts';
import type { Scope } from './core/types.ts';

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
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(channel, payload);
  }
}

// 启动后自动补装结果广播
type AutoInstallResult = { id: string; label: string; ok: boolean; error?: string };
function broadcastAutoInstall(payload: { avdName: string; results: AutoInstallResult[] }): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send('apk:autoinstall', payload);
  }
}

// 设备启动完成后把该作用域库中的所有应用补装到设备，结果经 apk:autoinstall 广播
function autoInstallAfterBoot(scope: Scope, avdName: string, serial: string): void {
  void (async () => {
    try {
      const { sdk, settings } = status();
      if (!sdk) return;
      const apps = listApps(scopeDirs(settings.dataRoot, scope).appsDir).filter((a) => a.kind !== 'hap');
      if (apps.length === 0) return;
      const booted = await waitBooted(sdk.adb, serial, 300_000);
      if (!booted) return; // 启动超时或中途关闭：静默放弃
      const results: AutoInstallResult[] = [];
      for (const a of apps) {
        const r = await installApk(sdk.adb, serial, apkFilePath(scopeDirs(settings.dataRoot, scope).appsDir, a.id)).catch(
          (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }),
        );
        results.push({ id: a.id, label: a.label ?? a.fileName, ok: !!r.ok, error: r.ok ? undefined : r.error });
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
  if (w) (w.isMaximized() ? w.unmaximize() : w.maximize());
  return ok(true);
});
ipcMain.handle('win:close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
  return ok(true);
});
ipcMain.handle('win:isMaximized', (event) => {
  return ok(BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false);
});

function handle(channel: string, fn: (...args: never[]) => unknown): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const progress: ProgressFn = (line) => {
      if (!event.sender.isDestroyed()) event.sender.send('sdk:progress', line);
    };
    try {
      return await (fn as (...a: unknown[]) => unknown)(...args, progress);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}

// 作用域参数校验：projectId 不允许路径字符，防止逃逸
function parseScope(raw: unknown): Scope | null {
  if (raw && typeof raw === 'object') {
    const s = raw as { kind?: unknown; projectId?: unknown };
    if (s.kind === 'shared') return { kind: 'shared' };
    if (s.kind === 'project' && typeof s.projectId === 'string' && /^[^\\/]+$/.test(s.projectId)) {
      return { kind: 'project', projectId: s.projectId };
    }
  }
  return null;
}

function status() {
  const settings = loadAppSettings();
  return { settings, sdk: detectSdk(settings.sdkPath), java: detectJava(settings.javaPath) };
}

function adbAlias(sdk: NonNullable<ReturnType<typeof detectSdk>>): string {
  return sdk.adb;
}

/** 按系统取生效线路（缺省直连）；仅当选中“本地代理”且配了端口才走代理 */
function proxyOf(settings: { androidDownloadRoute?: 'direct' | 'proxy'; harmonyDownloadRoute?: 'direct' | 'proxy'; proxyPort?: number }, system: 'android' | 'harmonyos' = 'android'): { port: number } | undefined {
  const route = system === 'harmonyos' ? settings.harmonyDownloadRoute : settings.androidDownloadRoute;
  return route === 'proxy' && settings.proxyPort ? { port: settings.proxyPort } : undefined;
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
  return runSdkmanager(sdk, args, { javaPath: java, proxy: proxyOf(settings), onLine: progress });
}

/** 前端传来的硬件配置做数字与范围校验 */
function parseHardware(raw: unknown): AvdHardware {
  const hw: AvdHardware = {};
  const o = (raw ?? {}) as { ramMb?: unknown; cores?: unknown; storageGb?: number };
  const ram = Number(o.ramMb);
  if (Number.isFinite(ram) && ram >= 512 && ram <= 32768) hw.ramMb = Math.round(ram);
  const cores = Number(o.cores);
  if (Number.isFinite(cores) && cores >= 1 && cores <= 16) hw.cores = Math.round(cores);
  const disk = Number(o.storageGb);
  if (Number.isFinite(disk) && disk >= 1 && disk <= 256) hw.storageGb = Math.round(disk);
  return hw;
}

const ENV_KINDS: EnvKind[] = ['android', 'harmonyos', 'java'];
function parseEnvKind(raw: unknown): EnvKind | null {
  return typeof raw === 'string' && (ENV_KINDS as string[]).includes(raw) ? (raw as EnvKind) : null;
}

/** 环境安装共用的下载选项（限速/并行取自设置，线路按 Android 线路） */
function envDownloadOpts(settings: ReturnType<typeof loadAppSettings>) {
  const proxy = proxyOf(settings, 'android');
  const kbps = Number(settings.maxDownloadKbps);
  return {
    proxy,
    maxBps: Number.isFinite(kbps) && kbps > 0 ? kbps * 1024 : 0,
    parallel: settings.parallelDownloads,
    upstreamPort: settings.androidDownloadRoute === 'proxy' && settings.proxyPort ? settings.proxyPort : undefined,
  };
}

/**
 * Android 命令行工具就位后链式补装核心组件：先静默接受许可，
 * 再把 platform-tools 与 emulator 排入下载队列（完成后 adb/emulator 齐备，SDK 才算可用）。
 */
async function chainAndroidComponents(dir: string, settings: ReturnType<typeof loadAppSettings>): Promise<void> {
  const sm = path.join(dir, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat');
  if (!fs.existsSync(sm)) throw new Error('cmdline-tools 未就位');
  const java = detectJava(settings.javaPath);
  if (!java) {
    throw new Error('未检测到 Java：请先在“Java 路径”一行配置或安装 Java，然后重新选择 SDK 目录以补装组件');
  }
  // sdkmanager 首次安装会逐条询问许可；一次性喂入足量 y（已全部接受时立即退出）
  await runCmd(sm, [`--sdk_root=${dir}`, '--licenses'], { stdin: 'y\n'.repeat(24), timeoutMs: 180_000 }).catch(() => undefined);
  const dl = envDownloadOpts(settings);
  const lite = { root: dir, sdkmanager: sm }; // startDownload 仅用到 root 与 sdkmanager
  await startDownload(lite, java, dl.proxy, 'platform-tools', 'platform-tools', undefined, {
    parallel: dl.parallel, maxBps: dl.maxBps, upstreamPort: dl.upstreamPort,
  });
  await startDownload(lite, java, dl.proxy, 'emulator', 'emulator', undefined, {
    parallel: dl.parallel, maxBps: dl.maxBps, upstreamPort: dl.upstreamPort,
  });
}

export function registerIpc(): void {
  initDownloadStore(loadAppSettings().dataRoot);
  handle('env:status', () => {
    const settings = loadAppSettings();
    const sdk = detectSdk(settings.sdkPath);
    const java = detectJava(settings.javaPath);
    const harmony = detectHarmony(settings.harmonySdkPath);
    return ok({ settings, sdk, java, harmony, version: app.getVersion(), images: sdk ? listInstalledImages(sdk.root) : [] });
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
    if (!scanned.some((c) => path.resolve(c.dir) === resolved)) return fail('该目录不是已安装的组件');
    fs.rmSync(resolved, { recursive: true, force: true });
    return ok(true);
  });

  handle('open:url', (url: unknown) => {
    if (typeof url !== 'string' || !/^https:\/\/[\w.-]+/i.test(url)) return fail('仅支持 https 链接');
    void shell.openExternal(url);
    return ok(true);
  });

  handle('settings:save', (raw: unknown) => {
    const s = raw as {
      dataRoot?: string;
      sdkPath?: string;
      javaPath?: string;
      harmonySdkPath?: string;
      gpuMode?: string;
      proxyEnabled?: boolean;
      proxyPort?: number;
      androidDownloadRoute?: string;
      harmonyDownloadRoute?: string;
      maxDownloadKbps?: number;
      parallelDownloads?: number;
    };
    if (!s.dataRoot || typeof s.dataRoot !== 'string') return fail('数据根不能为空');
    const gpu = s.gpuMode && ['angle_indirect', 'swiftshader_indirect', 'host'].includes(s.gpuMode) ? s.gpuMode : undefined;
    const harmonyPath =
      typeof s.harmonySdkPath === 'string' && s.harmonySdkPath.trim() && !/[<>"|?*]/.test(s.harmonySdkPath)
        ? s.harmonySdkPath.trim()
        : undefined;
    const port = Number(s.proxyPort);
    const proxyPort = Number.isFinite(port) && port >= 1 && port <= 65535 ? Math.round(port) : undefined;
    const routeOf = (v: unknown) => (v === 'proxy' || v === 'direct' ? v : undefined);
    const kbps = Number(s.maxDownloadKbps);
    const parallel = Number(s.parallelDownloads);
    saveAppSettings({
      dataRoot: s.dataRoot,
      sdkPath: s.sdkPath,
      javaPath: s.javaPath,
      harmonySdkPath: harmonyPath,
      gpuMode: gpu,
      proxyEnabled: s.proxyEnabled === true,
      proxyPort,
      androidDownloadRoute: routeOf(s.androidDownloadRoute),
      harmonyDownloadRoute: routeOf(s.harmonyDownloadRoute),
      maxDownloadKbps: Number.isFinite(kbps) && kbps >= 0 ? Math.round(kbps) : undefined,
      parallelDownloads:
        Number.isFinite(parallel) && parallel >= 1 && parallel <= 4 ? Math.round(parallel) : undefined,
    });
    return ok(loadAppSettings());
  });

  handle('settings:probe', async (rawSystem: unknown) => {
    const system = rawSystem === 'harmonyos' ? 'harmonyos' : 'android';
    const { settings } = status();
    const results: RouteProbe[] = await probeSystemRoutes(system, settings.proxyEnabled ? settings.proxyPort : undefined);
    return ok(results);
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
      return ok({ manual: true, url: HARMONY_MANUAL_URL, label: ENV_LABELS[kind] });
    }
    const settings = loadAppSettings();
    if (!fs.existsSync(dir)) return fail('所选目录不存在');
    const dl = envDownloadOpts(settings);
    let plan;
    try {
      plan = await resolveEnvPlan(kind, { viaProxy: !!dl.proxy, proxyPort: dl.proxy?.port });
    } catch (err) {
      return fail(`解析官方最新版失败：${err instanceof Error ? err.message : String(err)}`);
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
    return ok({ manual: false, key: plan.key, desc: plan.desc, label: ENV_LABELS[kind] });
  });

  handle('app:checkUpdate', async () => {
    const current = app.getVersion();
    try {
      const res = await fetch('https://api.github.com/repos/gnitimg/DevEmu/releases/latest', {
        headers: { 'User-Agent': `DevEmu/${current}` },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return fail(res.status === 404 ? '仓库暂无发布版本' : `检查更新失败（HTTP ${res.status}）`);
      const j = (await res.json()) as { tag_name?: string; html_url?: string };
      if (!j.tag_name) return fail('未获取到发布信息');
      const latest = j.tag_name.replace(/^v/, '');
      return ok({
        latest,
        current,
        upToDate: latest === current,
        url: j.html_url ?? 'https://github.com/gnitimg/DevEmu/releases',
      });
    } catch {
      return fail('检查更新失败（无法访问 GitHub）');
    }
  });

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
    if (res.code !== 0) return fail('sdkmanager 执行失败：' + (res.stderr || res.stdout).slice(0, 300));
    return ok(parseSdkmanagerSections(res.stdout).available.filter((e) => SDK_PKG_GROUPS.test(e.pkg)));
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
        settings.androidDownloadRoute === 'proxy' && settings.proxyPort ? settings.proxyPort : undefined,
    };
    const r = await startDownload(sdk, java, proxyOf(settings), pkg, pkg, progress, dlOpts);
    if (!r.ok) return fail(r.error ?? '安装失败');
    return ok(true);
  });

  handle('downloads:list', () => ok(listDownloads()));
  handle('downloads:cancel', (pkg: string) => ok(cancelDownload(pkg)));
  handle('downloads:remove', (pkg: string, startedAt: number) => ok(removeFinished(pkg, Number(startedAt))));

  handle('sdk:uninstall', async (pkg: string, progress?: ProgressFn) => {
    const { settings, java } = status();
    if (typeof pkg !== 'string' || !PKG_RE.test(pkg)) return fail('非法的包名');
    const res = await sdkRun(settings, java, ['--uninstall', pkg], progress);
    if (!res) return fail('SDK 缺少 cmdline-tools');
    if (res.code !== 0) return fail('卸载失败：' + (res.stderr || res.stdout).trim().split(/\r?\n/).pop());
    return ok(true);
  });

  handle('project:list', () => ok(listProjects(loadAppSettings().dataRoot)));
  handle('project:create', (name: string, note?: string) => {
    if (!name?.trim()) return fail('项目名不能为空');
    return ok(createProject(loadAppSettings().dataRoot, name, note));
  });
  handle('project:update', (id: string, patch: { name?: string; note?: string }) =>
    ok(updateProject(loadAppSettings().dataRoot, id, patch)),
  );
  handle('project:delete', (id: string) => ok(deleteProject(loadAppSettings().dataRoot, id)));

  handle('avd:list', (rawScope: unknown) => {
    const scope = parseScope(rawScope);
    if (!scope) return fail('非法的作用域');
    return ok(listAvds(loadAppSettings().dataRoot, scope));
  });
  handle('avd:create', async (rawScope: unknown, name: string, imagePkg: string, deviceDefId: string, hw?: unknown) => {
    const scope = parseScope(rawScope);
    const { sdk, java, settings } = status();
    if (!scope) return fail('非法的作用域');
    if (!sdk) return fail('未检测到 Android SDK，请到设置页配置');
    if (!/^[\w.-]{1,50}$/.test(name)) return fail('虚拟机名称仅限字母、数字、下划线、点、短横线');
    const hardware = parseHardware(hw);
    return ok(await createAvd(sdk, settings.dataRoot, scope, name, imagePkg, deviceDefId, java, hardware));
  });
  handle('avd:hardware', (rawScope: unknown, name: string) => {
    const scope = parseScope(rawScope);
    if (!scope) return fail('非法的作用域');
    return ok(getAvdHardware(loadAppSettings().dataRoot, scope, name));
  });
  handle('avd:setHardware', (rawScope: unknown, name: string, hw: unknown) => {
    const scope = parseScope(rawScope);
    if (!scope) return fail('非法的作用域');
    return ok(updateAvdHardware(loadAppSettings().dataRoot, scope, name, parseHardware(hw)));
  });
  handle('avd:rename', (rawScope: unknown, oldName: string, newName: string) => {
    const scope = parseScope(rawScope);
    if (!scope) return fail('非法的作用域');
    if (findRunning(scopeKey(scope), oldName)) return fail('请先关闭虚拟机再重命名');
    return ok(renameAvd(loadAppSettings().dataRoot, scope, oldName, newName));
  });
  handle('avd:delete', async (rawScope: unknown, name: string) => {
    const scope = parseScope(rawScope);
    const { sdk, java, settings } = status();
    if (!scope || !sdk) return fail('未检测到 Android SDK');
    return ok(await deleteAvd(sdk, settings.dataRoot, scope, name, java));
  });
  handle('avd:deviceDefs', async () => {
    const { sdk, java } = status();
    if (!sdk) return fail('未检测到 Android SDK');
    return ok(await listDeviceDefs(sdk, java));
  });

  handle('emu:launch', async (rawScope: unknown, avdName: string) => {
    const scope = parseScope(rawScope);
    const { sdk, settings } = status();
    if (!scope || !sdk) return fail('未检测到 Android SDK');
    const gpu = settings.gpuMode ?? (process.platform === 'win32' ? 'swiftshader_indirect' : undefined);
    const httpProxy =
      settings.proxyEnabled && settings.proxyPort ? `http://127.0.0.1:${settings.proxyPort}` : undefined;
    const entry = await launchEmulator(sdk, settings.dataRoot, scope, avdName, { gpu, httpProxy });
    autoInstallAfterBoot(scope, avdName, entry.serial);
    return ok({ avdName: entry.avdName, port: entry.port, serial: entry.serial });
  });
  handle('emu:stop', async (rawScope: unknown, avdName: string) => {
    const scope = parseScope(rawScope);
    if (!scope) return fail('非法的作用域');
    const { sdk } = status();
    if (!sdk) return fail('未检测到 Android SDK');
    const entry = findRunning(scopeKey(scope), avdName);
    if (entry) {
      await stopEmulator(sdk, entry);
      return ok(true);
    }
    // 注册表丢失（应用重启过）：按 adb 设备兜底，先优雅后强杀
    const devices = await adbDevices(sdk.adb);
    const matches: string[] = [];
    for (const d of devices) {
      if (!d.serial.startsWith('emulator-') || d.state !== 'device') continue;
      if ((await avdNameOf(sdk.adb, d.serial)) === avdName) matches.push(d.serial);
    }
    if (matches.length === 0) return fail('该虚拟机未在运行');
    for (const serial of matches) {
      await runCmd(adbAlias(sdk), ['-s', serial, 'emu', 'kill'], { timeoutMs: 8000 }).catch(() => undefined);    }
    await new Promise((r) => setTimeout(r, 3000));
    const after = await adbDevices(sdk.adb);
    let still = false;
    for (const d of after) {
      if (!d.serial.startsWith('emulator-') || d.state !== 'device') continue;
      if ((await avdNameOf(sdk.adb, d.serial)) === avdName) still = true;
    }
    if (still) await killEmulatorProcess(avdName);
    return ok(true);
  });
  handle('emu:list', async () => {
    const { sdk } = status();
    const result: { serial: string; state: string; avdName?: string; type: 'android' | 'harmonyos' }[] = [];
    if (sdk) {
      const devices = await adbDevices(sdk.adb);
      for (const d of devices) {
        if (d.serial.startsWith('emulator-')) {
          result.push({ ...d, avdName: await avdNameOf(sdk.adb, d.serial), type: 'android' });
        }
      }
    }
    // HarmonyOS 在线设备（hdc）与 adb 设备可并存；查询失败不影响 Android 列表
    const harmony = detectHarmony(loadAppSettings().harmonySdkPath);
    if (harmony) {
      try {
        for (const t of await harmonyTargets(harmony.hdc)) {
          if (!result.some((r) => r.serial === t)) {
            result.push({ serial: t, state: 'device', type: 'harmonyos' });
          }
        }
      } catch {
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
    return ok(r.canceled ? null : r.filePaths[0] ?? null);
  });

  handle('dialog:openDir', async (title: string) => {
    const r = await dialog.showOpenDialog({
      title: typeof title === 'string' && title ? title : '选择文件夹',
      properties: ['openDirectory'],
    });
    return ok(r.canceled ? null : r.filePaths[0] ?? null);
  });

  handle('apk:import', async (rawScope: unknown, filePath: string) => {
    const scope = parseScope(rawScope);
    if (!scope) return fail('非法的作用域');
    const { sdk, settings } = status();
    const dirs = scopeDirs(settings.dataRoot, scope);
    if (/\.hap$/i.test(filePath)) return ok(await importHap(dirs.appsDir, filePath));
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

  handle('test:install', async (rawScope: unknown, apkId: string, serial: string) => {
    const scope = parseScope(rawScope);
    const { sdk, settings } = status();
    if (!scope) return fail('非法的作用域');
    const dirs = scopeDirs(settings.dataRoot, scope);
    const meta = listApps(dirs.appsDir).find((a) => a.id === apkId);
    if (!meta) return fail('应用不存在');
    if (meta.kind === 'hap') {
      const harmony = detectHarmony(settings.harmonySdkPath);
      if (!harmony) return fail('未检测到 HarmonyOS SDK');
      return ok(await hdcInstall(harmony.hdc, serial, path.join(dirs.appsDir, `${apkId}.hap`)));
    }
    if (!sdk) return fail('未检测到 Android SDK');
    const booted = await waitBooted(sdk.adb, serial, 300_000);
    if (!booted) return fail('设备启动超时（5 分钟），未能完成安装');
    return ok(await installApk(sdk.adb, serial, apkFilePath(dirs.appsDir, apkId)));
  });

  handle('test:launch', async (rawScope: unknown, apkId: string, serial: string) => {
    const scope = parseScope(rawScope);
    const { sdk, settings } = status();
    if (!scope) return fail('非法的作用域');
    const dirs = scopeDirs(settings.dataRoot, scope);
    const meta = listApps(dirs.appsDir).find((a) => a.id === apkId);
    if (!meta?.packageName) return fail('该应用缺少包名信息，无法启动');
    if (meta.kind === 'hap') {
      const harmony = detectHarmony(settings.harmonySdkPath);
      if (!harmony) return fail('未检测到 HarmonyOS SDK');
      return ok(await hdcLaunch(harmony.hdc, serial, meta.packageName, meta.activity ?? 'EntryAbility'));
    }
    if (!sdk) return fail('未检测到 Android SDK');
    return ok(await launchApp(sdk.adb, serial, meta.packageName, meta.activity));
  });

  handle('test:screenshot', async (serial: string) => {
    const { sdk } = status();
    if (!sdk) return fail('未检测到 Android SDK');
    const buf = await screenshot(sdk.adb, serial);
    return ok(buf.toString('base64'));
  });

  handle('test:logcat', async (serial: string) => {
    const { sdk } = status();
    if (!sdk) return fail('未检测到 Android SDK');
    const res = await runCmd(sdk.adb, ['-s', serial, 'logcat', '-d', '-t', '600'], { timeoutMs: 20_000 });
    return ok(res.stdout);
  });

  handle('test:clearData', async (rawScope: unknown, apkId: string, serial: string) => {
    const scope = parseScope(rawScope);
    const { sdk, settings } = status();
    if (!scope || !sdk) return fail('未检测到 Android SDK');
    const dirs = scopeDirs(settings.dataRoot, scope);
    const meta = listApps(dirs.appsDir).find((a) => a.id === apkId);
    if (!meta?.packageName) return fail('该 APK 缺少包名信息');
    return ok(await clearData(sdk.adb, serial, meta.packageName));
  });

  handle('test:uninstall', async (rawScope: unknown, apkId: string, serial: string) => {
    const scope = parseScope(rawScope);
    const { sdk, settings } = status();
    if (!scope || !sdk) return fail('未检测到 Android SDK');
    const dirs = scopeDirs(settings.dataRoot, scope);
    const meta = listApps(dirs.appsDir).find((a) => a.id === apkId);
    if (!meta?.packageName) return fail('该 APK 缺少包名信息');
    return ok(await uninstall(sdk.adb, serial, meta.packageName));
  });

  handle('run:record', async (rawScope: unknown, payload: unknown) => {
    const scope = parseScope(rawScope);
    const { sdk, settings } = status();
    if (!scope || !sdk) return fail('未检测到 Android SDK');
    const p = payload as { avdName: string; serial: string; apkId?: string; result: string; note?: string };
    const dirs = scopeDirs(settings.dataRoot, scope);
    const meta = p.apkId ? listApps(dirs.appsDir).find((a) => a.id === p.apkId) : undefined;
    let shot: Buffer | undefined;
    let log: string | undefined;
    try {
      shot = await screenshot(sdk.adb, p.serial);
    } catch {
      // 截图失败不阻塞记录
    }
    try {
      const res = await runCmd(sdk.adb, ['-s', p.serial, 'logcat', '-d', '-t', '800'], { timeoutMs: 20_000 });
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
        result: (['ok', 'install-failed', 'launch-failed', 'manual'] as const).includes(p.result as never)
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
}
