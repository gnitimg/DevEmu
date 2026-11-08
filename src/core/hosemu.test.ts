import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildCreateArgs,
  buildInstallArgs,
  buildUninstallArgs,
  findHosEmulator,
  hosPillName,
  hosPillSerial,
  isImageDownloaded,
  licenseAcceptedIn,
  parseEmulatorStartName,
  parseHosEmulatorVersion,
  parseHosImages,
  parseHosList,
  parseHosScreenProfiles,
  patchHosCpuCores,
  pickCreatableProfiles,
} from './hosemu.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-hosemu-'));
}

const LIST_JSON = JSON.stringify([
  {
    name: 'Pura 90',
    deviceType: 'phone',
    'os.osVersion': 'HarmonyOS 6.0.0(20)',
    'os.apiVersion': '20',
    'os.softwareVersion': '6.0.0.48',
    productModel: 'Pura 90',
    deviceModel: 'PHEMU-FD00',
    'hw.ramSize': '4096',
    'hw.dataPartitionSize': '6144',
    'hw.cpu.ncore': '4',
    instancePath: 'C:/emu/Pura 90',
    'hw.lcd.single.width': '1320',
    'hw.lcd.single.height': '2856',
    isRunning: 'false',
  },
  {
    name: 'tablet_dev',
    deviceType: 'tablet',
    'os.osVersion': 'HarmonyOS 6.0.0(20)',
    'os.apiVersion': '20',
    productModel: 'Huawei_Tablet',
    isRunning: 'true',
  },
]);

test('parseHosList 解析实例详情与运行状态', () => {
  const list = parseHosList(LIST_JSON);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], {
    name: 'Pura 90',
    deviceType: 'phone',
    osVersion: 'HarmonyOS 6.0.0(20)',
    apiVersion: '20',
    softwareVersion: '6.0.0.48',
    productModel: 'Pura 90',
    deviceModel: 'PHEMU-FD00',
    ramMb: 4096,
    storageMb: 6144,
    cpuCores: 4,
    instancePath: 'C:/emu/Pura 90',
    resolution: '1320×2856',
    running: false,
  });
  assert.equal(list[1]!.running, true);
  assert.equal(list[1]!.productModel, 'Huawei_Tablet');
  assert.equal(list[1]!.ramMb, undefined);
});

test('parseHosList 空实例输出返回空数组', () => {
  assert.deepEqual(parseHosList('[Empty]\n'), []);
  assert.deepEqual(parseHosList(''), []);
});

test('parseHosList 忽略前导下载提示', () => {
  const text = `Downloading: 100.0% (2389/2389 bytes)\n${LIST_JSON}`;
  assert.equal(parseHosList(text).length, 2);
});

test('parseHosImages 解析镜像下载状态', () => {
  const images = parseHosImages(
    JSON.stringify([
      {
        deviceType: 'phone',
        osVersion: 'HarmonyOS 7.0.0(26.0.0)',
        SoftWareVersion: '7.0.0.107',
        releaseType: 'Release',
        downloaded: 'false',
        upgradable: 'false',
      },
      {
        deviceType: 'phone',
        osVersion: 'HarmonyOS 6.0.0(20)',
        SoftWareVersion: '6.0.0.48',
        releaseType: 'Release',
        downloaded: 'true',
        upgradable: 'false',
      },
      {
        deviceType: '2in1 Foldable',
        osVersion: 'HarmonyOS 7.0.0(26.0.0)',
        SoftWareVersion: '7.0.0.107',
        downloaded: 'true',
      },
    ]),
  );
  assert.equal(images.length, 3);
  assert.deepEqual(images[0], {
    deviceType: 'phone',
    osVersion: 'HarmonyOS 7.0.0(26.0.0)',
    softwareVersion: '7.0.0.107',
    releaseType: 'Release',
    downloaded: false,
  });
  assert.equal(images[2]!.deviceType, '2in1 Foldable');
  assert.equal(images[2]!.downloaded, true);
});

