/**
 * 零依赖瓦片地图（Web Mercator）：面板小图与路线编辑器大图共用。
 * 拖动平移、滚轮以光标为锚缩放、双击回调、锚点标记、折线覆盖层。
 * 瓦片源 OSM（WGS-84，与 GPS 坐标一致）为主，加载失败回退 ArcGIS 在线底图；
 * 不引入任何 npm/CDN 依赖，贴合本仓库零依赖约定。
 */

import { fromGoogleMap, toGoogleMap } from '../core/mapCoordinates.ts';

export interface MapPoint {
  lat: number;
  lon: number;
}

const TILE = 256;
const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const FALLBACK_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';

const lonToWorldX = (lon: number, world: number): number =>
  ((lon + 180) / 360) * world;
const worldXToLon = (x: number, world: number): number =>
  (x / world) * 360 - 180;
const latToWorldY = (lat: number, world: number): number => {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
};
const worldYToLat = (y: number, world: number): number => {
  const n = Math.PI - (2 * (Math.PI * y)) / world;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

export interface MiniMap {
  getCenter(): MapPoint;
  getZoom(): number;
  setCenter(p: MapPoint, zoom?: number): void;
  latLngToPixel(p: MapPoint): { x: number; y: number };
  pixelToLatLng(x: number, y: number): MapPoint;
  onDoubleClick(cb: (p: MapPoint) => void): void;
  setMarker(p: MapPoint | null): void;
  setLiveMarker(p: MapPoint | null): void;
  setPath(pts: MapPoint[] | null): void;
  /** 笔绘制模式下禁用拖动，抬起恢复 */
  setDragEnabled(b: boolean): void;
  zoomBy(delta: number): void;
  setGoogleCompatibility(enabled: boolean): void;
  destroy(): void;
}

export function createMap(
  host: HTMLElement,
  opts?: {
    center?: MapPoint;
    zoom?: number;
    minZoom?: number;
    maxZoom?: number;
  },
): MiniMap {
  const minZoom = opts?.minZoom ?? 3;
  const maxZoom = opts?.maxZoom ?? 18;
  let center: MapPoint = opts?.center ?? { lat: 39.9042, lon: 116.4074 };
  let zoom = Math.min(maxZoom, Math.max(minZoom, opts?.zoom ?? 14));
  let dragEnabled = true;
  let googleCompatible = false;
  const project = (p: MapPoint, ws: number): {x:number;y:number} => {
    const tilePoint = googleCompatible ? fromGoogleMap(p) : p;
    return {x:lonToWorldX(tilePoint.lon,ws),y:latToWorldY(tilePoint.lat,ws)};
  };
  const unproject = (x: number, y: number, ws: number): MapPoint => {
    const p={lat:worldYToLat(y,ws),lon:worldXToLon(x,ws)};
    return googleCompatible ? toGoogleMap(p) : p;
  };

  const wrap = document.createElement('div');
  wrap.style.cssText =
    'position:relative;overflow:hidden;width:100%;height:100%;background:#0d0f14;cursor:grab;user-select:none;touch-action:none;';
  const tileLayer = document.createElement('div');
  tileLayer.style.cssText = 'position:absolute;inset:0;';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
  const polyline = document.createElementNS(
    'http://www.w3.org/2000/svg',
    'polyline',
  );
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', '#8ab4ff');
  polyline.setAttribute('stroke-width', '3');
  polyline.setAttribute('stroke-linejoin', 'round');
  polyline.setAttribute('stroke-linecap', 'round');
  svg.appendChild(polyline);
  const marker = document.createElement('div');
  marker.style.cssText =
    'position:absolute;width:14px;height:14px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);' +
    'background:#8ab4ff;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.5);display:none;' +
    'pointer-events:none;margin-left:-8px;margin-top:-14px;';
  // 实时位置点：脉冲蓝点（与静态锚点区分），运行时随 poll 更新
  const live = document.createElement('div');
  live.style.cssText =
    'position:absolute;width:16px;height:16px;border-radius:50%;display:none;pointer-events:none;' +
    'margin-left:-8px;margin-top:-8px;background:rgba(138,180,255,0.9);border:3px solid #fff;' +
    'box-shadow:0 0 0 2px rgba(138,180,255,0.45), 0 1px 6px rgba(0,0,0,0.5);';
  live.animate(
    [
      {
        boxShadow:
          '0 0 0 2px rgba(138,180,255,0.55), 0 1px 6px rgba(0,0,0,0.5)',
      },
      { boxShadow: '0 0 0 9px rgba(138,180,255,0), 0 1px 6px rgba(0,0,0,0.5)' },
    ],
    { duration: 1400, iterations: Infinity },
  );
  wrap.append(tileLayer, svg, marker, live);
  host.appendChild(wrap);

  const tiles = new Map<string, HTMLImageElement>();

  const size = (): { w: number; h: number } => ({
    w: wrap.clientWidth || 100,
    h: wrap.clientHeight || 100,
  });
  const world = (): number => TILE * 2 ** zoom;

  const render = (): void => {
    const { w, h } = size();
    const ws = world();
    const {x:cx,y:cy} = project(center,ws);
    const n = 2 ** zoom;
    const x0 = Math.floor((cx - w / 2) / TILE);
    const x1 = Math.floor((cx + w / 2) / TILE);
    const y0 = Math.floor((cy - h / 2) / TILE);
    const y1 = Math.floor((cy + h / 2) / TILE);
    const keep = new Set<string>();
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) {
        if (ty < 0 || ty >= n) continue;
        const txx = ((tx % n) + n) % n;
        const key = `${zoom}/${txx}/${ty}`;
        keep.add(key);
        let img = tiles.get(key);
        if (!img) {
          img = new Image(TILE, TILE);
          img.dataset.fbk = '';
          img.src = OSM_URL.replace('{z}', String(zoom))
            .replace('{x}', String(txx))
            .replace('{y}', String(ty));
          img.onerror = () => {
            if (img && !img.dataset.fbk) {
              img.dataset.fbk = '1';
              img.src = FALLBACK_URL.replace('{z}', String(zoom))
                .replace('{x}', String(txx))
                .replace('{y}', String(ty));
            }
          };
          img.style.cssText = 'position:absolute;pointer-events:none;';
          tiles.set(key, img);
          tileLayer.appendChild(img);
        }
        img.style.left = `${tx * TILE - cx + w / 2}px`;
        img.style.top = `${ty * TILE - cy + h / 2}px`;
      }
    }
    for (const [key, img] of tiles) {
      if (!keep.has(key)) {
        img.remove();
        tiles.delete(key);
      }
    }
    // 锚点标记
    marker.style.display = marker.dataset.lat ? 'block' : 'none';
    if (marker.dataset.lat) {
      const projected=project({lat:Number(marker.dataset.lat),lon:Number(marker.dataset.lon)},ws);
      const p={x:projected.x-cx+w/2,y:projected.y-cy+h/2};
      marker.style.left = `${p.x}px`;
      marker.style.top = `${p.y}px`;
    }
    // 实时位置点
    live.style.display = live.dataset.lat ? 'block' : 'none';
    if (live.dataset.lat) {
      const projected=project({lat:Number(live.dataset.lat),lon:Number(live.dataset.lon)},ws);
      const p={x:projected.x-cx+w/2,y:projected.y-cy+h/2};
      live.style.left = `${p.x}px`;
      live.style.top = `${p.y}px`;
    }
    // 折线
    if (path && path.length >= 2) {
      polyline.setAttribute(
        'points',
        path
          .map((pt) => {
            const projected=project(pt,ws);
            const px = projected.x - cx + w / 2;
            const py = projected.y - cy + h / 2;
            return `${px.toFixed(1)},${py.toFixed(1)}`;
          })
          .join(' '),
      );
      polyline.style.display = '';
    } else {
      polyline.style.display = 'none';
    }
  };

  let path: MapPoint[] | null = null;

  // 拖动平移
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  wrap.addEventListener('pointerdown', (e) => {
    if (!dragEnabled || e.button !== 0) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    wrap.style.cursor = 'grabbing';
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const ws = world();
    const projected=project(center,ws);
    const cx = projected.x - (e.clientX - lastX);
    const cy = projected.y - (e.clientY - lastY);
    lastX = e.clientX;
    lastY = e.clientY;
    center = unproject(cx,cy,ws);
    render();
  });
  const endDrag = (): void => {
    dragging = false;
    wrap.style.cursor = dragEnabled ? 'grab' : 'crosshair';
  };
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);

  // 滚轮缩放（以光标为锚）
  wrap.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const ax = e.clientX - rect.left;
      const ay = e.clientY - rect.top;
      const anchor = pixelToLatLng(ax, ay);
      zoom = Math.min(
        maxZoom,
        Math.max(minZoom, zoom + (e.deltaY < 0 ? 1 : -1)),
      );
      const { w, h } = size();
      const ws = world();
      // 平移中心，使锚点回到原屏幕位置
      const projected=project(anchor,ws);
      center = unproject(projected.x-(ax-w/2),projected.y-(ay-h/2),ws);
      render();
    },
    { passive: false },
  );

  const dblCbs: ((p: MapPoint) => void)[] = [];
  wrap.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const p = pixelToLatLng(e.clientX - rect.left, e.clientY - rect.top);
    for (const cb of dblCbs) cb(p);
  });

  function pixelToLatLng(x: number, y: number): MapPoint {
    const { w, h } = size();
    const ws = world();
    const {x:cx,y:cy} = project(center,ws);
    return unproject(cx+(x-w/2),cy+(y-h/2),ws);
  }

  render();
  // 容器尺寸在挂载后才会就绪（窗口显示/布局完成），必须观察尺寸变化重排瓦片，
  // 否则首帧用兜底尺寸(100x100)算可见瓦片范围，大地图只画出一小块
  const ro = new ResizeObserver(() => render());
  ro.observe(wrap);
  const onResize = (): void => render();
  window.addEventListener('resize', onResize);

  return {
    getCenter: () => ({ ...center }),
    getZoom: () => zoom,
    setCenter(p, z) {
      center = { ...p };
      if (z !== undefined) zoom = Math.min(maxZoom, Math.max(minZoom, z));
      render();
    },
    latLngToPixel(p) {
      const { w, h } = size();
      const ws = world();
      const point=project(p,ws), origin=project(center,ws);
      return {x:point.x-origin.x+w/2,y:point.y-origin.y+h/2};
    },
    pixelToLatLng,
    onDoubleClick(cb) {
      dblCbs.push(cb);
    },
    setMarker(p) {
      if (p) {
        marker.dataset.lat = String(p.lat);
        marker.dataset.lon = String(p.lon);
      } else {
        delete marker.dataset.lat;
        delete marker.dataset.lon;
      }
      render();
    },
    setLiveMarker(p) {
      if (p) {
        live.dataset.lat = String(p.lat);
        live.dataset.lon = String(p.lon);
      } else {
        delete live.dataset.lat;
        delete live.dataset.lon;
      }
      render();
    },
    setPath(pts) {
      path = pts;
      render();
    },
    setDragEnabled(b) {
      dragEnabled = b;
      wrap.style.cursor = b ? 'grab' : 'crosshair';
    },
    zoomBy(delta) {
      zoom = Math.min(maxZoom, Math.max(minZoom, zoom + delta));
      render();
    },
    setGoogleCompatibility(enabled) { googleCompatible=enabled; render(); },
    destroy() {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
      tiles.clear();
      wrap.remove();
    },
  };
}
