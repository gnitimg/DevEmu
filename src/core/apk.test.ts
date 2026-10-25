import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseBadging, listApps, removeApp, apkMetaPath, apkFilePath } from './apk.ts';

const BADGING = `package: name='com.example.demo' versionCode='12' versionName='1.2.0' platformBuildVersionName=''
sdkVersion:'24'
targetSdkVersion:'35'
uses-permission: name='android.permission.INTERNET'
application-label:'示例应用'
application-label-ja:'サンプル'
launchable-activity: name='com.example.demo.MainActivity' label=''
uses-library:'android.test.runner'
native-code: 'arm64-v8a'`;

test('parseBadging 提取包名/版本/标签/入口', () => {
  const info = parseBadging(BADGING);
  assert.ok(info);
  assert.equal(info!.packageName, 'com.example.demo');
  assert.equal(info!.versionName, '1.2.0');
  assert.equal(info!.versionCode, '12');
  assert.equal(info!.label, '示例应用');
  assert.equal(info!.activity, 'com.example.demo.MainActivity');
});

test('parseBadging 无 package 行返回 null', () => {
  assert.equal(parseBadging('application: label\n'), null);
});

test('listApps/removeApp 元数据管理', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-apk-'));
  const meta = {
    id: 'abc1',
    fileName: 'demo.apk',
    label: '示例应用',
    packageName: 'com.example.demo',
    size: 1024,
    importedAt: '2026-10-25T00:00:00Z',
  };
  fs.writeFileSync(apkMetaPath(dir, 'abc1'), JSON.stringify(meta), 'utf8');
  fs.writeFileSync(apkFilePath(dir, 'abc1'), 'fake');

  const apps = listApps(dir);
  assert.equal(apps.length, 1);
  assert.equal(apps[0]!.packageName, 'com.example.demo');

  assert.equal(removeApp(dir, 'abc1'), true);
  assert.deepEqual(listApps(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
