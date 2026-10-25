import { ipcMain, dialog } from 'electron';
import { loadAppSettings, saveAppSettings } from './core/settings.ts';
import { detectSdk, detectJava, listInstalledImages, runSdkmanager, parseSdkmanagerList } from './core/sdk.ts';
import { listAvds, createAvd, deleteAvd, listDeviceDefs } from './core/avd.ts';
import { launchEmulator, stopEmulator, findRunning } from './core/emulator.ts';
import { adbDevices, avdNameOf, installApk, launchApp, screenshot, clearData, uninstall, waitBooted } from './core/adb.ts';
import { run as runCmd } from './core/exec.ts';
import { importApk, listApps, removeApp, apkFilePath } from './core/apk.ts';
import { createProject, listProjects, updateProject, deleteProject } from './core/projects.ts';
import { recordRun, listRuns } from './core/runs.ts';
import { scopeDirs, scopeKey } from './core/env.ts';
import type { Scope } from './core/types.ts';

function ok<T>(data: T) {
  return { ok: true as const, data };
}
function fail(error: string) {
  return { ok: false as const, error };
}

function handle(channel: string, fn: (...args: never[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await (fn as (...a: unknown[]) => unknown)(...args);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}

/** 作用域参数校验：projectId 不允许路径字符，防止逃逸 */
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

export function registerIpc(): void {
  handle('env:status', () => {
    const settings = loadAppSettings();
    const sdk = detectSdk(settings.sdkPath);
    const java = detectJava(settings.javaPath);
    return ok({ settings, sdk, java, images: sdk ? listInstalledImages(sdk.root) : [] });
  });

  handle('settings:save', (raw: unknown) => {
    const s = raw as { dataRoot?: string; sdkPath?: string; javaPath?: string };
    if (!s.dataRoot || typeof s.dataRoot !== 'string') return fail('数据根不能为空');
    saveAppSettings({ dataRoot: s.dataRoot, sdkPath: s.sdkPath, javaPath: s.javaPath });
    return ok(loadAppSettings());
  });

  handle('sdk:availableImages', async () => {
    const { sdk, java } = status();
    if (!sdk?.sdkmanager) {
      return fail('SDK 缺少 cmdline-tools，无法列出可下载镜像。可在 Android Studio 的 SDK Manager 中安装');
    }
    const res = await runSdkmanager(sdk, ['--list'], { javaPath: java });
    if (res.code !== 0) return fail('sdkmanager 执行失败：' + (res.stderr || res.stdout).slice(0, 300));
    return ok(parseSdkmanagerList(res.stdout).filter((e) => /x86_64|arm64-v8a/.test(e.pkg)));
  });

  handle('sdk:downloadImage', async (pkg: string) => {
    const { sdk, java } = status();
    if (!sdk?.sdkmanager) return fail('SDK 缺少 cmdline-tools');
    if (typeof pkg !== 'string' || !/^system-images;[\w.-]+$/.test(pkg)) return fail('非法的镜像包名');
    const res = await runSdkmanager(sdk, [pkg], { javaPath: java });
    if (res.code !== 0) return fail('下载失败：' + (res.stderr || res.stdout).trim().split(/\r?\n/).pop());
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
  handle('avd:create', async (rawScope: unknown, name: string, imagePkg: string, deviceDefId: string) => {
    const scope = parseScope(rawScope);
    const { sdk, java, settings } = status();
    if (!scope) return fail('非法的作用域');
    if (!sdk) return fail('未检测到 Android SDK，请到设置页配置');
    if (!/^[\w.-]{1,50}$/.test(name)) return fail('虚拟机名称仅限字母、数字、下划线、点、短横线');
    return ok(await createAvd(sdk, settings.dataRoot, scope, name, imagePkg, deviceDefId, java));
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
    const entry = await launchEmulator(sdk, settings.dataRoot, scope, avdName);
    return ok({ avdName: entry.avdName, port: entry.port, serial: entry.serial });
  });
  handle('emu:stop', async (rawScope: unknown, avdName: string) => {
    const scope = parseScope(rawScope);
    if (!scope) return fail('非法的作用域');
    const entry = findRunning(scopeKey(scope), avdName);
    if (!entry) return fail('该虚拟机未在运行');
    const { sdk } = status();
    if (!sdk) return fail('未检测到 Android SDK');
    await stopEmulator(sdk, entry);
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
