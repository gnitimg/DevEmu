import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordCrash, listCrashes, hasCrashKey, readCrashLog } from './crashes.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-crash-'));
}

test('崩溃记录落盘：完整日志单存文件，列表按时间倒序', () => {
  const dir = tmp();
  const a = recordCrash(
    dir,
    {
      os: 'android',
      at: '2026-11-09T00:52:00.000Z',
      device: 'Pixel_9_Pro-2026110901',
      source: 'com.example.demo',
      sourceLabel: '示例应用',
      kind: 'java',
      summary: 'NullPointerException: Attempt to invoke virtual method',
    },
    '完整 logcat',
  );
  const b = recordCrash(dir, {
    os: 'hos',
    at: '2026-11-09T01:00:00.000Z',
    device: 'Pura 90 Pro-2026110901',
    source: 'SYSTEM',
    kind: 'native',
    summary: '信号 11 (SIGSEGV)',
    key: 'cppcrash-com.example.demo-4321-20261109010000001.log',
  });
  assert.notEqual(a.id, b.id);
  assert.equal(a.log, 'crash.log');
  assert.equal(b.log, undefined);

  assert.deepEqual(
    listCrashes(dir).map((r) => r.id),
    [b.id, a.id],
  );
  assert.equal(readCrashLog(dir, a.id), '完整 logcat');
  assert.equal(readCrashLog(dir, b.id), '');

  // HOS 故障日志按文件名去重，重启后不会重复入库
  assert.equal(hasCrashKey(dir, 'cppcrash-com.example.demo-4321-20261109010000001.log'), true);
  assert.equal(hasCrashKey(dir, 'unknown.log'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('同秒多条崩溃不互相覆盖，半写/无关目录不影响列表', () => {
  const dir = tmp();
  const ids = new Set<string>();
  for (let i = 0; i < 8; i++) {
    ids.add(
      recordCrash(dir, {
        os: 'android',
        at: new Date().toISOString(),
        device: 'Pixel_9_Pro-2026110901',
        source: 'com.example.demo',
        kind: 'java',
        summary: 'boom',
      }).id,
    );
  }
  assert.equal(ids.size, 8);

  fs.mkdirSync(path.join(dir, 'broken'));
  fs.writeFileSync(path.join(dir, 'broken', 'crash.json'), '{oops', 'utf8');
  fs.writeFileSync(path.join(dir, 'stray.txt'), 'x', 'utf8');
  assert.equal(listCrashes(dir).length, 8);
  // id 直接拼进读取路径：只接受记录目录的字符集
  assert.equal(readCrashLog(dir, '../../secret'), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('记录目录不存在时列表为空', () => {
  assert.deepEqual(listCrashes(path.join(tmp(), 'nope')), []);
});
