import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RouteWalker,
  bearingOf,
  derivedStrideM,
  destination,
  haversineM,
  idleWave,
  makeNoise,
  parseRouteText,
  sanitizeLocationConfig,
  stepWave,
} from './location.ts';

test('derivedStrideM 速度÷步频', () => {
  // 1.4 m/s ÷ 112 步/分 → 步幅 0.75m
  assert.equal(Math.round(derivedStrideM(1.4, 112) * 100) / 100, 0.75);
  assert.equal(derivedStrideM(1.4, 0), 0);
});

test('haversineM 与 destination 互洽（北上 100m 往返）', () => {
  const start = { lat: 39.9, lon: 116.4 };
  const moved = destination(start, 0, 100);
  const dist = haversineM(start, moved);
  assert.ok(Math.abs(dist - 100) < 0.5, `expected ~100m, got ${dist}`);
  assert.ok(moved.lat > start.lat);
  assert.equal(Math.abs(moved.lon - start.lon) < 1e-9, true);
});

test('bearingOf 正东 = 90°，正南 = 180°', () => {
  const a = { lat: 39.9, lon: 116.4 };
  assert.ok(Math.abs(bearingOf(a, { lat: 39.9, lon: 116.41 })) - 90 < 0.1);
  assert.ok(Math.abs(bearingOf(a, { lat: 39.89, lon: 116.4 }) - 180) < 0.1);
});

test('RouteWalker 两点路线推进与终点', () => {
  const a = { lat: 39.9, lon: 116.4 };
  const b = destination(a, 90, 200);
  const w = new RouteWalker([a, b], false);
  assert.equal(w.finished, false);
  assert.equal(w.advance(100), false);
  const mid = w.position;
  assert.ok(Math.abs(haversineM(a, mid) - 100) < 1);
  assert.ok(Math.abs(w.headingDeg - 90) < 1);
  assert.equal(w.advance(1000), true);
  assert.equal(w.finished, true);
  assert.ok(haversineM(b, w.position) < 0.5);
});

test('RouteWalker 循环路线绕回起点', () => {
  const a = { lat: 39.9, lon: 116.4 };
  const b = destination(a, 90, 100);
  const w = new RouteWalker([a, b], true);
  assert.equal(w.advance(150), false);
  // 已越过 b 进入回程段
  assert.ok(haversineM(w.position, b) < 60);
  assert.equal(w.advance(50), false);
  // 回到起点附近，循环继续
  assert.ok(haversineM(a, w.position) < 2);
});

test('makeNoise 有界且随时间变化', () => {
  const n = makeNoise(5);
  let min = Infinity;
  let max = -Infinity;
  for (let t = 0; t < 300; t += 0.5) {
    const v = n(t);
    min = Math.min(min, v);
    max = Math.max(max, v);
    assert.ok(Math.abs(v) <= 5 + 1e-9);
  }
  assert.ok(max - min > 3);
});

test('stepWave 重力基线附近起伏，idleWave 近似静止', () => {
  const w = stepWave(0.37, 120);
  assert.ok(w.y > 6 && w.y < 14, `baseline out of range: ${w.y}`);
  assert.ok(Math.abs(w.x) < 3 && Math.abs(w.z) < 3);
  const idle = idleWave(1.23);
  assert.ok(Math.abs(idle.y - 9.81) < 0.05);
  assert.ok(Math.abs(idle.x) < 0.05);
});

test('sanitizeLocationConfig 清洗与拒绝', () => {
  const anchor = { lat: 39.9, lon: 116.4 };
  const good = sanitizeLocationConfig({
    mode: 'route',
    anchor,
    route: [
      { lat: 39.9, lon: 116.4 },
      { lat: 39.91, lon: 116.41 },
    ],
    loop: true,
    speedMps: 999,
  });
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.config.speedMps, 12);
    assert.equal(good.config.loop, true);
    assert.deepEqual(good.config.anchor, anchor);
  }
  // 无锚点一律拒绝
  assert.equal(
    sanitizeLocationConfig({
      mode: 'manual',
      route: [
        { lat: 1, lon: 1 },
        { lat: 2, lon: 2 },
      ],
    }).ok,
    false,
  );
  // 路线模式需要至少两个途经点
  assert.equal(
    sanitizeLocationConfig({ mode: 'route', anchor, route: [{ lat: 1, lon: 1 }] }).ok,
    false,
  );
  // 手动模式只需锚点
  const manual = sanitizeLocationConfig({ mode: 'manual', anchor });
  assert.equal(manual.ok, true);
  // 抖动夹取到 0-50
  const jitter = sanitizeLocationConfig({
    mode: 'manual',
    anchor,
    speedJitterPct: 99,
    strideJitterPct: -3,
    cadenceJitterPct: 60,
  });
  assert.equal(jitter.ok, true);
  if (jitter.ok) {
    assert.equal(jitter.config.speedJitterPct, 50);
    assert.equal(jitter.config.strideJitterPct, 0);
    assert.equal(jitter.config.cadenceJitterPct, 50);
  }
});

test('parseRouteText 支持 lat,lon 行与 GPX trkpt', () => {
  const csv = parseRouteText(
    '39.9,116.4\n39.91, 116.41\nbad line\n39.92,116.42',
  );
  assert.equal(csv.length, 3);
  assert.deepEqual(csv[0], { lat: 39.9, lon: 116.4 });
  const gpx = parseRouteText(
    '<trkpt lat="39.9001" lon="116.4001"/><trkpt lat="39.9002" lon="116.4002"/>',
  );
  assert.equal(gpx.length, 2);
  assert.deepEqual(gpx[1], { lat: 39.9002, lon: 116.4002 });
});
