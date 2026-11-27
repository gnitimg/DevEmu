import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAvdPrefs, writeAvdPrefs } from './avd.ts';
import type { Scope } from './types.ts';

const SHARED: Scope = { kind: 'shared' };
const PROJECT: Scope = { kind: 'project', projectId: 'p1' };

function withAvd(scope: Scope, name: string, run: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-prefs-'));
  try {
    const dir = path.join(
      root,
      scope.kind === 'shared'
        ? 'devices'
        : path.join('projects', scope.projectId),
      'avd',
      `${name}.avd`,
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.ini'), 'hw.device.name=pixel_6\n');
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('没有偏好文件时按默认：截图录屏不带边框', () => {
  withAvd(SHARED, 'Pixel_6', (root) => {
    assert.deepEqual(readAvdPrefs(root, SHARED, 'Pixel_6'), {
      captureFrame: false,
    });
  });
});

test('偏好往返保存，只改给出的项且不动 config.ini', () => {
  withAvd(SHARED, 'Pixel_6', (root) => {
    assert.deepEqual(
      writeAvdPrefs(root, SHARED, 'Pixel_6', { captureFrame: true }),
      { ok: true },
    );
    assert.deepEqual(readAvdPrefs(root, SHARED, 'Pixel_6'), {
      captureFrame: true,
    });
    assert.deepEqual(
      writeAvdPrefs(root, SHARED, 'Pixel_6', { captureFrame: false }),
      { ok: true },
    );
    assert.deepEqual(readAvdPrefs(root, SHARED, 'Pixel_6'), {
      captureFrame: false,
    });
    const avdDir = path.join(root, 'devices', 'avd', 'Pixel_6.avd');
    assert.equal(
      fs.readFileSync(path.join(avdDir, 'config.ini'), 'utf8'),
      'hw.device.name=pixel_6\n',
    );
    // 偏好落在 .avd 目录内的旁挂文件里
    assert.deepEqual(fs.readdirSync(avdDir).sort(), [
      'config.ini',
      'devemu.json',
    ]);
  });
});

test('偏好按作用域隔离：同名虚拟机互不影响', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-prefs-'));
  try {
    for (const scope of [SHARED, PROJECT]) {
      const dir = path.join(
        root,
        scope.kind === 'shared'
          ? 'devices'
          : path.join('projects', scope.projectId),
        'avd',
        'Twin.avd',
      );
      fs.mkdirSync(dir, { recursive: true });
    }
    assert.deepEqual(
      writeAvdPrefs(root, PROJECT, 'Twin', { captureFrame: true }),
      { ok: true },
    );
    assert.equal(readAvdPrefs(root, PROJECT, 'Twin').captureFrame, true);
    assert.equal(readAvdPrefs(root, SHARED, 'Twin').captureFrame, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('偏好文件损坏时回退默认，不抛错', () => {
  withAvd(SHARED, 'Pixel_6', (root) => {
    fs.writeFileSync(
      path.join(root, 'devices', 'avd', 'Pixel_6.avd', 'devemu.json'),
      '{broken',
    );
    assert.deepEqual(readAvdPrefs(root, SHARED, 'Pixel_6'), {
      captureFrame: false,
    });
    // 非布尔的值也不认
    fs.writeFileSync(
      path.join(root, 'devices', 'avd', 'Pixel_6.avd', 'devemu.json'),
      '{"captureFrame":"yes"}',
    );
    assert.deepEqual(readAvdPrefs(root, SHARED, 'Pixel_6'), {
      captureFrame: false,
    });
  });
});

test('虚拟机不存在或名称非法时写入报错', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-prefs-'));
  try {
    const missing = writeAvdPrefs(root, SHARED, 'Ghost', {
      captureFrame: true,
    });
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? '', /虚拟机不存在/);
    // 名称直接进路径拼接，不能放行上跳
    const evil = writeAvdPrefs(root, SHARED, '..\\..\\x', {
      captureFrame: true,
    });
    assert.equal(evil.ok, false);
    assert.match(evil.error ?? '', /非法/);
    assert.deepEqual(readAvdPrefs(root, SHARED, '../x'), {
      captureFrame: false,
    });
    assert.ok(!fs.existsSync(path.join(root, 'x.avd')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
