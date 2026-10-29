import { run } from './exec.ts';
import { connectConsole, type EmuConsole } from './emuConsole.ts';
import { connectGps, type GpsController } from './emuGps.ts';

// 通过模拟器 GPS 与传感器接口注入；可用传感器由镜像决定，估算步数不等于系统计步器。

export interface LatLng {
  lat: number;
  lon: number;
}

export interface LocationConfig {
  mode: 'route' | 'manual';
  /** 锚点：地图上双击确认的起始位置（手动模式的行进起点） */
  anchor: LatLng;
  /** 路线模式：途经点序列（从路线库加载） */
  route?: LatLng[];
  /** 路线模式：走完后回到起点循环 */
  loop: boolean;
  speedMps: number;
  cadenceSpm: number;
  strideM: number;
  /** 速度抖动幅度（±%，0-50），方向随机 */
  speedJitterPct: number;
  /** 步幅抖动幅度（±%，0-50） */
  strideJitterPct: number;
  /** 步频抖动幅度（±%，0-50） */
  cadenceJitterPct: number;
  /** 定位漂移幅度（±m，0-50），方向随机 */
  gpsNoiseM: number;
  altitudeM?: number;
  headingDeg?: number;
  accelerationMps2?: number;
}

export type NudgeKey = 'up' | 'down' | 'left' | 'right';

// 档位数据在 walkProfiles（纯数据模块）：渲染层面板也要用，不能经本文件拉入 node 模块
export { PRESETS, derivedStrideM } from './walkProfiles.ts';

// ---------- 测地计算 ----------

const R = 6371008.8;
const rad = (d: number): number => (d * Math.PI) / 180;
const deg = (r: number): number => (r * 180) / Math.PI;

export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function destination(
  a: LatLng,
  bearingDeg: number,
  distM: number,
): LatLng {
  const br = rad(bearingDeg);
  const la = rad(a.lat);
  const lo = rad(a.lon);
  const dr = distM / R;
  const la2 = Math.asin(
    Math.sin(la) * Math.cos(dr) + Math.cos(la) * Math.sin(dr) * Math.cos(br),
  );
  const lo2 =
    lo +
    Math.atan2(
      Math.sin(br) * Math.sin(dr) * Math.cos(la),
      Math.cos(dr) - Math.sin(la) * Math.sin(la2),
    );
  return { lat: deg(la2), lon: ((deg(lo2) + 540) % 360) - 180 };
}

