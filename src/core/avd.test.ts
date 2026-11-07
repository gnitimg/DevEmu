import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseDeviceList,
  parseConfigIni,
  listAvds,
  updateAvdHardware,
} from './avd.ts';
import { scopeDirs } from './env.ts';
import * as avd from './avd.ts';

const DEVICE_OUTPUT = `Available Android devices:
  id: 11 or "wearos Square"
    Name: wearos Square
    OEM: Google
  id: 12 or "pixel_6"
    Name: Pixel 6
    OEM: Google
  id: 13 or "pixel_8_pro"
    Name: Pixel 8 Pro
    OEM: Google
----------`;

test('parseDeviceList 解析 id/Name 对', () => {
  const defs = parseDeviceList(DEVICE_OUTPUT);
  assert.equal(defs.length, 3);
  assert.deepEqual(defs[1], { id: 'pixel_6', name: 'Pixel 6' });
});

test('prepareEmulatorSkin 把官方皮肤路径写入 AVD，供 Qt 加载透明轮廓和屏幕遮罩', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-skin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skin = path.join(root, 'skins', 'pixel_9_pro');
  const device = path.join(root, 'TestDevice.avd');
  fs.mkdirSync(skin, { recursive: true });
  fs.mkdirSync(device);
  fs.writeFileSync(path.join(skin, 'layout'), 'parts {}');
  fs.writeFileSync(path.join(device, 'config.ini'), 'hw.device.name=pixel_9_pro\r\nhw.ramSize=4096M\r\n');
  assert.equal(typeof avd.prepareEmulatorSkin, 'function');
  const args = avd.prepareEmulatorSkin(root, root, 'TestDevice', avd.readAvdConfig(root, 'TestDevice'));
  assert.deepEqual(args, ['-skin', 'pixel_9_pro', '-skindir', path.dirname(skin)]);
  assert.deepEqual(avd.readAvdConfig(root, 'TestDevice'), {
    'hw.device.name': 'pixel_9_pro', 'hw.ramSize': '4096M', 'skin.path': skin,
  });
});

test('prepareEmulatorSkin 优先现有自定义皮肤且不重复改写配置，支持空格', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-skin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skin = path.join(root, 'custom skins', 'my phone');
  const device = path.join(root, 'TestDevice.avd');
  fs.mkdirSync(skin, { recursive: true });
  fs.mkdirSync(device);
  fs.writeFileSync(path.join(skin, 'layout'), 'parts {}');
  const original = `skin.path=${skin}\nhw.device.name=pixel_9_pro\n`;
  fs.writeFileSync(path.join(device, 'config.ini'), original);
  assert.equal(typeof avd.prepareEmulatorSkin, 'function');
  assert.deepEqual(avd.prepareEmulatorSkin(root, root, 'TestDevice', avd.readAvdConfig(root, 'TestDevice')),
    ['-skin', 'my phone', '-skindir', path.dirname(skin)]);
  assert.equal(fs.readFileSync(path.join(device, 'config.ini'), 'utf8'), original);
});

test('prepareEmulatorSkin 修复 SDK 迁移后失效的皮肤路径', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-skin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skin = path.join(root, 'skins', 'pixel_9_pro');
  const device = path.join(root, 'TestDevice.avd');
  fs.mkdirSync(skin, { recursive: true });
  fs.mkdirSync(device);
  fs.writeFileSync(path.join(skin, 'layout'), 'parts {}');
  fs.writeFileSync(path.join(device, 'config.ini'), `hw.device.name=pixel_9_pro\nskin.path=${path.join(root, 'old-sdk', 'pixel_9_pro')}\n`);
  assert.equal(typeof avd.prepareEmulatorSkin, 'function');
  avd.prepareEmulatorSkin(root, root, 'TestDevice', avd.readAvdConfig(root, 'TestDevice'));
  assert.equal(avd.readAvdConfig(root, 'TestDevice')['skin.path'], skin);
});

test('prepareEmulatorSkin 配置写入失败时抛错，不带着缺失遮罩继续启动', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-skin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skin = path.join(root, 'skins', 'pixel_9_pro');
  fs.mkdirSync(skin, { recursive: true });
  fs.writeFileSync(path.join(skin, 'layout'), 'parts {}');
  fs.mkdirSync(path.join(root, 'TestDevice.avd', 'config.ini'), { recursive: true });
  assert.equal(typeof avd.prepareEmulatorSkin, 'function');
  assert.throws(() => avd.prepareEmulatorSkin(root, root, 'TestDevice', { 'hw.device.name': 'pixel_9_pro' }));
});

