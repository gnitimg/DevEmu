import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(
  new URL('./emulator.ts', import.meta.url),
  'utf8',
);
const bootCallback = source.match(
  /void waitBooted[^]*?\.then\((async \(ok\) => \{[^]*?)\)\s*\.catch\(\(\) => undefined\);\s*resolve\(entry\)/,
)?.[1];
assert.ok(bootCallback, '启动就绪回调必须存在');

for (const state of ['current', 'exited', 'replaced'] as const) {
  test(`启动就绪回调只为原实例恢复装饰：${state}`, async () => {
    const entry = { avdName: 'TestDevice', serial: 'emulator-5554' };
    const running = new Map();
    if (state === 'current') running.set('TestDevice@shared', entry);
    if (state === 'replaced') running.set('TestDevice@shared', { ...entry });
    const calls: string[] = [];
    const callback = vm.runInNewContext(`(${bootCallback})`, {
      running,
      entry,
      avdName: 'TestDevice',
      sKey: 'shared',
      process: { platform: 'linux' },
      sdk: { adb: 'test-adb' },
      scope: { kind: 'shared' },
      config: { 'hw.device.name': 'pixel_9_pro' },
      // 设备内名称与 DevEmu/窗口标题统一，必须先于自动安装生效
      setGuestDeviceName: async () => {
        calls.push('deviceName');
      },
      autoInstallAfterBoot: () => calls.push('install'),
      restoreDeviceDecorations: async () => {
        calls.push('decorations');
      },
      applyPortalProbes: async () => {
        calls.push('portal');
      },
      preferCellularNetwork: async () => {
        calls.push('cellular');
      },
    }) as (ok: boolean) => Promise<void>;
    await callback(false);
    assert.deepEqual(calls, []);
    await callback(true);
    assert.deepEqual(
      calls,
      state === 'current'
        ? ['deviceName', 'install', 'decorations', 'portal', 'cellular']
        : [],
    );
  });
}
