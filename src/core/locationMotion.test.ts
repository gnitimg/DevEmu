import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LocationMotion,
  RouteWalker,
  bearingOf,
  destination,
  haversineM,
  sanitizeLocationConfig,
  startLocation,
  stopLocation,
  nudgeLocation,
  pauseLocation,
  locationStatus,
  parseRouteText,
  teleportLocation,
  type LocationConfig,
  type NudgeKey,
} from './location.ts';

function config(overrides: Partial<LocationConfig> = {}): LocationConfig {
  const r = sanitizeLocationConfig({
    mode: 'manual',
    anchor: { lat: 39.9, lon: 116.4 },
    speedJitterPct: 0,
    cadenceJitterPct: 0,
    strideJitterPct: 0,
    gpsNoiseM: 0,
    ...overrides,
  });
  assert.ok(r.ok);
  return r.config;
}

function advance(m: LocationMotion, seconds: number): void {
  for (let t = 0; t < seconds - 1e-8; t += 0.05) m.advance(0.05);
}

test('键位对应罗盘方向，起步与松键滑行连续', () => {
  const m = new LocationMotion(config());
  m.keys.up = true;
  advance(m, 10);
  assert.ok(Math.abs(m.speedMps - 1.4) < 1e-6);
  assert.ok(Math.abs((m.cadenceSpm * m.strideM) / 60 - m.speedMps) < 1e-9);
  assert.ok(Math.abs(m.steps * m.strideM - m.distanceM) < 1e-8);
  assert.ok(Math.abs(haversineM(m.config.anchor, m.pos) - m.distanceM) < 0.001);
  assert.ok(m.pos.lat > m.config.anchor.lat);
  assert.ok(Math.abs(m.pos.lon - m.config.anchor.lon) < 1e-9);
  assert.ok(Math.abs(m.headingDeg) < 1e-6);
  const atRelease = m.pos.lat;
  m.keys.up = false;
  advance(m, 2);
  assert.ok(m.pos.lat > atRelease, '松键后沿原方向减速滑行');
  assert.equal(m.speedMps, 0);
  assert.equal(m.cadenceSpm, 0);
});

test('WASD 分别对应北南西东，四个键都产生速度', () => {
  const cases: [NudgeKey, number, (m: LocationMotion) => boolean][] = [
    ['up', 0, (m) => m.pos.lat > m.config.anchor.lat],
    ['down', 180, (m) => m.pos.lat < m.config.anchor.lat],
    ['left', 270, (m) => m.pos.lon < m.config.anchor.lon],
    ['right', 90, (m) => m.pos.lon > m.config.anchor.lon],
  ];
  for (const [key, heading, moved] of cases) {
    const m = new LocationMotion(config());
    m.keys[key] = true;
    advance(m, 5);
    assert.ok(m.speedMps > 0, `${key} 键应产生速度`);
    assert.ok(moved(m), `${key} 应沿对应罗盘方向移动`);
    assert.ok(Math.abs(m.courseDeg - heading) < 1e-6, `${key} 航向应为 ${heading}°`);
    assert.ok(Math.abs(m.headingDeg - heading) < 1e-6, `${key} 朝向应收敛到 ${heading}°`);
    // 垂直方向分量必须为零，才是正方向
    if (heading % 180 === 0) assert.ok(Math.abs(m.pos.lon - m.config.anchor.lon) < 1e-9);
    else assert.ok(Math.abs(m.pos.lat - m.config.anchor.lat) < 1e-9);
  }
});

test('双键组合沿 45° 夹角直行，不会绕圈', () => {
  const m = new LocationMotion(config());
  m.keys.up = true;
  m.keys.left = true;
  advance(m, 10);
  assert.ok(m.speedMps > 0);
  // destination 为大圆步进，恒定初始方位角拼接会有微小测地漂移，0.01° 内视为直行
  assert.ok(Math.abs(bearingOf(m.config.anchor, m.pos) - 315) < 0.01, 'W+A 应沿西北 45° 直行');
  assert.ok(Math.abs(m.courseDeg - 315) < 1e-6);
  assert.ok(Math.abs(m.headingDeg - 315) < 1e-6);
  assert.ok(haversineM(m.config.anchor, m.pos) > 5);
});

