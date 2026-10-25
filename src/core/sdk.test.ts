import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseSdkmanagerSections, listInstalledImages, SDK_PKG_GROUPS } from './sdk.ts';

const LIST_OUTPUT = `Warning: File C:\\Users\\x\\.android\\repositories.cfg could not be loaded.
Installed packages:
  platform-tools                                   | 35.0.2 |
  system-images;android-35;google_apis;x86_64      | 5     | Android SDK Platform 35
  sources;android-35                               | 1     | Sources for Android 35
Available Packages:
  system-images;android-36;google_apis;x86_64      | 36.1.23 | Google Play Intel x86_64 Atom System Image
  system-images;android-36;google_apis_playstore;x86_64 | 36.1.23 | Google Play Intel x86_64 Atom System Image
  system-images;android-35;android-tv;x86_64       | 5      | Android TV x86_64 System Image
  platforms;android-36                             | 1      | Android SDK Platform 36
  build-tools;36.0.0                               | 36.0.0 | Android SDK Build-Tools 36
  ndk;27.0.0                                       | 27     | Some NDK
Available Updates:
  emulator                                         | 36.1.4 | Available
Done.`;

test('parseSdkmanagerSections 分段解析 installed/available', () => {
  const { installed, available } = parseSdkmanagerSections(LIST_OUTPUT);
  assert.equal(installed.length, 3);
  assert.equal(installed[0]!.pkg, 'platform-tools');
  assert.equal(installed[1]!.pkg, 'system-images;android-35;google_apis;x86_64');

  assert.equal(available.length, 6);
  assert.equal(available[0]!.pkg, 'system-images;android-36;google_apis;x86_64');
  assert.equal(available[0]!.version, '36.1.23');
  assert.ok(available[0]!.desc.includes('Google Play'));
  // Updates 段不混入
  assert.ok(!available.some((e) => e.pkg === 'emulator'));
});

test('SDK_PKG_GROUPS 过滤出管理界面的包组', () => {
  const { installed, available } = parseSdkmanagerSections(LIST_OUTPUT);
  assert.ok(installed.filter((e) => SDK_PKG_GROUPS.test(e.pkg)).every((e) => e.pkg !== 'sources;android-35'));
  assert.equal(available.filter((e) => SDK_PKG_GROUPS.test(e.pkg)).length, 5);
  assert.ok(!SDK_PKG_GROUPS.test('ndk;27.0.0'));
});

test('parseSdkmanagerSections 空输出', () => {
  assert.deepEqual(parseSdkmanagerSections('nothing here'), { installed: [], available: [] });
});

test('listInstalledImages 扫描目录并按 API 倒序', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-sdk-'));
  for (const p of [
    path.join('system-images', 'android-33', 'default', 'arm64-v8a'),
    path.join('system-images', 'android-35', 'google_apis', 'x86_64'),
  ]) {
    fs.mkdirSync(path.join(root, p), { recursive: true });
  }
  const images = listInstalledImages(root);
  assert.equal(images.length, 2);
  assert.equal(images[0]!.api, 35);
  assert.equal(images[0]!.tag, 'google_apis');
  assert.equal(images[0]!.abi, 'x86_64');
  assert.equal(images[1]!.pkg, 'system-images;android-33;default;arm64-v8a');
  fs.rmSync(root, { recursive: true, force: true });
});
