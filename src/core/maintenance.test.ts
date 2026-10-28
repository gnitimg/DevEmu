import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  storageItems,
  countAllAvds,
  clearAllAvds,
  factoryReset,
} from './maintenance.ts';
import { DEFAULT_DATA_ROOT, settingsPath } from './settings.ts';
import { logFile } from './log.ts';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-test-'));
}

test('storageItems 覆盖常用文件，设置文件固定在默认数据目录', () => {
  const root = tmpRoot();
  const items = storageItems(root);
  const ids = items.map((i) => i.id);
  for (const id of [
    'settings',
    'logs',
    'downloads',
    'agent',
    'avd',
    'apps',
    'runs',
  ]) {
    assert.ok(ids.includes(id), id);
  }
  const byId = Object.fromEntries(items.map((i) => [i.id, i.path]));
  assert.equal(byId.settings, settingsPath(DEFAULT_DATA_ROOT));
  assert.equal(byId.logs, logFile(root));
  assert.ok(byId.avd!.startsWith(root));
  fs.rmSync(root, { recursive: true, force: true });
});

function makeAvd(home: string, name: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, `${name}.ini`),
    'avd.ini.encoding=UTF-8',
    'utf8',
  );
  fs.mkdirSync(path.join(home, `${name}.avd`), { recursive: true });
}

test('countAllAvds / clearAllAvds 覆盖共享库与所有项目', () => {
  const root = tmpRoot();
  const shared = path.join(root, 'devices', 'avd');
  const proj = path.join(root, 'projects', 'demo', 'avd');
  makeAvd(shared, 'a');
  makeAvd(shared, 'b');
  makeAvd(proj, 'c');
  assert.equal(countAllAvds(root), 3);
  assert.equal(clearAllAvds(root), 3);
  assert.equal(countAllAvds(root), 0);
  // 项目目录本身保留，只清虚拟机
  assert.ok(fs.existsSync(path.join(root, 'projects', 'demo', 'avd')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('clearAllAvds 不碰应用库等其他文件', () => {
  const root = tmpRoot();
  const shared = path.join(root, 'devices', 'avd');
  makeAvd(shared, 'a');
  fs.mkdirSync(path.join(root, 'devices', 'apps'), { recursive: true });
  fs.writeFileSync(path.join(root, 'devices', 'apps', 'x.apk'), 'apk', 'utf8');
  assert.equal(clearAllAvds(root), 1);
  assert.ok(fs.existsSync(path.join(root, 'devices', 'apps', 'x.apk')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('factoryReset 清理已知目录，保留数据根目录本身与未知文件', () => {
  const root = tmpRoot();
  makeAvd(path.join(root, 'devices', 'avd'), 'a');
  fs.writeFileSync(path.join(root, 'settings.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(root, 'downloads.json'), '[]', 'utf8');
  fs.writeFileSync(path.join(root, 'keep.txt'), 'not ours', 'utf8');
  factoryReset(root, root);
  assert.ok(fs.existsSync(root));
  assert.ok(fs.existsSync(path.join(root, 'keep.txt')));
  assert.ok(!fs.existsSync(path.join(root, 'devices')));
  assert.ok(!fs.existsSync(path.join(root, 'settings.json')));
  assert.ok(!fs.existsSync(path.join(root, 'downloads.json')));
  fs.rmSync(root, { recursive: true, force: true });
});
