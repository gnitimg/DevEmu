import fs from 'node:fs';
import path from 'node:path';
import type { LatLng } from './location.ts';

/**
 * 虚拟定位的本地数据：<dataRoot>/location/ 下的路线库（routes/*.json）
 * 与面板参数偏好（prefs.json）。路线为 WGS-84 经纬度序列。
 */

export interface StoredRoute {
  id: string;
  name: string;
  points: LatLng[];
  createdAt: number;
}

export interface LocationPrefs {
  mode: 'route' | 'manual';
  loop: boolean;
  speedMps: number;
  cadenceSpm: number;
  strideM: number;
  speedJitterPct: number;
  strideJitterPct: number;
  cadenceJitterPct: number;
  gpsNoiseM: number;
  lastRouteId?: string;
  altitudeM?: number;
  headingDeg?: number;
  accelerationMps2?: number;
  anchor?: LatLng;
  mapCompatibility?: boolean;
}

function locationDir(dataRoot: string): string {
  return path.join(dataRoot, 'location');
}

function routesDir(dataRoot: string): string {
  return path.join(locationDir(dataRoot), 'routes');
}

function prefsFile(dataRoot: string): string {
  return path.join(locationDir(dataRoot), 'prefs.json');
}

/** 清洗点序列：合法经纬度、最多 2000 点 */
function sanitizePoints(raw: unknown): LatLng[] {
  const out: LatLng[] = [];
  if (!Array.isArray(raw)) return out;
  for (const p of raw.slice(0, 2000)) {
    if (!p || typeof p !== 'object') continue;
    const lat = (p as Record<string, unknown>).lat;
    const lon = (p as Record<string, unknown>).lon;
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 85 || Math.abs(lon) > 180) continue;
    out.push({ lat, lon });
  }
  return out;
}

export function saveRoute(
  dataRoot: string,
  name: string,
  points: LatLng[],
): { ok: true; id: string } | { ok: false; error: string } {
  const clean = sanitizePoints(points);
  if (clean.length < 2) return { ok: false, error: '路线至少需要两个点' };
  const trimmed =
    String(name ?? '')
      .trim()
      .slice(0, 60) || `路线-${Date.now()}`;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = routesDir(dataRoot);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const route: StoredRoute = {
      id,
      name: trimmed,
      points: clean,
      createdAt: Date.now(),
    };
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify(route),
      'utf8',
    );
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function listRoutes(dataRoot: string): StoredRoute[] {
  let files: string[];
  try {
    files = fs
      .readdirSync(routesDir(dataRoot))
      .filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: StoredRoute[] = [];
  for (const f of files) {
    try {
      const route = JSON.parse(
        fs.readFileSync(path.join(routesDir(dataRoot), f), 'utf8'),
      ) as StoredRoute;
      if (
        route &&
        typeof route.id === 'string' &&
        Array.isArray(route.points) &&
        route.points.length >= 2
      )
        out.push(route);
    } catch {
      // 单个路线文件损坏不阻塞列表
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function loadRoute(dataRoot: string, id: string): StoredRoute | null {
  if (!/^[\w-]{1,64}$/.test(id)) return null;
  try {
    const route = JSON.parse(
      fs.readFileSync(path.join(routesDir(dataRoot), `${id}.json`), 'utf8'),
    ) as StoredRoute;
    return route && Array.isArray(route.points) ? route : null;
  } catch {
    return null;
  }
}

export function deleteRoute(dataRoot: string, id: string): void {
  if (!/^[\w-]{1,64}$/.test(id)) return;
  fs.rmSync(path.join(routesDir(dataRoot), `${id}.json`), { force: true });
}

const NUM_FIELDS = [
  'speedMps',
  'cadenceSpm',
  'strideM',
  'speedJitterPct',
  'strideJitterPct',
  'cadenceJitterPct',
  'gpsNoiseM',
  'altitudeM',
  'headingDeg',
  'accelerationMps2',
] as const;

export function loadPrefs(dataRoot: string): Partial<LocationPrefs> {
  try {
    const raw = JSON.parse(
      fs.readFileSync(prefsFile(dataRoot), 'utf8'),
    ) as Record<string, unknown>;
    const out: Partial<LocationPrefs> = {};
    if (raw.mode === 'route' || raw.mode === 'manual') out.mode = raw.mode;
    if (raw.loop === true || raw.loop === false) out.loop = raw.loop;
    if (typeof raw.mapCompatibility === 'boolean') out.mapCompatibility = raw.mapCompatibility;
    for (const f of NUM_FIELDS) {
      const v = raw[f];
      if (typeof v === 'number' && Number.isFinite(v)) out[f] = v;
    }
    if (typeof raw.lastRouteId === 'string') out.lastRouteId = raw.lastRouteId;
    const anchor = sanitizePoints([raw.anchor])[0];
    if (anchor) out.anchor = anchor;
    return out;
  } catch {
    return {};
  }
}

export function savePrefs(dataRoot: string, prefs: LocationPrefs): void {
  try {
    fs.mkdirSync(locationDir(dataRoot), { recursive: true });
    fs.writeFileSync(
      prefsFile(dataRoot),
      JSON.stringify(prefs, null, 2),
      'utf8',
    );
  } catch {
    // 偏好保存失败不影响功能
  }
}
