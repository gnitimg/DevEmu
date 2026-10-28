import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deleteRoute,
  listRoutes,
  loadPrefs,
  loadRoute,
  savePrefs,
  saveRoute,
} from './locationStore.ts';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-locstore-'));
}

test('saveRoute/listRoutes/loadRoute 往返', () => {
  const root = tmpRoot();
  const pts = [
    { lat: 39.9, lon: 116.4 },
    { lat: 39.91, lon: 116.41 },
    { lat: 39.92, lon: 116.42 },
  ];
  const r1 = saveRoute(root, '长安街', pts);
  assert.equal(r1.ok, true);
  const r2 = saveRoute(root, '环线', pts.slice(0, 2));
  assert.equal(r2.ok, true);

  const list = listRoutes(root);
  assert.equal(list.length, 2);
  // 新的在前
  assert.equal(list[0]!.name, '环线');
  assert.equal(list[0]!.points.length, 2);

  const loaded = loadRoute(root, r1.ok ? r1.id : '');
  assert.ok(loaded);
  assert.equal(loaded.name, '长安街');
  assert.deepEqual(loaded.points, pts);
});

test('saveRoute 拒绝单点路线并清洗非法点', () => {
  const root = tmpRoot();
  assert.equal(saveRoute(root, 'x', [{ lat: 1, lon: 1 }]).ok, false);
  const mixed = saveRoute(root, 'mixed', [
    { lat: 39.9, lon: 116.4 },
    { lat: 999, lon: 0 },
    { lat: 'a' as unknown as number, lon: 0 },
    { lat: 39.91, lon: 116.41 },
  ]);
  assert.equal(mixed.ok, true);
  const loaded = loadRoute(root, mixed.ok ? mixed.id : '');
  assert.equal(loaded?.points.length, 2);
});

test('deleteRoute 删除且不炸缺失 id', () => {
  const root = tmpRoot();
  const r = saveRoute(root, 'x', [
    { lat: 1, lon: 1 },
    { lat: 2, lon: 2 },
  ]);
  assert.equal(r.ok, true);
  deleteRoute(root, r.ok ? r.id : '');
  assert.equal(listRoutes(root).length, 0);
  deleteRoute(root, '../../etc/passwd');
  deleteRoute(root, 'not-exist');
});

test('prefs 往返与容错', () => {
  const root = tmpRoot();
  assert.deepEqual(loadPrefs(root), {});
  savePrefs(root, {
    mode: 'manual',
    loop: true,
    speedMps: 1.6,
    cadenceSpm: 118,
    strideM: 0.8,
    speedJitterPct: 10,
    strideJitterPct: 5,
    cadenceJitterPct: 6,
    gpsNoiseM: 3,
    lastRouteId: 'abc',
  });
  const p = loadPrefs(root);
  assert.equal(p.mode, 'manual');
  assert.equal(p.speedMps, 1.6);
  assert.equal(p.lastRouteId, 'abc');
  // 损坏文件回空对象
  fs.writeFileSync(
    path.join(root, 'location', 'prefs.json'),
    '{broken',
    'utf8',
  );
  assert.deepEqual(loadPrefs(root), {});
});
