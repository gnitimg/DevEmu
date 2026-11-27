import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  captureDirs,
  captureStamp,
  ensureCaptureDir,
  mediaRoot,
} from './media.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-media-'));
}

test('图像根目录缺省落在数据根下的 media，可被设置覆盖', () => {
  const root = tmp();
  assert.deepEqual(captureDirs({ dataRoot: root }), {
    imgs: path.join(root, 'media', 'imgs'),
    videos: path.join(root, 'media', 'videos'),
  });
  assert.equal(mediaRoot({ dataRoot: root }), path.join(root, 'media'));
  const custom = path.join(root, '截图库');
  assert.equal(
    mediaRoot({ dataRoot: root, mediaDir: `  ${custom}  ` }),
    path.resolve(custom),
  );
  assert.equal(
    mediaRoot({ dataRoot: root, mediaDir: '   ' }),
    path.join(root, 'media'),
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('时间戳与既有截图命名一致：不含冒号与点', () => {
  assert.equal(
    captureStamp(new Date('2026-11-25T05:20:30.123Z')),
    '2026-11-25T05-20-30-123Z',
  );
});

test('ensureCaptureDir 建出目标目录', () => {
  const root = tmp();
  const dirs = ensureCaptureDir({ dataRoot: root }, 'videos');
  assert.equal(dirs, path.join(root, 'media', 'videos'));
  assert.ok(fs.statSync(dirs).isDirectory());
  fs.rmSync(root, { recursive: true, force: true });
});

test('缺省位置首次使用时旧版 screenshots 整目录并入 imgs', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'screenshots'));
  fs.writeFileSync(path.join(root, 'screenshots', 'old.png'), 'png');
  const imgs = ensureCaptureDir({ dataRoot: root }, 'imgs');
  assert.equal(imgs, path.join(root, 'media', 'imgs'));
  assert.equal(fs.readFileSync(path.join(imgs, 'old.png'), 'utf8'), 'png');
  assert.ok(!fs.existsSync(path.join(root, 'screenshots')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('imgs 已存在时旧截图原样保留、不并入', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'screenshots'));
  fs.writeFileSync(path.join(root, 'screenshots', 'old.png'), 'old');
  fs.mkdirSync(path.join(root, 'media', 'imgs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'media', 'imgs', 'new.png'), 'new');
  ensureCaptureDir({ dataRoot: root }, 'imgs');
  assert.ok(fs.existsSync(path.join(root, 'screenshots', 'old.png')));
  assert.ok(!fs.existsSync(path.join(root, 'media', 'imgs', 'old.png')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('自定义位置不搬迁数据根里的旧截图', () => {
  const root = tmp();
  const custom = path.join(root, 'elsewhere');
  fs.mkdirSync(path.join(root, 'screenshots'));
  fs.writeFileSync(path.join(root, 'screenshots', 'old.png'), 'old');
  const imgs = ensureCaptureDir({ dataRoot: root, mediaDir: custom }, 'imgs');
  assert.equal(imgs, path.join(custom, 'imgs'));
  assert.ok(fs.statSync(imgs).isDirectory());
  assert.ok(fs.existsSync(path.join(root, 'screenshots', 'old.png')));
  fs.rmSync(root, { recursive: true, force: true });
});
