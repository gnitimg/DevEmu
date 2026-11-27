import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTransform,
  canvasSize,
  compose,
  imageTransform,
  pickContainer,
  videoBitrate,
} from './captureProtocol.ts';

const rect = { x: 60, y: 69, w: 1080, h: 2400 };
const corners = (
  iw: number,
  ih: number,
  t: ReturnType<typeof imageTransform>,
) => {
  const near = ([x, y]: [number, number]) => [Math.round(x), Math.round(y)];
  // 画面四角：左上、右上、左下、右下
  return [
    near(applyTransform(t, 0, 0)),
    near(applyTransform(t, iw, 0)),
    near(applyTransform(t, 0, ih)),
    near(applyTransform(t, iw, ih)),
  ];
};

test('不旋转：画面原样铺满目标矩形', () => {
  assert.deepEqual(corners(1080, 2400, imageTransform(0, 1080, 2400, rect)), [
    [60, 69],
    [1140, 69],
    [60, 2469],
    [1140, 2469],
  ]);
});

test('顺时针 90°：画面左上角落到目标右上角', () => {
  const t = imageTransform(90, 1080, 2400, { x: 338, y: 68, w: 2400, h: 1080 });
  assert.deepEqual(corners(1080, 2400, t), [
    [2738, 68], // 左上 → 右上
    [2738, 1148], // 右上 → 右下
    [338, 68], // 左下 → 左上
    [338, 1148], // 右下 → 左下
  ]);
  // 整数像素：直角处不应有残差
  for (const value of t)
    assert.ok(Number.isInteger(value) || Math.abs(value) < 1e-9);
});

test('逆时针 90°：画面左上角落到目标左下角（朝向 3 的横屏帧由此还原为竖屏）', () => {
  // 2400x1080 的横屏帧逆时针 90° 后应与 1080x2400 的原生画面同向：
  // 横屏帧的右上角是原生画面的左上角
  const t = imageTransform(-90, 2400, 1080, { x: 0, y: 0, w: 1080, h: 2400 });
  assert.deepEqual(corners(2400, 1080, t), [
    [0, 2400], // 左上 → 左下
    [0, 0], // 右上 → 左上
    [1080, 2400], // 左下 → 右下
    [1080, 0], // 右下 → 右上
  ]);
});

test('180°：对角互换', () => {
  const t = imageTransform(180, 1080, 2400, rect);
  assert.deepEqual(corners(1080, 2400, t), [
    [1140, 2469],
    [60, 2469],
    [1140, 69],
    [60, 69],
  ]);
});

test('目标矩形与画面尺寸不同时等比缩放（奇数边补成偶数的画布）', () => {
  const t = imageTransform(0, 1209, 2553, { x: 0, y: 0, w: 1210, h: 2554 });
  const [a, b, c, d] = t;
  assert.ok(b === 0 && c === 0);
  assert.ok(Math.abs(a! - 1210 / 1209) < 1e-12);
  assert.ok(Math.abs(d! - 2554 / 2553) < 1e-12);
});

test('compose：先内后外，等价于依次应用', () => {
  const outer = imageTransform(-90, 1209, 2553, {
    x: 0,
    y: 0,
    w: 2553,
    h: 1209,
  });
  const inner = imageTransform(90, 1080, 2400, rect);
  const both = compose(outer, inner);
  const viaInner = applyTransform(outer, ...applyTransform(inner, 540, 1200));
  const direct = applyTransform(both, 540, 1200);
  assert.ok(Math.abs(viaInner[0]! - direct[0]!) < 1e-6);
  assert.ok(Math.abs(viaInner[1]! - direct[1]!) < 1e-6);
  // 帧中心先转到 layout 里的屏幕中心 (600, 1269)，整幅再逆时针 90°：
  // layout 的 x=600 落到画布 y=1209−600，layout 的 y=1269 落到画布 x=1269
  assert.ok(Math.abs(direct[0]! - 1269) < 1e-6, `x=${direct[0]}`);
  assert.ok(Math.abs(direct[1]! - 609) < 1e-6, `y=${direct[1]}`);
});

test('videoBitrate：1080×2400 约 12Mbps，小画面不低于 4Mbps，大画面不超过 20Mbps', () => {
  assert.equal(videoBitrate(1080, 2400), 12e6);
  assert.equal(videoBitrate(640, 480), 4e6);
  assert.equal(videoBitrate(3840, 2160), 20e6);
});

test('封装选择：MP4 优先，不支持时依次退到 WebM，全不支持返回 undefined', () => {
  const mp4 = pickContainer((m) => m.startsWith('video/mp4'));
  assert.deepEqual(mp4, {
    mimeType: 'video/mp4;codecs=avc1.640028',
    extension: 'mp4',
  });
  const webm = pickContainer((m) => m === 'video/webm;codecs=vp8');
  assert.deepEqual(webm, {
    mimeType: 'video/webm;codecs=vp8',
    extension: 'webm',
  });
  assert.equal(
    pickContainer(() => false),
    undefined,
  );
});

test('画布尺寸：竖屏皮肤横过来时宽高互换，奇数边补成偶数', () => {
  const portrait = { width: 1209, height: 2553, canvasRotation: 0 };
  assert.deepEqual(canvasSize({ width: 1080, height: 2400 }, portrait), {
    width: 1210,
    height: 2554,
  });
  assert.deepEqual(
    canvasSize(
      { width: 2400, height: 1080 },
      { ...portrait, canvasRotation: 90 },
    ),
    {
      width: 2554,
      height: 1210,
    },
  );
  // 不带边框：首帧已经是开录时朝向下的尺寸，原样用（含奇数边补偶）
  assert.deepEqual(canvasSize({ width: 2400, height: 1080 }, null), {
    width: 2400,
    height: 1080,
  });
  assert.deepEqual(canvasSize({ width: 1079, height: 2399 }, null), {
    width: 1080,
    height: 2400,
  });
});