test('南北换向先减速再反向，速度连续', () => {
  const m = new LocationMotion(config());
  m.keys.up = true;
  advance(m, 10);
  m.keys.up = false;
  m.keys.down = true;
  const atSwitch = m.pos.lat;
  m.advance(0.05);
  assert.ok(m.pos.lat > atSwitch, '换向先减速，不能瞬间反向');
  let previous = m.speedMps;
  for (let i = 0; i < 400; i++) {
    m.advance(0.05);
    assert.ok(m.speedMps - previous <= 0.060001, '速度变化受加速度限制');
    previous = m.speedMps;
  }
  assert.ok(m.pos.lat < atSwitch, '减速完成后向南');
  assert.ok(Math.abs(m.headingDeg - 180) < 1);
});

test('航向收敛与暂停一致，相反键抵消', () => {
  const m = new LocationMotion(config());
  m.keys.left = true;
  advance(m, 1);
  assert.ok(Math.abs(m.headingDeg - 270) < 0.001);
  assert.ok(Math.abs(m.turnRateRad + Math.PI / 2) < 0.001);
  m.keys.right = true;
  m.keys.up = m.keys.down = true;
  advance(m, 2);
  assert.ok(m.speedMps < 1e-9);
  assert.equal(m.cadenceSpm, 0);
  m.setPaused(true);
  const before = { pos: { ...m.pos }, steps: m.steps, elapsed: m.elapsedSec };
  advance(m, 2);
  assert.deepEqual(m.pos, before.pos);
  assert.equal(m.steps, before.steps);
  assert.equal(m.elapsedSec, before.elapsed);
  m.setPaused(false);
  advance(m, 1);
  assert.equal(m.speedMps, 0);
});

test('换向时航向与侧向加速度一致，最终沿目标方向直行', () => {
  const m = new LocationMotion(config());
  m.keys.up = true;
  advance(m, 3);
  m.keys.right = true;
  let turned = false;
  for (let i = 0; i < 200; i++) {
    m.advance(0.05);
    assert.ok(
      Math.abs(m.lateralAccelerationMps2 - m.speedMps * m.turnRateRad) < 1e-9,
    );
    assert.ok(Math.abs(m.speedMps - (m.cadenceSpm * m.strideM) / 60) < 1e-8);
    if (Math.abs(m.turnRateRad) > 0.1) turned = true;
  }
  assert.ok(turned, '换向过程航向持续旋转');
  assert.ok(Math.abs(m.courseDeg - 45) < 0.1, '速度矢量应收敛到东北 45°');
  assert.ok(Math.abs(m.headingDeg - 45) < 0.5);
});

test('带波动的长时间运动始终满足速度 = 步频 × 步幅 / 60', () => {
  const m = new LocationMotion(
    config({ speedJitterPct: 50, strideJitterPct: 50, cadenceJitterPct: 50 }),
  );
  m.keys.up = true;
  for (let i = 0; i < 4000; i++) {
    const previous = m.speedMps;
    m.advance(0.05);
    assert.ok(Math.abs(m.speedMps - (m.cadenceSpm * m.strideM) / 60) < 1e-8);
    assert.ok(Math.abs(m.speedMps - previous) <= 0.060001);
    assert.ok(m.cadenceSpm <= 240.001);
  }
});

test('路线到终点保持静止，循环路线与跨日期线坐标正确', () => {
  const a = { lat: 0, lon: 179.9999 };
  const b = destination(a, 90, 30);
  const walker = new RouteWalker([a, b], false);
  walker.advance(15);
  assert.ok(Math.abs(haversineM(a, walker.position) - 15) < 0.001);
  const m = new LocationMotion(
    config({ mode: 'route', anchor: a, route: [a, b], loop: false }),
  );
  advance(m, 40);
  assert.equal(m.finished, true);
  assert.equal(m.speedMps, 0);
  assert.ok(haversineM(m.pos, b) < 0.001);
  const count = m.steps;
  advance(m, 2);
  assert.equal(m.steps, count);
  assert.equal(
    sanitizeLocationConfig({ mode: 'route', anchor: a, route: [a, a] }).ok,
    false,
  );
});

test('GPX 经纬度属性顺序和引号不影响导入，保留完整长路线', () => {
  assert.deepEqual(
    parseRouteText(
      '<rtept lon=\'116.4\' lat=\'39.9\'/><trkpt lat="40" lon="117"/>',
    ),
    [
      { lat: 39.9, lon: 116.4 },
      { lat: 40, lon: 117 },
    ],
  );
  const points = Array.from({ length: 1200 }, (_, i) => ({
    lat: 39 + i / 10000,
    lon: 116,
  }));
  assert.equal(config({ mode: 'route', route: points }).route?.length, 1200);
});

