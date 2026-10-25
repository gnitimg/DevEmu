import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseSdkmanagerList, listInstalledImages } from './sdk.ts';

const LIST_OUTPUT = `Warning: File C:\\Users\\x\\.android\\repositories.cfg could not be loaded.
Installed packages:
  platform-tools                                   | 35.0.2 |
  system-images;android-35;google_apis;x86_64      | 5     | Android SDK Platform 35
Available Packages:
  system-images;android-36;google_apis;x86_64      | 36.1.23 | Google Play Intel x86_64 Atom System Image
  system-images;android-36;google_apis_playstore;x86_64 | 36.1.23 | Google Play Intel x86_64 Atom System Image
  system-images;android-35;android-tv;x86_64       | 5      | Android TV x86_64 System Image
  platforms;android-36                             | 1      | Android SDK Platform 36
  build-tools;36.0.0                               | 36.0.0 | Android SDK Build-Tools 36
Available Updates:
  emulator                                         | 36.1.4 | Available
Done.`;

test('parseSdkmanagerList 只取 Available 段的 system-images', () => {
  const entries = parseSdkmanagerList(LIST_OUTPUT);
  assert.equal(entries.length, 3);
  assert.equal(entries[0]!.pkg, 'system-images;android-36;google_apis;x86_64');
  assert.equal(entries[0]!.version, '36.1.23');
  assert.ok(entries[0]!.desc.includes('Google Play'));
  assert.ok(entries.every((e) => e.pkg.startsWith('system-images;')));
  // Installed 段的 system-images 不能混进来
  assert.ok(!entries.some((e) => e.pkg.includes('android-35;google_apis')));
});

test('parseSdkmanagerList 无 Available 段返回空', () => {
  assert.deepEqual(parseSdkmanagerList('nothing here'), []);
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
