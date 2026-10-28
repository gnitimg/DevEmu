import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromGoogleMap, toGoogleMap } from './mapCoordinates.ts';

test('北京 Google 街道坐标往返，新加坡与伦敦保持原值', () => {
  const p = { lat: 39.915, lon: 116.404 };
  const google = toGoogleMap(p);
  assert.ok(Math.abs(google.lat - 39.91640428150164) < 1e-9);
  assert.ok(Math.abs(google.lon - 116.41024449916938) < 1e-9);
  const original = fromGoogleMap(google);
  assert.ok(
    Math.abs(original.lat - p.lat) + Math.abs(original.lon - p.lon) < 1e-9,
  );
  const singapore = { lat: 1.3521, lon: 103.8198 };
  const london = { lat: 51.5074, lon: -0.1278 };
  assert.deepEqual(toGoogleMap(london), london);
  assert.deepEqual(fromGoogleMap(london), london);
  assert.deepEqual(toGoogleMap(singapore), singapore);
});
