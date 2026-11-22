import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureAndroidImagesRoot } from './sdkImages.ts';
import { listInstalledImages } from './sdk.ts';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-test-'));
}

function makeImage(sdkRoot: string): void {
  const img = path.join(
    sdkRoot,
    'system-images',
    'android-36',
    'google_apis_playstore',
    'x86_64',
  );
  fs.mkdirSync(img, { recursive: true });
  fs.writeFileSync(path.join(img, 'system.img'), 'img-data');
}

function cleanup(...roots: string[]): void {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
}

test('真实镜像目录搬进数据根并建 junction，扫描可穿透', async () => {
  const sdkRoot = tmpRoot();
  const dataRoot = tmpRoot();
  makeImage(sdkRoot);
  const r = await ensureAndroidImagesRoot(sdkRoot, dataRoot, {
    emulatorsRunning: false,
  });
  assert.equal(r.ok, true);
  assert.ok(r.movedBytes > 0, '应回报搬移字节数');
  const linkPath = path.join(sdkRoot, 'system-images');
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true, '原位置应为链接');
  const targetImg = path.join(
    dataRoot,
    'sdk',
    'system-images',
    'android-36',
    'google_apis_playstore',
    'x86_64',
    'system.img',
  );
  assert.equal(fs.readFileSync(targetImg, 'utf8'), 'img-data');
  assert.deepEqual(
    listInstalledImages(sdkRoot).map((i) => i.pkg),
    ['system-images;android-36;google_apis_playstore;x86_64'],
  );
  cleanup(sdkRoot, dataRoot);
});

test('已是正确 junction 时幂等跳过', async () => {
  const sdkRoot = tmpRoot();
  const dataRoot = tmpRoot();
  makeImage(sdkRoot);
  await ensureAndroidImagesRoot(sdkRoot, dataRoot, { emulatorsRunning: false });
  const r = await ensureAndroidImagesRoot(sdkRoot, dataRoot, {
    emulatorsRunning: false,
  });
  assert.equal(r.ok, true);
  assert.equal(r.movedBytes, 0, '第二次调用不应再搬移');
  const targetImg = path.join(
    dataRoot,
    'sdk',
    'system-images',
    'android-36',
    'google_apis_playstore',
    'x86_64',
    'system.img',
  );
  assert.equal(fs.readFileSync(targetImg, 'utf8'), 'img-data');
  cleanup(sdkRoot, dataRoot);
});

test('junction 指向旧数据根时重建到新根', async () => {
  const sdkRoot = tmpRoot();
  const oldDataRoot = tmpRoot();
  const newDataRoot = tmpRoot();
  makeImage(sdkRoot);
  await ensureAndroidImagesRoot(sdkRoot, oldDataRoot, {
    emulatorsRunning: false,
  });
  const r = await ensureAndroidImagesRoot(sdkRoot, newDataRoot, {
    emulatorsRunning: false,
  });
  assert.equal(r.ok, true);
  const linkPath = path.join(sdkRoot, 'system-images');
  assert.equal(
    path.resolve(fs.readlinkSync(linkPath)),
    path.resolve(path.join(newDataRoot, 'sdk', 'system-images')),
  );
  cleanup(sdkRoot, oldDataRoot, newDataRoot);
});

test('空的真实镜像目录直接替换为链接', async () => {
  const sdkRoot = tmpRoot();
  const dataRoot = tmpRoot();
  fs.mkdirSync(path.join(sdkRoot, 'system-images'), { recursive: true });
  const r = await ensureAndroidImagesRoot(sdkRoot, dataRoot, {
    emulatorsRunning: false,
  });
  assert.equal(r.ok, true);
  assert.equal(r.movedBytes, 0);
  assert.equal(
    fs.lstatSync(path.join(sdkRoot, 'system-images')).isSymbolicLink(),
    true,
  );
  cleanup(sdkRoot, dataRoot);
});

test('SDK 根在数据根内部时不重定向', async () => {
  const dataRoot = tmpRoot();
  const sdkRoot = path.join(dataRoot, 'sdk');
  fs.mkdirSync(sdkRoot, { recursive: true });
  const r = await ensureAndroidImagesRoot(sdkRoot, dataRoot, {
    emulatorsRunning: false,
  });
  assert.equal(r.ok, true);
  assert.equal(
    fs.existsSync(path.join(sdkRoot, 'system-images')),
    false,
    '不应创建链接（镜像本就随 SDK 落数据根）',
  );
  cleanup(dataRoot);
});

test('虚拟机运行中且旧位置有镜像：不搬不建链', async () => {
  const sdkRoot = tmpRoot();
  const dataRoot = tmpRoot();
  makeImage(sdkRoot);
  const r = await ensureAndroidImagesRoot(sdkRoot, dataRoot, {
    emulatorsRunning: true,
  });
  assert.equal(r.ok, false);
  const st = fs.lstatSync(path.join(sdkRoot, 'system-images'));
  assert.equal(st.isDirectory() && !st.isSymbolicLink(), true, '旧布局保持原样');
  assert.equal(
    fs.existsSync(path.join(dataRoot, 'sdk', 'system-images')),
    false,
    '不应在数据根建目标',
  );
  cleanup(sdkRoot, dataRoot);
});
