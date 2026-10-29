/** 真实 GPS / SensorManager 验证：node scripts/location-e2e.ts [emulator-5554] */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { run } from '../src/core/exec.ts';
import { detectSdk, detectJava } from '../src/core/sdk.ts';
import { loadAppSettings } from '../src/core/settings.ts';
import {
  startLocation,
  stopLocation,
  nudgeLocation,
  locationStatus,
  sanitizeLocationConfig,
} from '../src/core/location.ts';

const serial = process.argv[2] ?? 'emulator-5554';
assert.match(serial, /^emulator-\d{1,5}$/);
const settings = loadAppSettings();
const sdk = detectSdk(settings.sdkPath);
const java = detectJava(settings.javaPath);
assert.ok(sdk && java, '需要 Android SDK 与 JDK');
const tools = fs.readdirSync(path.join(sdk.root, 'build-tools')).sort().at(-1)!;
const platform = fs
  .readdirSync(path.join(sdk.root, 'platforms'))
  .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)))
  .at(-1)!;
const androidJar = path.join(sdk.root, 'platforms', platform, 'android.jar');
const buildTools = path.join(sdk.root, 'build-tools', tools);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-location-e2e-'));
const remote = '/data/local/tmp/devemu-location-probe-' + Date.now() + '.jar';
const exec = async (cmd: string, args: string[]): Promise<string> => {
  const r = await run(cmd, args, { timeoutMs: 30000 });
  assert.equal(r.code, 0, r.stderr || r.stdout);
  return r.stdout;
};
let probe: ReturnType<typeof spawn> | undefined;
const throttleKey = 'location_background_throttle_package_whitelist';
const previousWhitelist = (
  await exec(sdk.adb, [
    '-s',
    serial,
    'shell',
    'settings',
    'get',
    'global',
    throttleKey,
  ])
).trim();
try {
  // shell 探针没有前台 Activity；临时豁免 10 分钟后台节流，结束后原样恢复。
  await exec(sdk.adb, [
    '-s',
    serial,
    'shell',
    'settings',
    'put',
    'global',
    throttleKey,
    previousWhitelist === 'null'
      ? 'com.android.shell'
      : previousWhitelist + ',com.android.shell',
  ]);
  const classes = path.join(temp, 'classes'),
    dex = path.join(temp, 'dex');
  fs.mkdirSync(classes);
  fs.mkdirSync(dex);
  await exec(path.join(path.dirname(java), 'javac.exe'), [
    '-source',
    '8',
    '-target',
    '8',
    '-cp',
    androidJar,
    '-d',
    classes,
    path.resolve('scripts/android/LocationProbe.java'),
  ]);
  const classFiles: string[] = [];
  const collect = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (entry.name.endsWith('.class')) classFiles.push(full);
    }
  };
  collect(classes);
  await exec(java, [
    '-cp',
    path.join(buildTools, 'lib', 'd8.jar'),
    'com.android.tools.r8.D8',
    '--lib',
    androidJar,
    '--output',
    dex,
    ...classFiles,
  ]);
  const jar = path.join(temp, 'probe.jar');
  await exec(path.join(path.dirname(java), 'jar.exe'), [
    'cf',
    jar,
    '-C',
    dex,
    'classes.dex',
  ]);
  await exec(sdk.adb, ['-s', serial, 'push', jar, remote]);
  let output = '';
  probe = spawn(
    sdk.adb,
    [
      '-s',
      serial,
      'shell',
      'CLASSPATH=' + remote,
      'app_process',
      '/system/bin',
      'devemu.probe.LocationProbe',
    ],
    { windowsHide: true },
  );
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(Error('探针未就绪：' + output)),
      10000,
    );
    probe!.stdout!.on('data', (c: Buffer) => {
      output += c.toString();
      if (output.includes('PROBE_READY')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    probe!.stderr!.on('data', (c: Buffer) => (output += c.toString()));
    probe!.once('error', reject);
  });
  await ready;
  const config = sanitizeLocationConfig({
    mode: 'manual',
    anchor: { lat: 39.9, lon: 116.4 },
    altitudeM: 24,
    speedJitterPct: 0,
    strideJitterPct: 0,
    cadenceJitterPct: 0,
    gpsNoiseM: 0,
  });
  assert.ok(config.ok);
  assert.ok(
    (await startLocation({ adbPath: sdk.adb }, serial, config.config)).ok,
  );
  nudgeLocation(serial, 'up', true);
  await new Promise<void>((resolve, reject) => {
    if (probe!.exitCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      probe!.kill();
      reject(Error('探针超时：' + output));
    }, 12000);
    probe!.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  const line = output.split(/\r?\n/).find((l) => l.startsWith('PROBE_RESULT '));
  assert.ok(line, output);
  const result = JSON.parse(line.slice(13)) as {
    fixes: {
      lat: number;
      lon: number;
      speed: number;
      altitude: number;
      bearing: number;
    }[];
    sensors: {
      type: number;
      available: boolean;
      samples: number;
      min: number;
      max: number;
    }[];
  };
  assert.ok(
    result.fixes.length >= 3,
    'Android LocationManager 未收到连续 GPS：' + JSON.stringify(result),
  );
  const last = result.fixes.at(-1)!;
  // 罗盘模型：up 键 = 正北，纬度增大、经度不变、航向 0
  assert.ok(
    Math.abs(last.lat - 39.9) > 0.00001 &&
      Math.abs(last.lon - 116.4) < 0.00001,
    JSON.stringify(last),
  );
  assert.ok(Math.abs(last.speed - 1.4) < 0.05, JSON.stringify(last));
  assert.ok(Math.abs(last.altitude - 24) < 1, JSON.stringify(last));
  assert.ok(Math.abs(last.bearing) < 1, JSON.stringify(last));
  const acceleration = result.sensors.find((s) => s.type === 1)!;
  assert.ok(
    acceleration.samples > 30 && acceleration.max - acceleration.min > 2,
    JSON.stringify(acceleration),
  );
  console.log(
    JSON.stringify({ guest: result, engine: locationStatus(serial) }, null, 2),
  );
} finally {
  await stopLocation(serial);
  probe?.kill();
  await run(
    sdk.adb,
    [
      '-s',
      serial,
      'shell',
      'settings',
      ...(previousWhitelist === 'null'
        ? ['delete', 'global', throttleKey]
        : ['put', 'global', throttleKey, previousWhitelist]),
    ],
    { timeoutMs: 5000 },
  );
  await run(sdk.adb, ['-s', serial, 'shell', 'rm', remote], {
    timeoutMs: 5000,
  }).catch(() => undefined);
  // temp 由 mkdtemp 在系统临时目录创建，未使用用户传入的路径。
  fs.rmSync(temp, { recursive: true, force: true });
}
