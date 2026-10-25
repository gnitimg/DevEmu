import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseDeviceList, parseConfigIni, listAvds } from './avd.ts';
import { scopeDirs } from './env.ts';

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

const CONFIG_INI = `avd.ini.encoding=UTF-8
hw.device.name=pixel_6
image.sysimg.1.dir = C:\\sdk\\system-images\\android-35\\google_apis\\x86_64
tag.display=Google APIs
disk.dataPartition.size=6442450944`;

test('parseConfigIni 解析键值对', () => {
  const cfg = parseConfigIni(CONFIG_INI);
  assert.equal(cfg['avd.ini.encoding'], 'UTF-8');
  assert.equal(cfg['image.sysimg.1.dir'], 'C:\\sdk\\system-images\\android-35\\google_apis\\x86_64');
  assert.equal(cfg['tag.display'], 'Google APIs');
});

test('listAvds 从作用域目录读出 AVD 并推导镜像包名', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-avd-'));
  const { avdHome } = scopeDirs(dataRoot, { kind: 'project', projectId: 'p1' });
  const avdDir = path.join(avdHome, 'TestDevice.avd');
  fs.mkdirSync(avdDir, { recursive: true });
  fs.writeFileSync(path.join(avdHome, 'TestDevice.ini'), `avd.ini.encoding=UTF-8\npath=${avdDir}\n`, 'utf8');
  fs.writeFileSync(
    path.join(avdDir, 'config.ini'),
    'image.sysimg.1.dir=' + path.join(dataRoot, 'sysimg', 'system-images', 'android-35', 'google_apis', 'x86_64'),
    'utf8',
  );

  const avds = listAvds(dataRoot, { kind: 'project', projectId: 'p1' });
  assert.equal(avds.length, 1);
  assert.equal(avds[0]!.name, 'TestDevice');
  assert.equal(avds[0]!.imagePkg, 'system-images;android-35;google_apis;x86_64');

  // 项目隔离：另一个作用域看不到
  const other = listAvds(dataRoot, { kind: 'project', projectId: 'p2' });
  assert.equal(other.length, 0);
  const shared = listAvds(dataRoot, { kind: 'shared' });
  assert.equal(shared.length, 0);

  fs.rmSync(dataRoot, { recursive: true, force: true });
});