test('buildCreateArgs 只带显式填写的内存与硬盘', () => {
  assert.deepEqual(
    buildCreateArgs({ name: 'hos_test', deviceType: 'phone', osVersion: 'HarmonyOS 6.0.0(20)' }),
    ['-create', 'hos_test', '-deviceType', 'phone', '-osVersion', 'HarmonyOS 6.0.0(20)'],
  );
  assert.deepEqual(
    buildCreateArgs({
      name: 'hos_test',
      deviceType: '2in1 Foldable',
      osVersion: 'HarmonyOS 6.0.0(20)',
      memoryGb: 8,
      storageGb: 32,
    }),
    [
      '-create',
      'hos_test',
      '-deviceType',
      '2in1 Foldable',
      '-osVersion',
      'HarmonyOS 6.0.0(20)',
      '-memory',
      '8',
      '-storage',
      '32',
    ],
  );
});

test('buildCreateArgs 带屏幕机型', () => {
  assert.deepEqual(
    buildCreateArgs({
      name: 'pura_test',
      deviceType: 'phone',
      osVersion: 'HarmonyOS 6.0.0(20)',
      screenProfile: 'Pura 90',
      memoryGb: 4,
    }),
    [
      '-create',
      'pura_test',
      '-deviceType',
      'phone',
      '-osVersion',
      'HarmonyOS 6.0.0(20)',
      '-screenProfile',
      'Pura 90',
      '-memory',
      '4',
    ],
  );
});

test('buildCreateArgs 不带 CPU 核数（命令行无此参数）', () => {
  assert.deepEqual(
    buildCreateArgs({
      name: 'cpu_test',
      deviceType: 'phone',
      osVersion: 'HarmonyOS 6.0.0(20)',
      cpuCores: 8,
    }),
    ['-create', 'cpu_test', '-deviceType', 'phone', '-osVersion', 'HarmonyOS 6.0.0(20)'],
  );
});

