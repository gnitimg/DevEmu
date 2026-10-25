/** 验证运行状态检测：启动 → adbDevices+avdNameOf（emu:list 同款逻辑）→ 关闭 */
import { loadAppSettings } from '../src/core/settings.ts';
import { detectSdk } from '../src/core/sdk.ts';
import { launchEmulator, findRunning } from '../src/core/emulator.ts';
import { adbDevices, avdNameOf, waitBooted } from '../src/core/adb.ts';
import { run } from '../src/core/exec.ts';

const settings = loadAppSettings();
const sdk = detectSdk(settings.sdkPath)!;
const SCOPE = { kind: 'project' as const, projectId: 'aaa' };

const entry = await launchEmulator(sdk, settings.dataRoot, SCOPE, 'dg');
console.log('[t] launched serial=', entry.serial, 'inRegistry=', !!findRunning('project:aaa', 'dg'));

const booted = await waitBooted(sdk.adb, entry.serial, 480_000);
console.log('[t] boot=', booted);

// 与 ipc emu:list 完全一致的检测逻辑
const devices = await adbDevices(sdk.adb);
console.log('[t] devices:', devices.map((d) => `${d.serial}:${d.state}`).join(' '));
for (const d of devices) {
  if (!d.serial.startsWith('emulator-')) continue;
  const name = await avdNameOf(sdk.adb, d.serial);
  console.log('[t] avdNameOf', d.serial, '=>', JSON.stringify(name), name === 'dg' ? '✓匹配' : '✗不匹配');
}

await run(sdk.adb, ['-s', entry.serial, 'emu', 'kill'], { timeoutMs: 8000 }).catch(() => undefined);
console.log('[t] kill 已发');
void booted;