test('注入首针为锚点，GPS 含节速度，停止恢复传感器且不再下发', async () => {
  const commands: string[] = [];
  let now = 0,
    closed = false;
  const serial = 'emulator-5590';
  const connect = async () => ({
    send: async (command: string) => {
      commands.push(command);
      if (command === 'sensor status')
        return 'acceleration: enabled.\ngyroscope: enabled.';
      if (command.startsWith('sensor get'))
        return command.slice(11) + ' = 1:2:3';
      return '';
    },
    close: () => {
      closed = true;
    },
  });
  try {
    assert.ok(
      (
        await startLocation(
          { adbPath: 'unused', connect, now: () => now },
          serial,
          config(),
        )
      ).ok,
    );
    assert.match(
      commands.find((c) => c.startsWith('geo fix'))!,
      /116\.400000 39\.900000 12\.000000 10 0\.000000$/,
    );
    nudgeLocation(serial, 'up', true);
    for (let i = 0; i < 4; i++) {
      now += 400;
      nudgeLocation(serial, 'up', true);
    }
    await new Promise((r) => setTimeout(r, 70));
    const s = locationStatus(serial)!;
    assert.ok(s.distanceM > 0);
    assert.match(
      commands.filter((c) => c.startsWith('geo fix')).at(-1)!,
      / 2\.721\d+$/,
    );
    pauseLocation(serial, true);
    const distance = locationStatus(serial)!.distanceM;
    now += 1000;
    nudgeLocation(serial, 'up', false);
    assert.equal(locationStatus(serial)!.distanceM, distance);
  } finally {
    await stopLocation(serial);
  }
  assert.ok(closed);
  assert.ok(commands.includes('sensor set acceleration 1:2:3'));
  const count = commands.length;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(commands.length, count);
  assert.equal(locationStatus(serial), null);
});

test('手动会话内传送立即生效且不计里程', async () => {
  const serial = 'emulator-5594';
  const commands: string[] = [];
  const shellCalls: string[][] = [];
  let now = 0;
  const connect = async () => ({
    send: async (command: string) => {
      commands.push(command);
      return '';
    },
    close: () => undefined,
  });
  try {
    assert.ok(
      (
        await startLocation(
          {
            adbPath: 'unused',
            connect,
            shell: async (args) => { shellCalls.push(args); },
            now: () => now,
          },
          serial,
          config(),
        )
      ).ok,
    );
    assert.deepEqual(shellCalls, [['svc', 'location', 'enable']]);
    const before = locationStatus(serial)!;
    assert.ok(before.lat !== 31.2 || before.lon !== 121.5);
    assert.ok(teleportLocation(serial, 31.2, 121.5));
    const after = locationStatus(serial)!;
    assert.equal(after.lat, 31.2);
    assert.equal(after.lon, 121.5);
    assert.equal(after.distanceM, before.distanceM);
    now += 400;
    await new Promise((r) => setTimeout(r, 80));
    assert.match(
      commands.filter((c) => c.startsWith('geo fix')).at(-1)!,
      /121\.500000 31\.200000/,
    );
    assert.equal(teleportLocation(serial, 999, 0), false);
  } finally {
    await stopLocation(serial);
  }
  assert.equal(locationStatus(serial), null);
  assert.equal(teleportLocation('emulator-5599', 31.2, 121.5), false);
});

test('GPS 双通道失败不会假报启动成功，单传感器拒绝不影响 GPS', async () => {
  const serial = 'emulator-5592';
  const fail = await startLocation(
    {
      adbPath: 'unused',
      connect: async () => {
        throw Error('offline');
      },
      sendAdb: async () => {
        throw Error('GPS offline');
      },
    },
    serial,
    config(),
  );
  assert.equal(fail.ok, false);
  assert.equal(locationStatus(serial), null);
  const commands: string[] = [];
  try {
    const result = await startLocation(
      {
        adbPath: 'unused',
        connect: async () => ({
          send: async (c) => {
            commands.push(c);
            if (c === 'sensor status')
              return 'acceleration: enabled.\norientation: enabled.';
            if (c.startsWith('sensor get')) return 'sensor = 0:9.8:0';
            if (c.startsWith('sensor set orientation'))
              throw Error('unsupported');
            return '';
          },
          close: () => undefined,
        }),
      },
      serial,
      config(),
    );
    assert.ok(result.ok);
    await new Promise((r) => setTimeout(r, 100));
    const s = locationStatus(serial)!;
    assert.ok(s.viaConsole);
    assert.deepEqual(s.sensors, ['acceleration']);
    assert.match(s.sensorError!, /unsupported/);
    assert.ok(commands.some((c) => c.startsWith('sensor set acceleration')));
  } finally {
    await stopLocation(serial);
  }
});
