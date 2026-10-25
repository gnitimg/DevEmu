import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadSettings, saveSettings, ensureDataDirs, settingsPath } from './settings.ts';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-test-'));
}

test('settings 往返保存加载', () => {
  const root = tmpRoot();
  saveSettings({ dataRoot: root, sdkPath: 'C:\\sdk', javaPath: 'C:\\java' });
  const loaded = loadSettings(root);
  assert.equal(loaded.dataRoot, root);
  assert.equal(loaded.sdkPath, 'C:\\sdk');
  assert.equal(loaded.javaPath, 'C:\\java');
  fs.rmSync(root, { recursive: true, force: true });
});

test('settings 损坏时回退默认', () => {
  const root = tmpRoot();
  fs.writeFileSync(settingsPath(root), '{broken json', 'utf8');
  const loaded = loadSettings(root);
  assert.deepEqual(loaded, { dataRoot: root });
  fs.rmSync(root, { recursive: true, force: true });
});

test('ensureDataDirs 建齐目录结构', () => {
  const root = tmpRoot();
  ensureDataDirs(root);
  for (const sub of ['projects', path.join('devices', 'avd'), path.join('devices', 'apps')]) {
    assert.ok(fs.existsSync(path.join(root, sub)), sub);
  }
  fs.rmSync(root, { recursive: true, force: true });
});
