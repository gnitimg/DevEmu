import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSharedFrame } from './sharedFrame.ts';

test('读到完整的共享帧，返回等长的 ArrayBuffer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-shm-'));
  try {
    const file = path.join(dir, 'f.rgba');
    const body = Buffer.alloc(300, 7);
    fs.writeFileSync(file, body);
    const got = readSharedFrame(fs, { path: file, bytes: 300 });
    assert.ok(got instanceof ArrayBuffer);
    assert.equal(got.byteLength, 300);
    assert.ok(Buffer.from(got).equals(body));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('文件不够长或已不存在时返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-shm-'));
  try {
    const file = path.join(dir, 'f.rgba');
    fs.writeFileSync(file, Buffer.alloc(10));
    assert.equal(readSharedFrame(fs, { path: file, bytes: 300 }), null);
    assert.equal(
      readSharedFrame(fs, { path: path.join(dir, 'gone'), bytes: 300 }),
      null,
    );
    assert.equal(readSharedFrame(fs, { path: dir, bytes: 300 }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('读完时开头已被改写（写方在写下一帧）则重读，拿到的是新的一帧', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-shm-'));
  try {
    const file = path.join(dir, 'f.rgba');
    const bytes = 128 * 1024;
    fs.writeFileSync(file, Buffer.alloc(bytes, 1));
    let reads = 0;
    const racing = {
      openSync: fs.openSync,
      closeSync: fs.closeSync,
      readSync(
        fd: number,
        buffer: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
        position: number | null,
      ) {
        const done = fs.readSync(fd, buffer, offset, length, position);
        // 第一次整帧读完的瞬间，"写方"覆盖了整份文件
        if (++reads === 1) fs.writeFileSync(file, Buffer.alloc(bytes, 2));
        return done;
      },
    };
    const got = readSharedFrame(racing, { path: file, bytes });
    assert.ok(got);
    assert.equal(new Uint8Array(got)[0], 2, '应重读到新帧');
    assert.equal(new Uint8Array(got)[bytes - 1], 2);
    assert.equal(got.byteLength, bytes, '返回的是整帧，不是被截成开头一段');
    // 重读一次就稳定：第二轮整帧与开头各读一次
    assert.equal(reads, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('一直撞上写方（读不到稳定的一帧）时放弃并返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-shm-'));
  try {
    const file = path.join(dir, 'f.rgba');
    const bytes = 128 * 1024;
    fs.writeFileSync(file, Buffer.alloc(bytes, 1));
    let reads = 0;
    const hostile = {
      openSync: fs.openSync,
      closeSync: fs.closeSync,
      readSync(
        fd: number,
        buffer: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
        position: number | null,
      ) {
        const done = fs.readSync(fd, buffer, offset, length, position);
        if (++reads % 2 === 1)
          fs.writeFileSync(file, Buffer.alloc(bytes, (reads % 250) + 2));
        return done;
      },
    };
    assert.equal(readSharedFrame(hostile, { path: file, bytes }), null);
    // 确实重试过：每轮一整帧一开头各读一次
    assert.equal(reads, 6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