export function bearingOf(a: LatLng, b: LatLng): number {
  const la = rad(a.lat);
  const lb = rad(b.lat);
  const dlo = rad(b.lon - a.lon);
  const y = Math.sin(dlo) * Math.cos(lb);
  const x =
    Math.cos(la) * Math.sin(lb) - Math.sin(la) * Math.cos(lb) * Math.cos(dlo);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

// ---------- 抖动与步行波形 ----------

/** 多周期正弦叠加：平滑、有界（|n| ≤ amplitude）的"自然"抖动曲线 */
export function makeNoise(amplitude: number): (tSec: number) => number {
  const ph = [0, 1, 2].map(() => Math.random() * Math.PI * 2);
  const w = [23, 61, 151].map(
    (p) => (Math.PI * 2) / (p * (0.7 + Math.random() * 0.6)),
  );
  return (t) =>
    amplitude *
    (0.55 * Math.sin(w[0]! * t + ph[0]!) +
      0.3 * Math.sin(w[1]! * t + ph[1]!) +
      0.15 * Math.sin(w[2]! * t + ph[2]!));
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * 竖屏手持姿态的步行加速度波形：重力基线 y≈9.81，
 * 竖向起伏频率 = 步频（每步一次颠簸，加二次谐波模拟双峰落脚），
 * 前后/侧向为小幅摆动。幅值量级参考真实步行 ~2 m/s² 峰值（0.75m 步幅基准），
 * ampScale 随步幅等比缩放颠簸强度。
 */
export function stepWave(tSec: number, cadenceSpm: number, ampScale = 1): Vec3 {
  const w = 2 * Math.PI * (cadenceSpm / 60) * tSec;
  const y =
    9.81 +
    ampScale *
      (2.1 * Math.sin(w) + 0.8 * Math.sin(2 * w + 1.1) + 0.25 * Math.sin(3 * w + 2.3) + 0.06 * Math.sin(2.1 * tSec));
  const z =
    ampScale * (1.3 * Math.cos(w + 0.6) + 0.2 * Math.sin(2 * w + 0.4)) + 0.05 * Math.sin(1.7 * tSec + 1);
  const x = ampScale * 0.7 * Math.sin(w + 1.9) + 0.05 * Math.sin(0.9 * tSec);
  return { x, y, z };
}

/** 静止时的微颤基线 */
export function idleWave(tSec: number): Vec3 {
  return {
    x: 0.02 * Math.sin(3 * tSec),
    y: 9.81 + 0.015 * Math.sin(2.4 * tSec),
    z: 0.02 * Math.cos(2.7 * tSec),
  };
}

// ---------- 路线推进 ----------

interface Segment {
  from: LatLng;
  to: LatLng;
  len: number;
  heading: number;
}

/** 沿途经点序列推进；loop=true 时把路线视为闭合环（末点连回首点） */
export class RouteWalker {
  private segs: Segment[] = [];
  private seg = 0;
  private consumed = 0;
  private loop: boolean;

  constructor(route: LatLng[], loop: boolean) {
    this.loop = loop;
    const n = route.length;
    const last = loop ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const from = route[i]!;
      const to = route[(i + 1) % n]!;
      this.segs.push({
        from,
        to,
        len: haversineM(from, to),
        heading: bearingOf(from, to),
      });
    }
  }

  get position(): LatLng {
    const s = this.segs[this.seg];
    if (!s || s.len === 0) return s?.from ?? { lat: 0, lon: 0 };
    return destination(s.from, s.heading, this.consumed);
  }

  get headingDeg(): number {
    return this.segs[this.seg]?.heading ?? 0;
  }

  get finished(): boolean {
    return (
      !this.loop &&
      this.seg === this.segs.length - 1 &&
      this.consumed >= (this.segs[this.seg]?.len ?? 0)
    );
  }

  /** 前进 distM 米；跳过零长段；返回是否到达终点（仅非循环路线） */
  advance(distM: number): boolean {
    const total = this.segs.reduce((sum, s) => sum + s.len, 0);
    if (total < 1e-6) return true;
    if (this.loop) distM %= total;
    let remaining = distM;
    for (let guard = 0; remaining > 1e-9 && guard < 10000; guard++) {
      const s = this.segs[this.seg];
      if (!s) return true;
      if (s.len === 0) {
        if (!this.loop && this.seg === this.segs.length - 1) return true;
        this.seg = (this.seg + 1) % this.segs.length;
        this.consumed = 0;
        continue;
      }
      const left = s.len - this.consumed;
      if (remaining < left) {
        this.consumed += remaining;
        return false;
      }
      remaining -= left;
      if (this.seg === this.segs.length - 1) {
        if (this.loop) {
          this.seg = 0;
          this.consumed = 0;
        } else {
          this.consumed = s.len;
          return true;
        }
      } else {
        this.seg++;
        this.consumed = 0;
      }
    }
    return false;
  }
}

// ---------- 配置清洗与路线解析 ----------

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));
const num = (v: unknown, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : dflt;

export function sanitizeLocationConfig(
  raw: unknown,
): { ok: true; config: LocationConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object')
    return { ok: false, error: '配置不能为空' };
  const r = raw as Record<string, unknown>;
  const mode = r.mode === 'manual' ? 'manual' : 'route';
  const rawAnchor = r.anchor as Record<string, unknown> | undefined;
  const anchorLat = num(rawAnchor?.lat, NaN);
  const anchorLon = num(rawAnchor?.lon, NaN);
  if (!Number.isFinite(anchorLat) || !Number.isFinite(anchorLon) || Math.abs(anchorLat) > 85 || Math.abs(anchorLon) > 180)
    return { ok: false, error: '缺少锚点（在地图上双击确认起始位置）' };
  const anchor = { lat: anchorLat, lon: anchorLon };
  const rawRoute = Array.isArray(r.route) ? r.route : [];
  const route: LatLng[] = [];
  for (const p of rawRoute.slice(0, 2000)) {
    if (!p || typeof p !== 'object') continue;
    const lat = num((p as Record<string, unknown>).lat, NaN);
    const lon = num((p as Record<string, unknown>).lon, NaN);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 85 || Math.abs(lon) > 180) continue;
    route.push({ lat, lon });
  }
  if (mode === 'route' && route.length < 2)
    return { ok: false, error: '路线至少需要两个途经点' };
  if (mode === 'route' && !route.some((p) => haversineM(route[0]!, p) > 0.01))
    return { ok: false, error: '路线需要包含不同的位置' };
  const speedMps = clamp(num(r.speedMps, 1.4), 0.3, 12);
  const cadenceSpm = clamp(num(r.cadenceSpm, 112), Math.max(40, speedMps * 20), Math.min(240, speedMps * 300));
  return {
    ok: true,
    config: {
      mode,
      anchor,
      route: mode === 'route' ? route : undefined,
      loop: r.loop === true,
      speedMps,
      cadenceSpm,
      strideM: speedMps * 60 / cadenceSpm,
      speedJitterPct: clamp(num(r.speedJitterPct, 8), 0, 50),
      strideJitterPct: clamp(num(r.strideJitterPct, 8), 0, 50),
      cadenceJitterPct: clamp(num(r.cadenceJitterPct, 8), 0, 50),
      gpsNoiseM: clamp(num(r.gpsNoiseM, 5), 0, 50),
      altitudeM: clamp(num(r.altitudeM, 12), -500, 9000),
      headingDeg: ((num(r.headingDeg, 0) % 360) + 360) % 360,
      accelerationMps2: clamp(num(r.accelerationMps2, 1.2), 0.1, 5),
    },
  };
}

