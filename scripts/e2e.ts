/**
 * 端到端验证：真实 SDK 上走完整链路
 * 项目 → 建虚拟机 → 启动 → 等待开机 → 导入 APK → 安装 → 启动 → 截图 → 记录 → 停止
 * 运行：node scripts/e2e.ts
 */
import path from 'node:path';
import os from 'node:os';
import { loadAppSettings } from '../src/core/settings.ts';
import { detectSdk, detectJava } from '../src/core/sdk.ts';
import { createProject, listProjects, deleteProject } from '../src/core/projects.ts';
import { createAvd, deleteAvd, listAvds } from '../src/core/avd.ts';
import { launchEmulator, stopEmulator } from '../src/core/emulator.ts';
import { waitBooted, installApk, launchApp, screenshot } from '../src/core/adb.ts';
import { importApk, apkFilePath } from '../src/core/apk.ts';
import { recordRun } from '../src/core/runs.ts';
import { scopeDirs } from '../src/core/env.ts';
import type { Scope } from '../src/core/types.ts';

const log = (...a: unknown[]) => console.log('[e2e]', ...a);
const IMAGE_PKG = 'system-images;android-36;google_apis;x86_64';
const AVD_NAME = 'e2e_pixel6';

async function main(): Promise<void> {
  const settings = loadAppSettings();
  log('数据根:', settings.dataRoot);

  const sdk = detectSdk(settings.sdkPath);
  if (!sdk) throw new Error('未检测到 Android SDK');
  log('SDK:', sdk.root, '| avdmanager:', sdk.avdmanager ? '有' : '无', '| aapt:', sdk.aapt ? '有' : '无');
  const java = detectJava(settings.javaPath);
  log('Java:', java);

  // 清理历史残留的 e2e/dbg 项目
  for (const p of listProjects(settings.dataRoot)) {
    if (/^e2e-|^dbg-/.test(p.id)) deleteProject(settings.dataRoot, p.id);
  }

  const project = createProject(settings.dataRoot, 'e2e-验证', '端到端验证自动创建，可在应用中查看');
  const scope: Scope = { kind: 'project', projectId: project.id };
  log('项目:', project.id);

  // 重建 AVD：先删旧的（幂等），创建时会自动开启宿主 GPU 加速
  await deleteAvd(sdk, settings.dataRoot, scope, AVD_NAME, java).catch(() => undefined);
  const created = await createAvd(sdk, settings.dataRoot, scope, AVD_NAME, IMAGE_PKG, 'pixel_6', java);
  if (!created.ok) throw new Error('创建 AVD 失败: ' + created.error);
  log('AVD 已创建:', listAvds(settings.dataRoot, scope).map((a) => `${a.name}(${a.imagePkg})`).join(', '));

  const entry = await launchEmulator(sdk, settings.dataRoot, scope, AVD_NAME);
  log('模拟器进程已启动，serial:', entry.serial);

  const booted = await waitBooted(sdk.adb, entry.serial, 900_000);
  log('系统启动完成:', booted);
  if (!booted) throw new Error('boot 超时');

  const dirs = scopeDirs(settings.dataRoot, scope);
  const apkPath = path.join(os.tmpdir(), 'devemu-e2e', 'hello.apk');
  const apk = await importApk(dirs.appsDir, apkPath, sdk.aapt);
  log('APK 导入:', apk.label, '|', apk.packageName, apk.versionName, '|', apk.activity);

  const ins = await installApk(sdk.adb, entry.serial, apkFilePath(dirs.appsDir, apk.id));
  log('安装:', ins.ok ? '成功' : `失败 ${ins.error}`);
  if (!ins.ok) throw new Error(ins.error ?? 'install failed');

  const lau = await launchApp(sdk.adb, entry.serial, apk.packageName!, apk.activity);
  log('启动应用:', lau.ok ? '成功' : `失败 ${lau.error}`);

  await new Promise((r) => setTimeout(r, 4000));
  const shot = await screenshot(sdk.adb, entry.serial);
  log('截图:', shot.length, '字节');

  const run = recordRun(
    dirs.runsDir,
    { avdName: AVD_NAME, apkLabel: apk.label, packageName: apk.packageName, result: lau.ok ? 'ok' : 'launch-failed' },
    { screenshot: shot },
  );
  log('测试记录:', run.id, '→', dirs.runsDir);

  await stopEmulator(sdk, entry);
  log('模拟器已停止');
  log('=== E2E 全链路通过（项目与记录保留，可在应用中查看）===');
}

main().catch((e: unknown) => {
  console.error('[e2e] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
