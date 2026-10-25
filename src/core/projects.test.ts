import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProject, listProjects, updateProject, deleteProject, sanitizeId } from './projects.ts';
import { recordRun, listRuns } from './runs.ts';

test('项目创建/列表/更新/删除', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-proj-'));
  const p1 = createProject(root, '购物 App', '商城 v2 重构');
  assert.equal(p1.id, '购物 App');
  assert.equal(p1.note, '商城 v2 重构');

  const p2 = createProject(root, '购物 App');
  assert.equal(p2.id, '购物 App-2');
  assert.notEqual(p1.id, p2.id);

  let list = listProjects(root);
  assert.equal(list.length, 2);

  updateProject(root, p1.id, { name: '购物 App 主线', note: '' });
  list = listProjects(root);
  const updated = list.find((p) => p.id === p1.id)!;
  assert.equal(updated.name, '购物 App 主线');
  assert.equal(updated.note, undefined);

  assert.equal(deleteProject(root, p1.id), true);
  assert.equal(listProjects(root).length, 1);
  // 不存在的删不掉
  assert.equal(deleteProject(root, 'nope'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('sanitizeId 过滤非法字符', () => {
  assert.equal(sanitizeId('a/b:c*d'), 'a_b_c_d');
  assert.ok(sanitizeId('   ').length > 0);
});

test('测试记录写入与列出', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-run-'));
  const runsDir = path.join(root, 'runs');
  const rec = recordRun(
    runsDir,
    { avdName: 'Pixel6', apkLabel: '示例应用', packageName: 'com.example.demo', result: 'ok' },
    { screenshot: Buffer.from([0x89, 0x50, 0x4e, 0x47]), logcat: '10-25 00:00:00.000 I/tag: hello' },
  );
  assert.match(rec.id, /^\d{8}-\d{6}$/);
  assert.equal(rec.screenshot, 'screenshot.png');
  assert.equal(rec.logcat, 'logcat.txt');

  const runs = listRuns(runsDir);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.result, 'ok');
  assert.ok(fs.existsSync(path.join(runsDir, rec.id, 'screenshot.png')));
  fs.rmSync(root, { recursive: true, force: true });
});