/** 路线文本解析：每行"纬度,经度"（逗号/空格/制表符分隔），或直接粘贴 GPX（提取 trkpt） */
export function parseRouteText(text: string): LatLng[] {
  const out: LatLng[] = [];
  const gpx = text.matchAll(/<(?:trkpt|rtept)\b([^>]*)>/gi);
  let matched = false;
  for (const m of gpx) {
    matched = true;
    const lat = m[1]!.match(/\blat\s*=\s*["']([^"']+)["']/i);
    const lon = m[1]!.match(/\blon\s*=\s*["']([^"']+)["']/i);
    if (lat && lon) out.push({ lat: Number(lat[1]), lon: Number(lon[1]) });
  }
  if (!matched) {
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(
        /^\s*(-?\d+(?:\.\d+)?)\s*[,，;\s]\s*(-?\d+(?:\.\d+)?)\s*$/,
      );
      if (!m) continue;
      out.push({ lat: parseFloat(m[1]!), lon: parseFloat(m[2]!) });
    }
  }
  return out
    .filter((p) => Math.abs(p.lat) <= 85 && Math.abs(p.lon) <= 180)
    .slice(0, 2000);
}

// ---------- 引擎（每台设备一个会话） ----------

export interface LocationDeps {
  adbPath: string;
  connect?: typeof connectConsole;
  sendAdb?: (args: string[]) => Promise<void>;
  /** 设备 shell 命令（测试注入用），缺省走 adb -s <serial> shell */
  shell?: (args: string[]) => Promise<void>;
  now?: () => number;
  gps?: () => Promise<GpsController | null>;
}

