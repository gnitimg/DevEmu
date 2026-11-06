import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { detectHarmony, findHdcAny, listHarmonyComponents, parseHdcTargets } from './harmony.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-harmony-'));
}

test('parseHdcTargets 解析 serial 与空态', () => {
  assert.deepEqual(parseHdcTargets('127.0.0.1:5555\nUSER-PC-ABC\n'), ['127.0.0.1:5555', 'USER-PC-ABC']);
  assert.deepEqual(parseHdcTargets('[Empty]\n'), []);
  assert.deepEqual(parseHdcTargets(''), []);
  assert.deepEqual(parseHdcTargets('127.0.0.1:5555 [offline]\r\n'), ['127.0.0.1:5555']);
});

test('parseHdcTargets 过滤 daemon 提示等含空格杂行（防幽灵设备）', () => {
  const out = [
    'Install hdc daemon successfully',
    'Connect server failed: connect timeout',
    '127.0.0.1:5555',
    '0X123456789ABCDEF',
  ].join('\n');
  assert.deepEqual(parseHdcTargets(out), ['127.0.0.1:5555', '0X123456789ABCDEF']);
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

test('commandline-tools 布局：显式路径经 findHdcAny 兜底检出', () => {
  const root = tmpDir();
  // 下载中心 zip 解压出的布局：不是 <set>/openharmony/toolchains 结构
  const bin = path.join(root, 'commandline-tools', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'hdc.exe'), 'hdc', 'utf8');
  const info = detectHarmony(root);
  assert.ok(info, '显式路径即使无标准 SDK 集结构也应经 hdc 兜底检出');
  assert.equal(info!.hdc, path.join(bin, 'hdc.exe'));
  assert.equal(findHdcAny(root), path.join(bin, 'hdc.exe'));
  fs.rmSync(root, { recursive: true, force: true });
});
