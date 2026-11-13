import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadSettings,
  saveSettings,
  ensureDataDirs,
  settingsPath,
  migrateDataRoot,
  dataRootConflicts,
} from './settings.ts';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-test-'));
}

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

test('settings 往返保存加载', async () => {
  const root = tmpRoot();
  saveSettings({ dataRoot: root, sdkPath: 'C:\\sdk', javaPath: 'C:\\java' });
  const loaded = loadSettings(root);
  assert.equal(loaded.dataRoot, root);
  assert.equal(loaded.sdkPath, 'C:\\sdk');
  assert.equal(loaded.javaPath, 'C:\\java');
  fs.rmSync(root, { recursive: true, force: true });
});

test('settings cameraMode 往返保存加载', async () => {
  const root = tmpRoot();
  saveSettings({ dataRoot: root, cameraMode: 'screen' });
  assert.equal(loadSettings(root).cameraMode, 'screen');
  saveSettings({ dataRoot: root, cameraMode: 'webcam' });
  assert.equal(loadSettings(root).cameraMode, 'webcam');
  fs.rmSync(root, { recursive: true, force: true });
});

test('settings 损坏时回退默认', async () => {
  const root = tmpRoot();
  fs.writeFileSync(settingsPath(root), '{broken json', 'utf8');
  const loaded = loadSettings(root);
  assert.deepEqual(loaded, { dataRoot: root });
  fs.rmSync(root, { recursive: true, force: true });
});