export interface LocationStatus {
  running: boolean;
  paused: boolean;
  mode: 'route' | 'manual';
  lat: number;
  lon: number;
  headingDeg: number;
  speedMps: number;
  cadenceSpm: number;
  strideM: number;
  altitudeM: number;
  accelerationMps2: number;
  lateralAccelerationMps2: number;
  distanceM: number;
  elapsedSec: number;
  steps: number;
  finished: boolean;
  viaConsole: boolean;
  sensors: string[];
  sensorError?: string;
  lastError?: string;
  config: LocationConfig;
}

export class LocationMotion {
  readonly config: LocationConfig;
  pos: LatLng;
  headingDeg: number;
  courseDeg: number;
  speedMps = 0;
  cadenceSpm = 0;
  strideM: number;
  accelerationMps2 = 0;
  lateralAccelerationMps2 = 0;
  turnRateRad = 0;
  steps = 0;
  distanceM = 0;
  elapsedSec = 0;
  finished = false;
  paused = false;
  readonly keys: Record<NudgeKey, boolean> = { up: false, down: false, left: false, right: false };
  private walker: RouteWalker | null;
  private timeSec = 0;
  private velocityMps = 0;
  private nSpeed: (t: number) => number;
  private nStride: (t: number) => number;
  private nCadence: (t: number) => number;

  constructor(config: LocationConfig) {
    this.config = config;
    this.walker = config.mode === 'route' ? new RouteWalker(config.route!, config.loop) : null;
    this.pos = { ...(this.walker ? config.route![0]! : config.anchor) };
    this.headingDeg = this.walker?.headingDeg ?? config.headingDeg ?? 0;
    this.courseDeg = this.headingDeg;
    this.strideM = config.strideM;
    this.nSpeed = makeNoise(config.speedJitterPct / 100);
    this.nStride = makeNoise(config.strideJitterPct / 100);
    this.nCadence = makeNoise(config.cadenceJitterPct / 100);
  }

  releaseKeys(): void {
    for (const key of Object.keys(this.keys) as NudgeKey[]) this.keys[key] = false;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.releaseKeys();
    this.velocityMps = this.speedMps = this.cadenceSpm = this.accelerationMps2 = this.turnRateRad = 0;
    this.lateralAccelerationMps2 = 0;
  }

  advance(dt: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    // 小步积分避免后台调度延迟造成瞬移；暂停不补走丢失的时间。
    for (let remaining = Math.min(dt, 0.5); remaining > 1e-8;) {
      const h = Math.min(remaining, 0.025);
      remaining -= h;
      this.tick(h);
    }
  }

