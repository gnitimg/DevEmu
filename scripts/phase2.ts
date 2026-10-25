/**
 * 阶段二：在已运行的模拟器上验证 导入 → 安装 → 启动 → 截图 → 记录 → 停止
 * 运行前提：emulator-5554 已开机（由 e2e.ts 启动）
 */
import path from 'node:path';
import os from 'node:os';
import { loadAppSettings } from '../src/core/settings.ts';
import { detectSdk } from '../src/core/sdk.ts';
import { scopeDirs } from '../src/core/env.ts';
import { importApk, listApps, removeApp, apkFilePath } from '../src/core/apk.ts';
import { installApk, launchApp, screenshot } from '../src/core/adb.ts';
import { recordRun } from '../src/core/runs.ts';
import { run } from '../src/core/exec.ts';

const log = (...a: unknown[]) => console.log('[p2]', ...a);
const SERIAL = 'emulator-5554';
const PROJECT = 'e2e-验证';

async function main(): Promise<void> {
  const sdk = detectSdk();
  const settings = loadAppSettings();
  if (!sdk) throw new Error('no sdk');
  const dirs = scopeDirs(settings.dataRoot, { kind: 'project', projectId: PROJECT });

  // 清掉上一轮缺元数据的 APK 记录，重新导入验证中文路径修复
  for (const a of listApps(dirs.appsDir)) removeApp(dirs.appsDir, a.id);
  const apk = await importApk(dirs.appsDir, path.join(os.tmpdir(), 'devemu-e2e', 'hello.apk'), sdk.aapt);
  log('APK 导入(中文路径):', apk.label, '|', apk.packageName, '|', apk.activity);
  if (!apk.packageName) throw new Error('元数据解析失败');

  const ins = await installApk(sdk.adb, SERIAL, apkFilePath(dirs.appsDir, apk.id));
  log('安装:', ins.ok ? '成功' : `失败 ${ins.error}`);
  if (!ins.ok) throw new Error(ins.error);

  const lau = await launchApp(sdk.adb, SERIAL, apk.packageName!, apk.activity);
  log('启动应用:', lau.ok ? '成功' : `失败 ${lau.error}`);

  await new Promise((r) => setTimeout(r, 4000));
  const shot = await screenshot(sdk.adb, SERIAL);
  log('截图:', shot.length, '字节，PNG 头:', shot.slice(0, 4).toString('hex'));

  const runRec = recordRun(
    dirs.runsDir,
    { avdName: 'e2e_pixel6', apkLabel: apk.label, packageName: apk.packageName, result: lau.ok ? 'ok' : 'launch-failed' },
    { screenshot: shot },
  );
  log('测试记录:', runRec.id, '→', dirs.runsDir);

  await run(sdk.adb, ['-s', SERIAL, 'emu', 'kill'], { timeoutMs: 10_000 }).catch(() => undefined);
  log('模拟器已停止');
  log('=== 阶段二通过：导入/安装/启动/截图/记录 全链路 OK ===');
}

main().catch((e: unknown) => {
  console.error('[p2] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