test('ensureDataDirs 建齐目录结构', async () => {
  const root = tmpRoot();
  ensureDataDirs(root);
  for (const sub of [
    'projects',
    path.join('devices', 'avd'),
    path.join('devices', 'apps'),
  ]) {
    assert.ok(fs.existsSync(path.join(root, sub)), sub);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('migrateDataRoot 全量随迁且源目录清空', async () => {
  const from = tmpRoot();
  const to = path.join(tmpRoot(), 'dest');
  const pairs: [string, string][] = [
    [path.join('projects', 'p1', 'meta.json'), 'p1'],
    [path.join('devices', 'avd', 'a.ini'), 'ini'],
    [path.join('devices', 'apps', 'x.apk'), 'apk'],
    [path.join('devices', 'crashes', 'c.json'), 'crash'],
    [path.join('agent', 'agent-mcp.mjs'), 'mjs'],
    [path.join('logs', 'app.log'), 'log'],
    [path.join('location', 'routes', 'r1.json'), 'route'],
    [path.join('location', 'prefs.json'), 'prefs'],
    [path.join('camera', 'screen.jpg'), 'jpg'],
    [path.join('screenshots', 's.png'), 'png'],
    ['downloads.json', 'dl'],
  ];
  for (const [rel, content] of pairs) writeFile(path.join(from, rel), content);
  const r = await migrateDataRoot(from, to);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(
    r.moved.slice().sort(),
    [
      'projects',
      path.join('devices', 'avd'),
      path.join('devices', 'apps'),
      path.join('devices', 'crashes'),
      'agent',
      'logs',
      'location',
      'camera',
      'screenshots',
      'downloads.json',
    ].sort(),
  );
  for (const [rel, content] of pairs)
    assert.equal(
      fs.readFileSync(path.join(to, rel), 'utf8'),
      content,
      rel,
    );
  assert.equal(fs.existsSync(from), false, '源根目录应无残留');
  fs.rmSync(to, { recursive: true, force: true });
});

test('migrateDataRoot 目标已有同名内容：以迁移源为准，目标独有项保留', async () => {
  const from = tmpRoot();
  const to = tmpRoot();
  writeFile(path.join(from, 'projects', 'p1', 'meta.json'), 'new');
  writeFile(path.join(from, 'downloads.json'), 'new-dl');
  writeFile(path.join(to, 'projects', 'p1', 'meta.json'), 'old');
  writeFile(path.join(to, 'projects', 'p2', 'meta.json'), 'keep');
  writeFile(path.join(to, 'logs', 'app.log'), 'keep-log');
  const r = await migrateDataRoot(from, to);
  assert.deepEqual(r.failed, []);
  assert.equal(
    fs.readFileSync(path.join(to, 'projects', 'p1', 'meta.json'), 'utf8'),
    'new',
  );
  assert.equal(
    fs.readFileSync(path.join(to, 'projects', 'p2', 'meta.json'), 'utf8'),
    'keep',
  );
  assert.equal(
    fs.readFileSync(path.join(to, 'logs', 'app.log'), 'utf8'),
    'keep-log',
  );
  assert.equal(fs.readFileSync(path.join(to, 'downloads.json'), 'utf8'), 'new-dl');
  assert.equal(fs.existsSync(from), false);
  fs.rmSync(to, { recursive: true, force: true });
});

test('migrateDataRoot 源缺项按跳过处理，settings.json 不随迁也不被删', async () => {
  const from = tmpRoot();
  const to = tmpRoot();
  writeFile(path.join(from, 'logs', 'app.log'), 'log');
  writeFile(settingsPath(from), '{"dataRoot":"x"}');
  const r = await migrateDataRoot(from, to);
  assert.deepEqual(r.failed, []);
  assert.ok(fs.existsSync(path.join(to, 'logs', 'app.log')));
  assert.ok(fs.existsSync(settingsPath(from)));
  assert.ok(fs.existsSync(from), '旧根还压着 settings.json，不能被删');
  fs.rmSync(to, { recursive: true, force: true });
  fs.rmSync(from, { recursive: true, force: true });
});

test('migrateDataRoot 新根在旧根子树内：安全项照迁，含新根的项跳过', async () => {
  const from = tmpRoot();
  const to = path.join(from, 'projects', 'custom', 'data');
  writeFile(path.join(to, 'seed.txt'), 'seed');
  writeFile(path.join(from, 'logs', 'app.log'), 'log');
  const r = await migrateDataRoot(from, to);
  assert.deepEqual(r.failed, []);
  assert.ok(r.moved.includes('logs'));
  assert.ok(!r.moved.includes('projects'));
  assert.ok(fs.existsSync(path.join(to, 'logs', 'app.log')));
  assert.ok(fs.existsSync(path.join(to, 'seed.txt')));
  fs.rmSync(from, { recursive: true, force: true });
});

test('migrateDataRoot 同一目录为空操作', async () => {
  const root = tmpRoot();
  writeFile(path.join(root, 'logs', 'app.log'), 'log');
  const r = await migrateDataRoot(root, root);
  assert.deepEqual(r, { moved: [], failed: [], iniFixed: 0 });
  assert.ok(fs.existsSync(path.join(root, 'logs', 'app.log')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('dataRootConflicts 新旧根相同时不报冲突', async () => {
  const root = tmpRoot();
  writeFile(path.join(root, 'projects', 'p1', 'project.json'), '{"name":"甲"}');
  assert.deepEqual(dataRootConflicts(root, root), {
    nested: false,
    blocked: false,
    projects: [],
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test('dataRootConflicts 新根在随迁项子树内判定为 blocked', async () => {
  const from = tmpRoot();
  const to = path.join(from, 'projects', 'custom', 'data');
  fs.mkdirSync(to, { recursive: true });
  const r = dataRootConflicts(from, to);
  assert.equal(r.nested, true);
  assert.equal(r.blocked, true);
  fs.rmSync(from, { recursive: true, force: true });
});

test('dataRootConflicts 新根为旧根下 .data 子目录允许迁移（升级新布局）', async () => {
  const from = tmpRoot();
  const to = path.join(from, '.data');
  fs.mkdirSync(to, { recursive: true });
  const r = dataRootConflicts(from, to);
  assert.equal(r.nested, true);
  assert.equal(r.blocked, false);
  fs.rmSync(from, { recursive: true, force: true });
});

test('dataRootConflicts 列出目标里同 ID 的项目并带名称', async () => {
  const from = tmpRoot();
  const to = tmpRoot();
  writeFile(path.join(from, 'projects', 'p1', 'project.json'), '{"name":"甲"}');
  writeFile(path.join(from, 'projects', 'p2', 'project.json'), '{"name":"乙"}');
  writeFile(path.join(to, 'projects', 'p1', 'project.json'), '{"name":"旧甲"}');
  writeFile(path.join(to, 'projects', 'p3', 'project.json'), '{"name":"丙"}');
  const r = dataRootConflicts(from, to);
  assert.equal(r.nested, false);
  assert.equal(r.blocked, false);
  assert.deepEqual(r.projects, [{ id: 'p1', name: '旧甲' }]);
  fs.rmSync(to, { recursive: true, force: true });
  fs.rmSync(from, { recursive: true, force: true });
});

test('dataRootConflicts 目标同 ID 目录损坏时仍按 ID 提示', async () => {
  const from = tmpRoot();
  const to = tmpRoot();
  writeFile(path.join(from, 'projects', 'p1', 'project.json'), '{"name":"甲"}');
  fs.mkdirSync(path.join(to, 'projects', 'p1'), { recursive: true });
  fs.writeFileSync(path.join(to, 'projects', 'p1', 'project.json'), '{broken', 'utf8');
  assert.deepEqual(dataRootConflicts(from, to).projects, [{ id: 'p1', name: 'p1' }]);
  fs.rmSync(to, { recursive: true, force: true });
  fs.rmSync(from, { recursive: true, force: true });
});

test('migrateDataRoot 改写 AVD ini 里指向旧数据根的绝对路径', async () => {
  const from = tmpRoot();
  const to = tmpRoot();
  writeFile(
    path.join(from, 'devices', 'avd', 'a.ini'),
    `avd.ini.encoding=UTF-8\r\npath=${path.join(from, 'devices', 'avd', 'a.avd')}\r\ntarget=android-36\r\n`,
  );
  writeFile(
    path.join(from, 'projects', 'p1', 'avd', 'b.ini'),
    `path=${path.join(from, 'projects', 'p1', 'avd', 'b.avd')}\n`,
  );
  // 指向数据根外的路径不属于本根，保持原样
  writeFile(
    path.join(from, 'devices', 'avd', 'keep.ini'),
    'path=C:\\elsewhere\\x.avd\n',
  );
  const r = await migrateDataRoot(from, to);
  assert.deepEqual(r.failed, []);
  assert.equal(r.iniFixed, 2);
  const a = fs.readFileSync(path.join(to, 'devices', 'avd', 'a.ini'), 'utf8');
  assert.ok(a.includes(`path=${path.join(to, 'devices', 'avd', 'a.avd')}`), a);
  assert.ok(a.includes('\r\n'), '应保留原 CRLF 行尾');
  const b = fs.readFileSync(path.join(to, 'projects', 'p1', 'avd', 'b.ini'), 'utf8');
  assert.ok(b.includes(`path=${path.join(to, 'projects', 'p1', 'avd', 'b.avd')}`), b);
  const keep = fs.readFileSync(path.join(to, 'devices', 'avd', 'keep.ini'), 'utf8');
  assert.equal(keep, 'path=C:\\elsewhere\\x.avd\n');
  fs.rmSync(to, { recursive: true, force: true });
  fs.rmSync(from, { recursive: true, force: true });
});

test('migrateDataRoot 支持迁入旧根下 .data 子目录（升级新布局）', async () => {
  const from = tmpRoot();
  const to = path.join(from, '.data');
  writeFile(path.join(from, 'projects', 'p1', 'project.json'), '{"name":"甲"}');
  writeFile(path.join(from, 'devices', 'avd', 'v1.ini'), 'path=x\n');
  const r = await migrateDataRoot(from, to);
  assert.deepEqual(r.failed, []);
  assert.ok(fs.existsSync(path.join(to, 'projects', 'p1', 'project.json')));
  assert.ok(fs.existsSync(path.join(to, 'devices', 'avd', 'v1.ini')));
  // 旧根只剩 .data 本身，settings.json 类引导文件不随迁
  assert.deepEqual(fs.readdirSync(from), ['.data']);
});