  private tick(dt: number): void {
    this.timeSec += dt;
    if (this.paused || this.finished) {
      this.velocityMps = 0;
      this.speedMps = this.cadenceSpm = this.accelerationMps2 = this.turnRateRad = 0;
      this.lateralAccelerationMps2 = 0;
      return;
    }
    this.elapsedSec += dt;
    const t = this.timeSec;
    const nominalStride = clamp(this.config.strideM * (1 + this.nStride(t)), 0.2, 3);
    const previousSpeed = this.velocityMps;
    const limit = (this.config.accelerationMps2 ?? 1.2) * dt;
    const previousHeading = this.headingDeg;
    let distance = 0;
    if (this.walker) {
      const target = clamp(nominalStride * this.config.cadenceSpm / 60 *
        (1 + this.nCadence(t)) * (1 + this.nSpeed(t)), 0, 12);
      this.velocityMps += clamp(target - previousSpeed, -limit, limit);
      this.speedMps = this.velocityMps;
      distance = (previousSpeed + this.velocityMps) / 2 * dt;
      const before = this.pos;
      this.finished = this.walker.advance(distance);
      this.pos = this.walker.position;
      if (this.finished) distance = Math.min(distance, haversineM(before, this.pos));
      const turn = ((this.walker.headingDeg - this.headingDeg + 540) % 360) - 180;
      this.headingDeg = (this.headingDeg + clamp(turn, -90 * dt, 90 * dt) + 360) % 360;
      this.courseDeg = this.headingDeg;
    } else {
      // 罗盘方向模型：键位直接指定地理方向（WASD=北南西东，双键取 45° 夹角），
      // 速度矢量按加速度上限在最短弧上转向目标，不会出现"前进+转向"的绕圈。
      const east = Number(this.keys.right) - Number(this.keys.left);
      const north = Number(this.keys.up) - Number(this.keys.down);
      const moving = east !== 0 || north !== 0;
      const target = moving
        ? clamp(nominalStride * this.config.cadenceSpm / 60 * (1 + this.nCadence(t)) * (1 + this.nSpeed(t)), 0, 12)
        : 0;
      const br = rad(moving ? (deg(Math.atan2(east, north)) + 360) % 360 : this.courseDeg);
      const course = rad(this.courseDeg);
      const vx = this.velocityMps * Math.sin(course);
      const vy = this.velocityMps * Math.cos(course);
      let dvx = target * Math.sin(br) - vx;
      let dvy = target * Math.cos(br) - vy;
      const dv = Math.hypot(dvx, dvy);
      if (dv > limit) { dvx *= limit / dv; dvy *= limit / dv; }
      const nvx = vx + dvx;
      const nvy = vy + dvy;
      this.velocityMps = Math.hypot(nvx, nvy);
      if (this.velocityMps > 1e-9) this.courseDeg = (deg(Math.atan2(nvx, nvy)) + 360) % 360;
      this.speedMps = this.velocityMps;
      distance = (previousSpeed + this.velocityMps) / 2 * dt;
      this.pos = destination(this.pos, this.courseDeg, distance);
      const turn = ((this.courseDeg - this.headingDeg + 540) % 360) - 180;
      this.headingDeg = (this.headingDeg + clamp(turn, -90 * dt, 90 * dt) + 360) % 360;
    }
    this.accelerationMps2 = (this.velocityMps - previousSpeed) / dt;
    this.strideM = Math.max(nominalStride, this.speedMps / 4);
    this.cadenceSpm = this.speedMps / this.strideM * 60;
    this.turnRateRad = rad(((this.headingDeg - previousHeading + 540) % 360) - 180) / dt;
    this.lateralAccelerationMps2 = this.velocityMps * this.turnRateRad;
    this.distanceM += distance;
    // 位移、步数和波形相位使用同一积分，变速和换向不会产生相位跳跃。
    this.steps += distance / this.strideM;
    if (this.finished) this.speedMps = this.cadenceSpm = this.accelerationMps2 = 0;
  }
}

interface Session {
  deps: LocationDeps;
  serial: string;
  config: LocationConfig;
  motion: LocationMotion;
  console: EmuConsole | null;
  gps: GpsController | null;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
  lastAt: number;
  lastGeoAt: number;
  viaConsole: boolean;
  sensors: string[];
  originalSensors: Map<string, string>;
  inFlight: Promise<void>;
  sensorError?: string;
  lastError?: string;
  nLat: (t: number) => number;
  nLon: (t: number) => number;
}

const sessions = new Map<string, Session>();
const SENSOR_MS = 20;
const nowOf = (s: Session): number => s.deps.now?.() ?? performance.now();
const fmt = (v: number): string => v.toFixed(6);

export function rmcSentence(position: LatLng, speedMps: number, headingDeg: number, now = new Date()): string {
  const coord = (value: number, digits: number): string => {
    const abs = Math.abs(value);
    return Math.floor(abs).toString().padStart(digits, '0') + ((abs % 1) * 60).toFixed(7).padStart(10, '0');
  };
  const iso = now.toISOString();
  const time = iso.slice(11, 19).replaceAll(':', '');
  const date = iso.slice(8, 10) + iso.slice(5, 7) + iso.slice(2, 4);
  // Goldfish 的解析器要求整数秒与完整磁偏角字段。
  const body = `GPRMC,${time},A,${coord(position.lat, 2)},${position.lat < 0 ? 'S' : 'N'},${coord(position.lon, 3)},${position.lon < 0 ? 'W' : 'E'},${fmt(speedMps / 0.514444)},${fmt(headingDeg)},${date},0.0,E`;
  const checksum = [...body].reduce((sum, char) => sum ^ char.charCodeAt(0), 0).toString(16).toUpperCase().padStart(2, '0');
  return `$${body}*${checksum}`;
}

