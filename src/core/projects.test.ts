import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProject, listProjects, updateProject, deleteProject, sanitizeId } from './projects.ts';

test('项目创建/列表/更新/删除', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-proj-'));
  const p1 = createProject(root, '购物 App', '商城 v2 重构');
  // 目录 id 只保留 ASCII 安全字符（工具链路径兼容）；显示名仍为原文
  assert.equal(p1.id, 'App');
  assert.equal(p1.name, '购物 App');
  assert.equal(p1.note, '商城 v2 重构');

  const p2 = createProject(root, '购物 App');
  assert.equal(p2.id, 'App-2');
  assert.notEqual(p1.id, p2.id);

  let list = listProjects(root);
  assert.equal(list.length, 2);

  updateProject(root, p1.id, { name: '购物 App 主线', note: '' });
  list = listProjects(root);
  const updated = list.find((p) => p.id === p1.id)!;
  assert.equal(updated.name, '购物 App 主线');
  assert.equal(updated.note, undefined);

  assert.equal(await deleteProject(root, p1.id), true);
  assert.equal(listProjects(root).length, 1);
  // 不存在的删不掉
  assert.equal(await deleteProject(root, 'nope'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('sanitizeId 过滤非法字符', () => {
  assert.equal(sanitizeId('a/b:c*d'), 'a_b_c_d');
  // 非 ASCII 字符不进目录 id（工具链路径兼容）
  assert.equal(sanitizeId('购物 App'), 'App');
  // 全部字符非法时回退生成 id
  assert.match(sanitizeId('   '), /^project-/);
  assert.match(sanitizeId('购物'), /^project-/);
});
