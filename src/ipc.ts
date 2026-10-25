import { BrowserWindow, ipcMain, dialog, type IpcMainInvokeEvent } from 'electron';
import { loadAppSettings, saveAppSettings } from './core/settings.ts';
import { detectSdk, detectJava, listInstalledImages, runSdkmanager, listInstalledPkgs, parseSdkmanagerSections, SDK_PKG_GROUPS } from './core/sdk.ts';
import { probeRoutes, type RouteProbe } from './core/net.ts';
import { detectHarmony, harmonyTargets } from './core/harmony.ts';
import { startDownload, listDownloads, cancelDownload, onDownloadsChanged } from './core/downloads.ts';
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
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send('downloads:changed', snap);
  }
});

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
      const apps = listApps(scopeDirs(settings.dataRoot, scope).appsDir);
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

function proxyOf(settings: { downloadRoute?: 'direct' | 'proxy'; proxyPort?: number }): { port: number } | undefined {
  return settings.downloadRoute === 'proxy' && settings.proxyPort ? { port: settings.proxyPort } : undefined;
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
  const o = (raw ?? {}) as { ramMb?: unknown; cores?: unknown; storageGb?: unknown };
  const ram = Number(o.ramMb);
  if (Number.isFinite(ram) && ram >= 512 && ram <= 32768) hw.ramMb = Math.round(ram);
  const cores = Number(o.cores);
  if (Number.isFinite(cores) && cores >= 1 && cores <= 16) hw.cores = Math.round(cores);
  const disk = Number(o.storageGb);
  if (Number.isFinite(disk) && disk >= 1 && disk <= 256) hw.storageGb = Math.round(disk);
  return hw;
}

export function registerIpc(): void {
  handle('env:status', () => {
    const settings = loadAppSettings();
    const sdk = detectSdk(settings.sdkPath);
    const java = detectJava(settings.javaPath);
    const harmony = detectHarmony(settings.harmonySdkPath);
    return ok({ settings, sdk, java, harmony, images: sdk ? listInstalledImages(sdk.root) : [] });
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

  handle('settings:save', (raw: unknown) => {
    const s = raw as {
      dataRoot?: string;
      sdkPath?: string;
      javaPath?: string;
      harmonySdkPath?: string;
      gpuMode?: string;
      proxyEnabled?: boolean;
      proxyPort?: number;
      downloadRoute?: string;
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
    const route = s.downloadRoute === 'proxy' || s.downloadRoute === 'direct' ? s.downloadRoute : undefined;
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
      downloadRoute: route,
      maxDownloadKbps: Number.isFinite(kbps) && kbps >= 0 ? Math.round(kbps) : undefined,
      parallelDownloads:
        Number.isFinite(parallel) && parallel >= 1 && parallel <= 4 ? Math.round(parallel) : undefined,
    });
    return ok(loadAppSettings());
  });

  handle('settings:probe', async () => {
    const { settings } = status();
    const results: RouteProbe[] = await probeRoutes(settings.proxyEnabled ? settings.proxyPort : undefined);
    // 自动选择：延迟低者胜，全失败保持直连
    const usable = results.filter((r) => r.latencyMs >= 0);
    if (usable.length > 0) {
      const best = usable.reduce((a, b) => (a.latencyMs <= b.latencyMs ? a : b));
      saveAppSettings({ ...loadAppSettings(), downloadRoute: best.name === '代理' ? 'proxy' : 'direct' });
    }
    return ok({ routes: results, chosen: loadAppSettings().downloadRoute });
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
        settings.downloadRoute === 'proxy' && settings.proxyPort ? settings.proxyPort : undefined,
    };
    const r = await startDownload(sdk, java, proxyOf(settings), pkg, pkg, progress, dlOpts);
    if (!r.ok) return fail(r.error ?? '安装失败');
    return ok(true);
  });

  handle('downloads:list', () => ok(listDownloads()));
  handle('downloads:cancel', (pkg: string) => ok(cancelDownload(pkg)));

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
    if (!sdk) return ok([]);
    const devices = await adbDevices(sdk.adb);
    const result = [];
    for (const d of devices) {
      if (d.serial.startsWith('emulator-')) {
        result.push({ ...d, avdName: await avdNameOf(sdk.adb, d.serial) });
      }
    }
    return ok(result);
  });

  handle('dialog:openApk', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择 APK',
      filters: [{ name: 'APK', extensions: ['apk'] }],
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
    if (!scope || !sdk) return fail('未检测到 Android SDK');
    const dirs = scopeDirs(settings.dataRoot, scope);
    const meta = listApps(dirs.appsDir).find((a) => a.id === apkId);
    if (!meta) return fail('APK 不存在');
    const booted = await waitBooted(sdk.adb, serial, 300_000);
    if (!booted) return fail('设备启动超时（5 分钟），未能完成安装');
    return ok(await installApk(sdk.adb, serial, apkFilePath(dirs.appsDir, apkId)));
  });

  handle('test:launch', async (rawScope: unknown, apkId: string, serial: string) => {
    const scope = parseScope(rawScope);
    const { sdk, settings } = status();
    if (!scope || !sdk) return fail('未检测到 Android SDK');
    const dirs = scopeDirs(settings.dataRoot, scope);
    const meta = listApps(dirs.appsDir).find((a) => a.id === apkId);
    if (!meta?.packageName) return fail('该 APK 缺少包名信息，无法启动');
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