export function ggaSentence(position: LatLng, altitudeM: number, now = new Date()): string {
  const rmc = rmcSentence(position, 0, 0, now).split(',');
  const body = `GPGGA,${rmc[1]},${rmc[3]},${rmc[4]},${rmc[5]},${rmc[6]},1,10,1.0,${fmt(altitudeM)},M,0.0,M,,`;
  const checksum = [...body].reduce((sum, char) => sum ^ char.charCodeAt(0), 0).toString(16).toUpperCase().padStart(2, '0');
  return `$${body}*${checksum}`;
}

function advanceSession(s: Session): void {
  const now = nowOf(s);
  s.motion.advance((now - s.lastAt) / 1000);
  s.lastAt = now;
}

async function sendGeo(s: Session): Promise<void> {
  const m = s.motion;
  const t = m.elapsedSec;
  const p = destination(destination(m.pos, 0, s.nLat(t)), 90, s.nLon(t));
  if (s.gps) {
    await s.gps.set({ ...p, speedMps: m.speedMps, headingDeg: m.courseDeg, altitudeM: s.config.altitudeM ?? 12, passiveUpdate: s.stopped });
    s.viaConsole = !!s.console;
    s.lastError = undefined;
    return;
  }
  const now = new Date();
  const frames = [ggaSentence(p, s.config.altitudeM ?? 12, now), rmcSentence(p, m.speedMps, m.courseDeg, now)];
  const legacy = ['geo', 'fix', fmt(p.lon), fmt(p.lat), fmt(s.config.altitudeM ?? 12), '10', fmt(m.speedMps / .514444)];
  if (s.console) {
    try {
      // GGA 更新海拔，RMC 一次提交位置、速度与航向，避免 geo fix 额外发出零航向。
      await s.console.send(legacy.join(' '));
      for (const frame of frames) await s.console.send(`geo nmea ${frame}`);
      s.viaConsole = true;
      s.lastError = undefined;
      return;
    } catch (err) {
      s.lastError = err instanceof Error ? err.message : String(err);
      s.sensorError = s.lastError;
      s.console.close();
      s.console = null;
      s.sensors = [];
    }
  }
  s.viaConsole = false;
  for (const args of [legacy, ...frames.map(frame => ['geo', 'nmea', frame])]) {
    if (s.deps.sendAdb) await s.deps.sendAdb(args);
    else {
      const r = await run(s.deps.adbPath, ['-s', s.serial, 'emu', ...args], { timeoutMs: 3000 });
      if (r.code !== 0 || /KO:/i.test(r.stdout)) throw new Error(r.stderr.trim() || r.stdout.trim() || 'GNSS 注入失败');
    }
  }
  s.lastError = undefined;
}

