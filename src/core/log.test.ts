import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendLog, clearLogs, logFile, logsDir } from './log.ts';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-test-'));
}

test('appendLog 追加带时间戳的行', () => {
  const root = tmpRoot();
  appendLog(root, '第一行');
  appendLog(root, '第二行');
  const text = fs.readFileSync(logFile(root), 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.endsWith('第一行'));
  assert.match(lines[0]!, /^\[\d{4}-\d{2}-\d{2}T/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('超过上限时轮转为 app.old.log', () => {
  const root = tmpRoot();
  fs.mkdirSync(logsDir(root), { recursive: true });
  fs.writeFileSync(logFile(root), 'x'.repeat(2 * 1024 * 1024 + 1), 'utf8');
  appendLog(root, '触发轮转');
  assert.ok(fs.existsSync(path.join(logsDir(root), 'app.old.log')));
  assert.ok(fs.readFileSync(logFile(root), 'utf8').includes('触发轮转'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('clearLogs 只删 .log 文件并返回数量', () => {
  const root = tmpRoot();
  appendLog(root, 'a');
  fs.writeFileSync(path.join(logsDir(root), 'app.old.log'), 'old', 'utf8');
  fs.writeFileSync(path.join(logsDir(root), 'keep.txt'), 'not a log', 'utf8');
  assert.equal(clearLogs(root), 2);
  assert.equal(fs.readdirSync(logsDir(root)).join(','), 'keep.txt');
  // 目录不存在时返回 0
  assert.equal(clearLogs(tmpRoot()), 0);
  fs.rmSync(root, { recursive: true, force: true });
});
