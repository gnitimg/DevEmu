import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { detectHarmony, listHarmonyComponents, parseHdcTargets } from './harmony.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-harmony-'));
}

test('parseHdcTargets 解析 serial 与空态', () => {
  assert.deepEqual(parseHdcTargets('127.0.0.1:5555\nUSER-PC-ABC\n'), ['127.0.0.1:5555', 'USER-PC-ABC']);
  assert.deepEqual(parseHdcTargets('[Empty]\n'), []);
  assert.deepEqual(parseHdcTargets(''), []);
  assert.deepEqual(parseHdcTargets('127.0.0.1:5555 [offline]\r\n'), ['127.0.0.1:5555']);
});

test('listHarmonyComponents 扫描 openharmony 与 hms 子目录', () => {
  const set = tmpDir();
  fs.mkdirSync(path.join(set, 'openharmony', 'toolchains'), { recursive: true });
  fs.mkdirSync(path.join(set, 'openharmony', 'previewer'), { recursive: true });
  fs.writeFileSync(
    path.join(set, 'openharmony', 'toolchains', 'uni-package.json'),
    JSON.stringify({ version: '5.0.5(17)' }),
  );
  fs.mkdirSync(path.join(set, 'hms', 'hms-ads'), { recursive: true });

  const comps = listHarmonyComponents(set);
  assert.equal(comps.length, 3);
  assert.deepEqual(
    comps.map((c) => c.name),
    ['hms/hms-ads', 'openharmony/previewer', 'openharmony/toolchains'],
  );
  assert.equal(comps.find((c) => c.name === 'openharmony/toolchains')?.version, '5.0.5(17)');
  assert.equal(comps.find((c) => c.name === 'openharmony/previewer')?.version, undefined);
  fs.rmSync(set, { recursive: true, force: true });
});

test('listHarmonyComponents 没有 hms 目录时不报错', () => {
  const set = tmpDir();
  fs.mkdirSync(path.join(set, 'openharmony', 'toolchains'), { recursive: true });
  const comps = listHarmonyComponents(set);
  assert.equal(comps.length, 1);
  fs.rmSync(set, { recursive: true, force: true });
});

test('detectHarmony 识别 default 布局并定位 hdc', () => {
  const root = tmpDir();
  const toolchains = path.join(root, 'default', 'openharmony', 'toolchains');
  fs.mkdirSync(toolchains, { recursive: true });
  const hdc = path.join(toolchains, 'hdc.exe');
  fs.writeFileSync(hdc, '');

  const info = detectHarmony(root);
  assert.ok(info);
  assert.equal(info.hdc, hdc);
  assert.equal(info.sdkRoot, root);
  assert.ok(info.components.some((c) => c.name === 'openharmony/toolchains'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('detectHarmony 识别版本号目录布局', () => {
  const root = tmpDir();
  const toolchains = path.join(root, '1.2.3', 'openharmony', 'toolchains');
  fs.mkdirSync(toolchains, { recursive: true });
  fs.writeFileSync(path.join(toolchains, 'hdc.exe'), '');

  const info = detectHarmony(root);
  assert.ok(info);
  assert.match(info.hdc, /1\.2\.3/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('detectHarmony 无效目录返回 null', () => {
  const root = tmpDir();
  assert.equal(detectHarmony(root), null);
  fs.rmSync(root, { recursive: true, force: true });
});