async function sendSensors(s: Session): Promise<void> {
  if (!s.console || s.sensors.length === 0) return;
  const m = s.motion;
  const t = m.elapsedSec;
  const w = m.speedMps > 0 ? stepWave(m.steps, 60, m.strideM / 0.75 * Math.min(1, m.speedMps / 0.5)) : idleWave(t);
  w.z += m.accelerationMps2;
  w.x += m.lateralAccelerationMps2;
  const h = rad(m.headingDeg);
  const values: Record<string, string> = {
    acceleration: `${fmt(w.x)}:${fmt(w.y)}:${fmt(w.z)}`,
    gyroscope: `0:${fmt(-m.turnRateRad)}:0`,
    orientation: `${fmt(m.headingDeg)}:-90:0`,
    'magnetic-field': `${fmt(-20 * Math.sin(h))}:-40:${fmt(-20 * Math.cos(h))}`,
    pressure: fmt(1013.25 * (1 - (s.config.altitudeM ?? 12) / 44330) ** 5.255),
  };
  for (const sensor of s.sensors) {
    if (s.stopped) break;
    try {
      await s.console.send(`sensor set ${sensor} ${values[sensor]}`);
    } catch (err) {
      // 单一传感器拒绝不能终止 GPS，也不能取消其他可用传感器。
      s.sensors = s.sensors.filter((name) => name !== sensor);
      s.sensorError = `${sensor}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

async function tickSession(s: Session): Promise<void> {
  if (s.stopped) return;
  advanceSession(s);
  try {
    const now = nowOf(s);
    if (now - s.lastGeoAt >= 1000) {
      s.lastGeoAt = now;
      await sendGeo(s);
    }
    await sendSensors(s);
  } catch (err) {
    s.lastError = err instanceof Error ? err.message : String(err);
  }
  if (!s.stopped) s.timer = setTimeout(() => {
    s.inFlight = tickSession(s);
  }, Math.max(1, SENSOR_MS - (nowOf(s) - s.lastAt)));
}

async function startLocationSession(
  deps: LocationDeps,
  serial: string,
  config: LocationConfig,
): Promise<{ ok: boolean; error?: string }> {
  if (!/^emulator-\d{1,5}$/.test(serial)) return { ok: false, error: '仅支持 Android 模拟器' };
  const clean = sanitizeLocationConfig(config);
  if (!clean.ok) return clean;
  await stopLocationSession(serial);
  config = clean.config;
  // 设备定位总开关被关时 App 侧只会看到"GPS 信号弱"；注入前切到高精度模式。
  // 不用 svc location：部分镜像无此子命令（只打印帮助且退出码为 0，无法察觉失败）。
  const runShell = deps.shell ?? ((args: string[]) => run(deps.adbPath, ['-s', serial, 'shell', ...args], { timeoutMs: 4000 }));
  try { await runShell(['settings', 'put', 'secure', 'location_mode', '3']); } catch { /* 继续注入 */ }
  const s: Session = {
    deps, serial, config, motion: new LocationMotion(config), console: null, gps: null, timer: null,
    stopped: false, lastAt: 0, lastGeoAt: 0, viaConsole: false, sensors: [],
    originalSensors: new Map(), inFlight: Promise.resolve(),
    nLat: makeNoise(config.gpsNoiseM / Math.SQRT2), nLon: makeNoise(config.gpsNoiseM / Math.SQRT2),
  };
  sessions.set(serial, s);
  try {
    // gRPC 端点来自运行目录的 pid ini，可能过期或未监听；失败回退控制台/adb 通道，不作为启动失败。
    try { s.gps = await (deps.gps ?? (() => connectGps(serial)))(); }
    catch (err) { s.sensorError = `gps: ${err instanceof Error ? err.message : String(err)}`; }
    try {
      s.console = await (deps.connect ?? connectConsole)(serial, 1500);
      if (s.stopped) { s.console.close(); return { ok: false, error: '启动已取消' }; }
      const status = await s.console.send('sensor status');
      for (const sensor of ['acceleration', 'gyroscope', 'orientation', 'magnetic-field', 'pressure']) {
        if (!status.split(/\r?\n/).some((line) => line.trim() === `${sensor}: enabled.`)) continue;
        try {
          const value = await s.console.send(`sensor get ${sensor}`);
          const match = value.match(/=\s*([-+\deE.:]+)/);
          if (!match) continue;
          s.originalSensors.set(sensor, match[1]!);
          s.sensors.push(sensor);
        } catch { /* 不覆盖无法读取原值的传感器。 */ }
      }
    } catch (err) {
      s.sensorError = err instanceof Error ? err.message : String(err);
      s.console?.close();
      s.console = null;
      s.sensors = [];
    }
    if (s.stopped) return { ok: false, error: '启动已取消' };
    // 首针保持锚点和零速度；初始化/握手耗时不计入运动时间。
    await sendGeo(s);
    if (s.stopped) return { ok: false, error: '启动已取消' };
    s.lastAt = s.lastGeoAt = nowOf(s);
    s.timer = setTimeout(() => { s.inFlight = tickSession(s); }, SENSOR_MS);
    return { ok: true };
  } catch (err) {
    await stopLocationSession(serial);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function stopLocationSession(serial: string): Promise<void> {
  const s = sessions.get(serial);
  if (!s) return;
  sessions.delete(serial);
  s.stopped = true;
  if (s.timer) clearTimeout(s.timer);
  await s.inFlight;
  s.motion.speedMps = 0;
  s.motion.releaseKeys();
  try { await sendGeo(s); } catch { /* 设备退出时允许清理继续。 */ }
  if (s.console) {
    for (const [sensor, value] of s.originalSensors) {
      try { await s.console.send(`sensor set ${sensor} ${value}`); } catch { break; }
    }
    s.console.close();
  }
  s.gps?.close();
}

const operations = new Map<string, Promise<unknown>>();

function enqueue<T>(serial: string, operation: () => Promise<T>): Promise<T> {
  const result = (operations.get(serial) ?? Promise.resolve()).then(operation, operation);
  operations.set(serial, result);
  void result.finally(() => { if (operations.get(serial) === result) operations.delete(serial); }).catch(() => undefined);
  return result;
}

export function startLocation(deps: LocationDeps, serial: string, config: LocationConfig): Promise<{ok: boolean; error?: string}> {
  return enqueue(serial, () => startLocationSession(deps, serial, config));
}

export function stopLocation(serial: string): Promise<void> {
  return enqueue(serial, () => stopLocationSession(serial));
}

export function pauseLocation(serial: string, paused: boolean): void {
  const s = sessions.get(serial);
  if (!s) return;
  advanceSession(s);
  s.motion.setPaused(paused);
  s.lastGeoAt = -Infinity;
}

export function nudgeLocation(serial: string, key: NudgeKey, pressed: boolean): void {
  const s = sessions.get(serial);
  if (s?.config.mode === 'manual' && key in s.motion.keys) {
    advanceSession(s);
    s.motion.keys[key] = pressed;
  }
}

export function releaseLocationKeys(serial: string): void {
  const s = sessions.get(serial);
  if (s) { advanceSession(s); s.motion.releaseKeys(); }
}

/** 手动会话内立即切换位置：保留会话与累计数据，下一帧立即下发新坐标。 */
export function teleportLocation(serial: string, lat: number, lon: number): boolean {
  const s = sessions.get(serial);
  if (!s || s.stopped || s.config.mode !== 'manual') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) return false;
  advanceSession(s);
  s.motion.pos = { lat, lon };
  s.lastGeoAt = -Infinity;
  return true;
}

export function locationStatus(serial: string): LocationStatus | null {
  const s = sessions.get(serial);
  if (!s || s.stopped) return null;
  const m = s.motion;
  return {
    running: true, paused: m.paused, mode: s.config.mode, lat: m.pos.lat, lon: m.pos.lon,
    headingDeg: m.headingDeg, speedMps: m.speedMps, cadenceSpm: m.cadenceSpm,
    strideM: m.strideM, altitudeM: s.config.altitudeM ?? 12, accelerationMps2: m.accelerationMps2,
    lateralAccelerationMps2: m.lateralAccelerationMps2,
    distanceM: m.distanceM, elapsedSec: m.elapsedSec, steps: Math.floor(m.steps),
    finished: m.finished, viaConsole: s.viaConsole, sensors: [...s.sensors],
    sensorError: s.sensorError, lastError: s.lastError, config: s.config,
  };
}

export async function stopAllLocations(): Promise<void> {
  await Promise.all([...new Set([...sessions.keys(), ...operations.keys()])].map(stopLocation));
}