test('prepareEmulatorSkin 缺少皮肤时不强制裁剪或关闭皮肤，不修改现有配置', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-skin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const device = path.join(root, 'TestDevice.avd');
  fs.mkdirSync(device);
  const original = 'hw.device.name=missing\nskin.path=_no_skin\n';
  fs.writeFileSync(path.join(device, 'config.ini'), original);
  assert.equal(typeof avd.prepareEmulatorSkin, 'function');
  assert.deepEqual(avd.prepareEmulatorSkin(root, root, 'TestDevice', {}), []);
  assert.deepEqual(avd.prepareEmulatorSkin(root, root, 'TestDevice', avd.readAvdConfig(root, 'TestDevice')), []);
  assert.equal(fs.readFileSync(path.join(device, 'config.ini'), 'utf8'), original);
  const emulator = fs.readFileSync(new URL('./emulator.ts', import.meta.url), 'utf8');
  assert.match(emulator, /prepareEmulatorSkin\(sdk.root, dirs.avdHome, avdName, config\)/);
  assert.doesNotMatch(emulator, /['"]-noskin['"]|disableDeviceDecorations|startDecorWatch/);
});

const CONFIG_INI = `avd.ini.encoding=UTF-8
hw.device.name=pixel_6
image.sysimg.1.dir = C:\\sdk\\system-images\\android-35\\google_apis\\x86_64
tag.display=Google APIs
disk.dataPartition.size=6442450944`;

test('parseConfigIni 解析键值对', () => {
  const cfg = parseConfigIni(CONFIG_INI);
  assert.equal(cfg['avd.ini.encoding'], 'UTF-8');
  assert.equal(
    cfg['image.sysimg.1.dir'],
    'C:\\sdk\\system-images\\android-35\\google_apis\\x86_64',
  );
  assert.equal(cfg['tag.display'], 'Google APIs');
});

test('listAvds 从作用域目录读出 AVD 并推导镜像包名', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-avd-'));
  const { avdHome } = scopeDirs(dataRoot, { kind: 'project', projectId: 'p1' });
  const avdDir = path.join(avdHome, 'TestDevice.avd');
  fs.mkdirSync(avdDir, { recursive: true });
  fs.writeFileSync(
    path.join(avdHome, 'TestDevice.ini'),
    `avd.ini.encoding=UTF-8\npath=${avdDir}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(avdDir, 'config.ini'),
    'hw.device.name=pixel_6\nimage.sysdir.1 = system-images\\android-35\\google_apis\\x86_64\\\n',
    'utf8',
  );

  const avds = listAvds(dataRoot, { kind: 'project', projectId: 'p1' });
  assert.equal(avds.length, 1);
  assert.equal(avds[0]!.name, 'TestDevice');
  assert.equal(
    avds[0]!.imagePkg,
    'system-images;android-35;google_apis;x86_64',
  );

  // 项目隔离：另一个作用域看不到
  const other = listAvds(dataRoot, { kind: 'project', projectId: 'p2' });
  assert.equal(other.length, 0);
  const shared = listAvds(dataRoot, { kind: 'shared' });
  assert.equal(shared.length, 0);

  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('updateAvdHardware 把内存写入 config.ini 并保留其他行', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-avd-'));
  const { avdHome } = scopeDirs(dataRoot, { kind: 'shared' });
  const avdDir = path.join(avdHome, 'TestDevice.avd');
  fs.mkdirSync(avdDir, { recursive: true });
  fs.writeFileSync(
    path.join(avdDir, 'config.ini'),
    'hw.cpu.ncore=4\nhw.ramSize = 4096M\ntag.display=Google APIs\n',
    'utf8',
  );

  const r = updateAvdHardware(dataRoot, { kind: 'shared' }, 'TestDevice', {
    ramMb: 6144,
  });
  assert.deepEqual(r, { ok: true });
  const text = fs.readFileSync(path.join(avdDir, 'config.ini'), 'utf8');
  assert.match(text, /hw\.ramSize = 6144M/);
  assert.match(text, /hw\.cpu\.ncore=4/);
  assert.match(text, /tag\.display=Google APIs/);

  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('updateAvdHardware 写入失败时返回错误而不是静默成功', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-avd-'));
  const { avdHome } = scopeDirs(dataRoot, { kind: 'shared' });
  const avdDir = path.join(avdHome, 'TestDevice.avd');
  fs.mkdirSync(path.join(avdDir, 'config.ini'), { recursive: true });

  const r = updateAvdHardware(dataRoot, { kind: 'shared' }, 'TestDevice', {
    ramMb: 6144,
  });
  assert.equal(r.ok, false);
  assert.ok(r.error);

  fs.rmSync(dataRoot, { recursive: true, force: true });
});