test('patchHosCpuCores 改写或补写实例 config.ini 的核数', async () => {
  const dir = tmpDir();
  const ini = path.join(dir, 'config.ini');
  fs.writeFileSync(ini, 'name=x\r\nhw.cpu.ncore=4\r\nhw.ramSize=4096\r\n');
  await patchHosCpuCores(ini, 8);
  assert.match(fs.readFileSync(ini, 'utf8'), /^hw\.cpu\.ncore=8\r$/m);

  fs.writeFileSync(ini, 'name=x\r\n');
  await patchHosCpuCores(ini, 6);
  assert.match(fs.readFileSync(ini, 'utf8'), /^hw\.cpu\.ncore=6\r?$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildUninstallArgs 按设备类型与版本卸载镜像', () => {
  assert.deepEqual(buildUninstallArgs('tablet', 'HarmonyOS 6.0.0(20)'), [
    '-uninstall',
    '-deviceType',
    'tablet',
    '-osVersion',
    'HarmonyOS 6.0.0(20)',
    '-force',
  ]);
});

test('buildInstallArgs 带 -force 跳过交互', () => {
  assert.deepEqual(buildInstallArgs('phone', 'HarmonyOS 7.0.0(26)'), [
    '-install',
    '-deviceType',
    'phone',
    '-osVersion',
    'HarmonyOS 7.0.0(26)',
    '-force',
  ]);
});

test('isImageDownloaded 按设备类型与版本核对下载状态', () => {
  const images = parseHosImages(
    JSON.stringify([
      { deviceType: 'phone', osVersion: 'HarmonyOS 7.0.0(26)', SoftWareVersion: '26.0.0.1', downloaded: 'false' },
      { deviceType: 'tablet', osVersion: 'HarmonyOS 6.0.0(20)', SoftWareVersion: '6.0.0.1', downloaded: 'true' },
    ]),
  );
  assert.equal(isImageDownloaded(images, 'tablet', 'HarmonyOS 6.0.0(20)'), true);
  assert.equal(isImageDownloaded(images, 'phone', 'HarmonyOS 7.0.0(26)'), false);
  assert.equal(isImageDownloaded(images, 'phone', 'HarmonyOS 6.0.0(20)'), false);
});

test('parseHosScreenProfiles 取横线后的机型名并去重', () => {
  const text = [
    'Screen Profile List:',
    'Phone  - Mate 90 Pro',
    '  - Pura 90',
    '  - Mate 80',
    '  - Pura 90',
    '',
  ].join('\r\n');
  assert.deepEqual(parseHosScreenProfiles(text), ['Mate 90 Pro', 'Pura 90', 'Mate 80']);
  assert.deepEqual(parseHosScreenProfiles(''), []);
});

test('findHosEmulator 识别命令行工具包布局', () => {
  const root = tmpDir();
  const exe = path.join(root, 'command-line-tools', 'emulator', 'Emulator.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  assert.equal(findHosEmulator(root), exe);
  fs.rmSync(root, { recursive: true, force: true });
});

test('findHosEmulator 缺少模拟器组件返回 undefined', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'command-line-tools'), { recursive: true });
  assert.equal(findHosEmulator(root), undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('licenseAcceptedIn 只在两份协议都同意时通过', () => {
  const root = tmpDir();
  fs.writeFileSync(
    path.join(root, '.emu_config'),
    'HarmonyOS_Software_Service_Agreement:agree\nHarmonyOS_SDK_Agreement:agree\n',
  );
  assert.equal(licenseAcceptedIn([root]), true);
  fs.writeFileSync(path.join(root, '.emu_config'), 'HarmonyOS_Software_Service_Agreement:agree\n');
  assert.equal(licenseAcceptedIn([root]), false);
  assert.equal(licenseAcceptedIn([path.join(root, 'missing')]), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('parseHosEmulatorVersion 取主次版本定位协议目录', () => {
  assert.equal(parseHosEmulatorVersion('HarmonyOS Emulator :26.0.0.402\n'), '26.0');
  assert.equal(parseHosEmulatorVersion('Emulator: 6.1.0.100'), '6.1');
  assert.equal(parseHosEmulatorVersion('unexpected output'), undefined);
});

test('pickCreatableProfiles 只保留内嵌机型表里的名字', () => {
  // 内嵌表是 NUL 分隔的字符串序列，Mate 90 系列只在云端清单里，-create 会静默失败
  const exe = Buffer.from('\0Pura 90\0KEE\0Pura 90 Pro\0MLN\0Mate 80\0VYG\0', 'latin1');
  assert.deepEqual(pickCreatableProfiles(exe, ['Mate 90', 'Pura 90', 'Mate 80']), [
    'Pura 90',
    'Mate 80',
  ]);
});

test('hosPillSerial 把含空格/中文的实例名编码成安全窗口标识', () => {
  const serial = hosPillSerial('Pura 90 测试');
  assert.match(serial, /^hos-[A-Za-z0-9_-]{1,120}$/);
  assert.equal(Buffer.from(serial.slice(4), 'base64url').toString('utf8'), 'Pura 90 测试');
  assert.notEqual(hosPillSerial('a'), hosPillSerial('b'));
});

test('hosPillName 还原实例名，非 HarmonyOS serial 返回 undefined', () => {
  assert.equal(hosPillName(hosPillSerial('Pura 90 测试')), 'Pura 90 测试');
  assert.equal(hosPillName('emulator-5554'), undefined);
  assert.equal(hosPillName('hos-'), undefined);
});

test('parseEmulatorStartName 兼容带引号与无引号的 -start 参数', () => {
  assert.equal(
    parseEmulatorStartName('"C:\\Sdk\\emulator\\Emulator.exe" -start "Pura 90"'),
    'Pura 90',
  );
  assert.equal(parseEmulatorStartName('Emulator.exe -start hos_test'), 'hos_test');
  assert.equal(parseEmulatorStartName('Emulator.exe -start "Pura 90" -extra'), 'Pura 90');
  assert.equal(parseEmulatorStartName('Emulator.exe -list -details'), undefined);
});

test('pickCreatableProfiles 全部未命中时回退原列表', () => {
  const exe = Buffer.from('\0something else\0', 'latin1');
  assert.deepEqual(pickCreatableProfiles(exe, ['Mate 90', 'Pura 90']), ['Mate 90', 'Pura 90']);
});
