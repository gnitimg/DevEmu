import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  avdDefaultName,
  datedVmName,
  hosDefaultName,
  sanitizeAvdModel,
} from './vmNames.ts';

// 2026-09-11 本地时间
const DAY = new Date(2026, 8, 11, 10, 0, 0);

test('默认名称：型号-日期+两位序号', () => {
  assert.equal(datedVmName('Pixel 9 Pro', [], DAY), 'Pixel 9 Pro-2026091101');
  assert.equal(
    datedVmName(
      'Pixel 9 Pro',
      ['Pixel 9 Pro-2026091101', 'Pixel 9 Pro-2026091103', 'Pixel 8-2026091109'],
      DAY,
    ),
    'Pixel 9 Pro-2026091104',
  );
  // 其他日期/其他型号不参与编号
  assert.equal(datedVmName('Pixel 9 Pro', ['Pixel 9 Pro-2026091005'], DAY), 'Pixel 9 Pro-2026091101');
});

test('Android 型号转 AVD 合法名（空格换下划线，去掉非法字符）', () => {
  assert.equal(sanitizeAvdModel('Pixel 9 Pro'), 'Pixel_9_Pro');
  assert.equal(avdDefaultName('Pixel 9 Pro', [], DAY), 'Pixel_9_Pro-2026091101');
  assert.match(avdDefaultName('Pixel 9 Pro (Fold)', [], DAY), /^[\w.-]+$/);
  // 全是非法字符时仍有兜底名
  assert.equal(sanitizeAvdModel('（）'), 'device');
  // 名称长度不超过 AVD 白名单上限（100）
  assert.ok(avdDefaultName('x'.repeat(200), [], DAY).length <= 100);
});

test('HarmonyOS 型号保留空格', () => {
  assert.equal(hosDefaultName('Pura 90 Pro', [], DAY), 'Pura 90 Pro-2026091101');
  assert.equal(hosDefaultName('Pura 90 Pro', ['Pura 90 Pro-2026091101'], DAY), 'Pura 90 Pro-2026091102');
  // 文件名非法字符换成下划线，长度不超过 HOS 名称上限（64）
  const long = hosDefaultName('a'.repeat(200), [], DAY);
  assert.ok(long.length <= 64);
  assert.equal(hosDefaultName('Pura/90:Pro', [], DAY), 'Pura_90_Pro-2026091101');
});
