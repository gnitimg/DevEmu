import { PRESETS, derivedStrideM } from '../core/walkProfiles.ts';
import type { LocationConfig, LocationStatus, NudgeKey } from '../core/location.ts';
import { createMap, type MapPoint } from './mapWidget.ts';
import { toGoogleMap } from '../core/mapCoordinates.ts';

interface Result<T = unknown> { ok: boolean; data?: T; error?: string }
interface RouteEntry { id: string; name: string; points: MapPoint[] }
interface Prefs extends Partial<LocationConfig> { lastRouteId?: string; mapCompatibility?: boolean }
interface LocBridge {
  locationStart(serial: string, config: LocationConfig): Promise<Result>;
  locationStop(serial: string): Promise<Result>;
  locationPause(serial: string, paused: boolean): Promise<Result>;
  locationStatus(serial: string): Promise<Result<LocationStatus | null>>;
  locationNudge(serial: string, key: NudgeKey, pressed: boolean): Promise<Result>;
  locationTeleport(serial: string, lat: number, lon: number): Promise<Result>;
  routeList(): Promise<Result<RouteEntry[]>>;
  routeSave(name: string, points: MapPoint[]): Promise<Result<string>>;
  routeParse(text: string): Promise<Result<MapPoint[]>>;
  locPrefsLoad(): Promise<Result<Prefs>>;
  locPrefsSave(prefs: Prefs): Promise<Result>;
}

const CSS = `
html, body { margin:0; height:100%; overflow:hidden; background:transparent; }
body.locpanel #root { display:none; }
body.locpanel { --accent:#8ab4ff; color:#e8eaed; font-family:'Segoe UI Variable','Segoe UI',system-ui,sans-serif; user-select:none; }
.locpanel * { box-sizing:border-box; }
.panel-col { position:absolute; inset:6px; display:flex; flex-direction:column; gap:14px; opacity:0; transition:opacity .18s ease-out; }
.panel-ready .panel-col { opacity:1; }
.loc-card { background:rgba(16,18,24,.94); border:1px solid rgba(255,255,255,.12); border-radius:20px; overflow:hidden; }
.map-card { flex:1; min-height:160px; position:relative; background:#0d0f14; border-color:rgba(255,255,255,.10); }
.map-host { position:absolute; inset:0; border-radius:20px; }
.map-searchbar { position:absolute; top:10px; left:50%; transform:translateX(-50%); width:calc(100% - 24px); max-width:340px; z-index:6; display:flex; align-items:center; gap:6px; padding:4px 4px 4px 14px; border:1px solid rgba(255,255,255,.14); border-radius:999px; background:rgba(13,15,20,.88); backdrop-filter:blur(8px); }
.locpanel input, .locpanel select, .locpanel button { font-size:12px; font-family:inherit; }
.locpanel button { cursor:pointer; color:inherit; border:0; }
.locpanel button:disabled, .locpanel input:disabled, .locpanel select:disabled { opacity:.45; cursor:default; }
.locpanel button:focus-visible { outline:2px solid #8ab4ff; outline-offset:-2px; }
.search-input { min-width:0; flex:1; background:none; color:#e8eaed; border:0; outline:0; }
.search-input::placeholder { color:rgba(255,255,255,.4); }
.map-searchbar button { padding:6px 14px; flex:none; border-radius:999px; background:rgba(138,180,255,.18); color:#8ab4ff; }
.map-coord { position:absolute; left:10px; bottom:10px; max-width:calc(100% - 20px); z-index:6; border-radius:999px; border:1px solid rgba(138,180,255,.35); padding:4px 10px; background:rgba(13,15,20,.85); font:11px Consolas,monospace; color:#8ab4ff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; pointer-events:none; }
.float-status { position:absolute; bottom:10px; left:50%; transform:translateX(-50%); z-index:6; background:rgba(13,15,20,.85); border:1px solid rgba(138,180,255,.35); border-radius:999px; padding:4px 12px; font:11px Consolas,monospace; color:#8ab4ff; pointer-events:none; max-width:calc(100% - 100px); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.map-tools { position:absolute; right:10px; bottom:10px; display:flex; flex-direction:column; gap:6px; z-index:6; }
.map-tools button { width:32px; height:32px; border-radius:999px; background:rgba(13,15,20,.85); border:1px solid rgba(255,255,255,.18); font-size:15px; }
.dpad { position:absolute; bottom:44px; left:50%; transform:translateX(-50%); z-index:6; display:grid; grid-template-columns:repeat(3,42px); grid-auto-rows:42px; gap:5px; }
.dpad button { border-radius:14px; background:rgba(13,15,20,.82); border:1px solid rgba(255,255,255,.18); touch-action:none; font-size:14px; }
.dpad button.hold { color:#8ab4ff; background:rgba(138,180,255,.3); }
.dpad [data-key=up] { grid-column:2; grid-row:1; }
.dpad [data-key=left] { grid-column:1; grid-row:2; }
.dpad [data-key=down] { grid-column:2; grid-row:2; }
.dpad [data-key=right] { grid-column:3; grid-row:2; }
.telemetry { display:none; }
.settings-card { flex:none; padding:12px 14px; display:flex; flex-direction:column; gap:10px; max-height:calc(100vh - 190px); overflow-y:auto; scrollbar-width:thin; scrollbar-color:#ffffff30 transparent; }
.settings-card > * { flex-shrink:0; }
.settings-card > .segment { flex:none; }
.exp-head { display:flex; align-items:center; justify-content:space-between; }
.exp-title { font-size:12px; font-weight:600; color:rgba(255,255,255,.9); }
.exp-collapse { background:transparent; color:rgba(255,255,255,.55); font-size:12px; padding:2px 6px; border-radius:8px; }
.row { display:flex; align-items:end; gap:8px; }
.field { flex:1; min-width:0; display:flex; flex-direction:column; gap:3px; }
.field label { font-size:11px; color:rgba(255,255,255,.72); white-space:nowrap; }
.field input[type=number], .field select { width:100%; height:32px; border:1px solid rgba(255,255,255,.13); border-radius:20px; background:rgba(255,255,255,.06); color:#e8eaed; padding:0 9px; outline:0; font-size:12px; }
.field input:focus, .field select:focus { border-color:rgba(138,180,255,.55); }
.field select option { background:#12141a; }
.field input[type=range] { accent-color:#8ab4ff; width:100%; margin:4px 0 0; height:20px; }
.field label:has(output) { display:flex; justify-content:space-between; align-items:baseline; }
.field output { color:#8ab4ff; font:11px Consolas,monospace; }
.segment { display:flex; border:1px solid rgba(255,255,255,.13); border-radius:20px; overflow:hidden; flex:1; }
.segment button { flex:1; height:32px; background:transparent; color:rgba(255,255,255,.65); white-space:nowrap; font-size:12px; }
.segment button.on { color:#8ab4ff; background:rgba(138,180,255,.18); font-weight:600; }
.check { display:flex; align-items:center; justify-content:center; gap:6px; white-space:nowrap; height:32px; font-size:12px; }
.check input { accent-color:#8ab4ff; }
.secondary { background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.14)!important; border-radius:20px; height:34px; padding:0 14px; white-space:nowrap; }
.action-card { display:flex; align-items:center; gap:10px; flex:none; height:48px; padding:0 8px 0 16px; border-radius:999px; background:rgba(16,18,24,.92); backdrop-filter:blur(8px); }
.action-mode { white-space:nowrap; color:rgba(255,255,255,.7); font-size:12px; }
.action-mode b { color:#8ab4ff; font-weight:600; }
.run { flex:1; height:34px; border-radius:20px; padding:0 14px; background:#8ab4ff; color:#0b1220!important; font-size:12px; font-weight:600!important; }
.run.stop { color:#ff7b72!important; background:rgba(255,123,114,.18); border:1px solid rgba(255,123,114,.45); }
.icon-button { border-radius:999px; height:36px; width:36px; flex:none; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.14)!important; padding:0; font-size:16px!important; }
.loc-error { color:#ff7b72; font-size:12px; text-align:center; border:0; background:transparent; border-radius:0; overflow-wrap:anywhere; }
.loc-error:empty { display:none; }
.op-area { flex:none; border:1px solid rgba(255,255,255,.12); border-radius:999px; background:rgba(16,18,24,.94); overflow:hidden; transition:border-radius .3s ease; }
.op-area.expanded { border-radius:20px; }
.settings-wrap { display:grid; grid-template-rows:0fr; transition:grid-template-rows .3s ease; }
.op-area.expanded .settings-wrap { grid-template-rows:1fr; }
.op-clip { min-height:0; overflow:hidden; }
.op-clip > .loc-card { border:0; border-radius:0; background:transparent; }
#settings svg { transition:transform .3s ease; }
#settings.open svg { transform:rotate(180deg); }
.exp-collapse svg, .icon-button svg { width:16px; height:16px; display:block; margin:auto; }
.locpanel [hidden] { display:none!important; }
@media (prefers-reduced-motion:reduce) { .panel-col, .settings-wrap, #settings svg { transition:none; } }
`;

export function renderLocationPanel(): void {
  const api = (window as unknown as {devemu: LocBridge}).devemu;
  const serial = new URLSearchParams(location.hash.split('?')[1]).get('serial') ?? '';
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  document.body.className = 'locpanel';
  const col = document.createElement('main');
  col.className = 'panel-col';
  col.innerHTML = `
<section class="loc-card map-card" aria-label="定位地图">
  <div class="map-host"></div>
  <form class="map-searchbar"><input class="search-input" aria-label="搜索地点或纬度经度" placeholder="搜索位置" spellcheck="false"><button type="submit">搜索</button></form>
  <output class="map-coord" title="双击地图切换位置">未设置起点</output>
  <div class="map-tools"><button data-map="center" title="回到当前位置" aria-label="回到当前位置">◎</button><button data-map="in" title="放大" aria-label="放大">+</button><button data-map="out" title="缩小" aria-label="缩小">−</button></div>
  <div class="dpad" aria-label="方向控制" hidden><button data-key="up" aria-label="向北 W" title="向北 W / ↑">W</button><button data-key="left" aria-label="向西 A" title="向西 A / ←">A</button><button data-key="down" aria-label="向南 S" title="向南 S / ↓">S</button><button data-key="right" aria-label="向东 D" title="向东 D / →">D</button></div>
</section>

<section class="loc-card settings-card" aria-label="定位设置">
  <div class="row"><div class="segment" id="mode"><button data-mode="manual">实时操作</button><button data-mode="route">加载路线</button></div><label class="check" id="loop-wrap"><input id="loop" type="checkbox" checked>循环</label></div>
  <div class="row" id="route-row"><div class="field"><label for="route">路线</label><select id="route" aria-label="路线"></select></div><button class="secondary" id="draw">绘制</button><button class="secondary" id="import">导入</button><input type="file" id="route-file" accept=".gpx,.csv,.txt" hidden></div>
  <div class="segment" id="presets"><button data-preset="walk">走步</button><button data-preset="brisk">快走</button><button data-preset="run">跑步</button></div>
  <div class="row">
    <div class="field"><label for="speed">速度 m/s</label><input id="speed" type="number" min="0.3" max="12" step="any" value="1.4"></div>
    <div class="field"><label for="cadence">步频 步/分</label><input id="cadence" type="number" min="40" max="240" step="any" value="112"></div>
    <div class="field"><label for="stride">步幅 m</label><input id="stride" type="number" min="0.2" max="3" step="any" value="0.75"></div>
  </div>
  <div class="row">
    <div class="field"><label for="altitude">海拔 m</label><input id="altitude" type="number" min="-500" max="9000" step="any" value="12"></div>
    <div class="field"><label for="acceleration">加速度 m/s²</label><input id="acceleration" type="number" min="0.1" max="5" step="any" value="1.2"></div>
    <div class="field"><label for="heading">初始航向 °</label><input id="heading" type="number" min="0" max="359" step="any" value="0"></div>
  </div>
  <div class="field"><label for="map-alignment">底图适配</label><select id="map-alignment" title="Google 大陆街道图使用 GCJ-02；仅转换底图显示，GPS 数值保持原样"><option value="google">Google 大陆地图</option><option value="gps">标准 GPS</option></select></div>
  <div class="row"><div class="field"><label for="speed-jitter">速度波动<output>8%</output></label><input id="speed-jitter" type="range" min="0" max="50" value="8"></div><div class="field"><label for="stride-jitter">步幅波动<output>8%</output></label><input id="stride-jitter" type="range" min="0" max="50" value="8"></div></div>
  <div class="row"><div class="field"><label for="cadence-jitter">步频波动<output>8%</output></label><input id="cadence-jitter" type="range" min="0" max="50" value="8"></div><div class="field"><label for="drift">GPS 漂移<output>5m</output></label><input id="drift" type="range" min="0" max="50" value="5"></div></div>
  <button class="secondary" id="save-prefs">保存</button>
</section>
<div class="loc-card loc-error" role="alert"></div>
<section class="loc-card action-card"><button class="run" id="run">开始</button><button class="icon-button" id="settings" title="收起设置" aria-label="收起设置"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></section>
<section class="loc-card action-card" id="draw-bar" hidden><input class="search-input" id="draw-name" placeholder="路线名称" aria-label="路线名称"><button class="icon-button" id="undo" title="撤销末点">↶</button><button class="secondary" id="draw-save">保存</button><button class="icon-button" id="draw-cancel" title="取消绘制">×</button></section>`;
  document.body.append(col);
  const opArea=document.createElement('section'); opArea.className='op-area';
  const settingsWrap=document.createElement('div'); settingsWrap.className='settings-wrap';
  const clip=document.createElement('div'); clip.className='op-clip';
  clip.append(col.querySelector('.settings-card')!);
  settingsWrap.append(clip);
  opArea.append(settingsWrap,col.querySelector('.action-card')!);
  col.querySelector('.map-card')!.after(opArea);

  const settingsCard = col.querySelector<HTMLElement>('.settings-card')!;
  const head = document.createElement('div');
  head.className='exp-head';
  head.innerHTML='<span class="exp-title">定位设置</span><button class="exp-collapse" title="收起设置" aria-label="收起设置"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
  settingsCard.prepend(head);
  const actions=document.createElement('div'); actions.className='row';
  actions.append(col.querySelector('#save-prefs')!);
  settingsCard.append(actions,col.querySelector('.loc-error')!);
  head.querySelector('button')!.addEventListener('click',()=>col.querySelector<HTMLButtonElement>('#settings')!.click());
  const floatStatus=document.createElement('output'); floatStatus.className='float-status'; floatStatus.hidden=true; floatStatus.title='步数按运动模型估算；系统计步器是否可用取决于镜像';
  col.querySelector('.map-card')!.append(floatStatus);
  for(const [key,label] of Object.entries({up:'▲',left:'◀',down:'▼',right:'▶'})) col.querySelector('[data-key='+key+']')!.textContent=label;

  const q = <T extends Element = HTMLElement>(selector: string): T => col.querySelector<T>(selector)!;
  const input = (id: string): HTMLInputElement => q<HTMLInputElement>('#' + id);
  const button = (id: string): HTMLButtonElement => q<HTMLButtonElement>('#' + id);
  const coord = q<HTMLOutputElement>('.map-coord');
  const err = q('.loc-error');
  const mapHost = q('.map-host');
  const map = createMap(mapHost, {zoom: 16});
  let mapCompatibility = true;
  map.setGoogleCompatibility(mapCompatibility);
  let mode: 'route' | 'manual' = 'manual';
  let anchor: MapPoint | null = null;
  let routes: RouteEntry[] = [];
  let selectedRoute = '';
  let state: LocationStatus | null = null;
  let lastFix: MapPoint | null = null;
  let busy = false, drawing = false, pollBusy = false, disposed = false, settingsOpen = false, ready = false;
  let drawPts: MapPoint[] = [];
  let stroke: {pointerId: number; x: number; y: number} | null = null;
  const held = new Map<string, NudgeKey>();
  const routeSelect = q<HTMLSelectElement>('#route');
  const error = (reason: unknown): void => {
    err.textContent = reason instanceof Error ? reason.message : String(reason);
    floatStatus.textContent=err.textContent;
    floatStatus.hidden=false;
  };
  const check = <T,>(r: Result<T>): T | undefined => { if (!r.ok) throw new Error(r.error ?? '操作失败'); return r.data; };
  const safe = (fn: () => Promise<unknown>) => (): void => { void fn().catch(error); };
  const numeric = (id: string): number => Number(input(id).value);
  const setAnchor = (p: MapPoint, center = false): void => {
    anchor = p;
    map.setMarker(p);
    coord.textContent = p.lat.toFixed(6) + ', ' + p.lon.toFixed(6);
    if (center) map.setCenter(p);
  };
  function previewRoute(center = true): void {
    const rt = routes.find(r => r.id === selectedRoute);
    map.setPath(mode === 'route' ? rt?.points ?? null : null);
    if (mode === 'route' && rt?.points[0]) setAnchor(rt.points[0], center);
  }
  // 手动模式下选点立即生效：空闲则原地起会话，进行中则原地传送；路线模式仅选点/居中
  async function applyPosition(p: MapPoint, center: boolean): Promise<void> {
    if (busy) return;
    if (!(state ? state.mode === 'manual' : mode === 'manual')) { setAnchor(p, center); return; }
    setAnchor(p, center);
    busy = true;
    err.textContent = '';
    syncUi();
    try {
      if (state) {
        check(await api.locationTeleport(serial, p.lat, p.lon));
      } else {
        const config = {...fields(), mode: 'manual', anchor: p, route: undefined} as LocationConfig;
        check(await api.locationStart(serial, config));
        await api.locPrefsSave(fields());
        state = check(await api.locationStatus(serial)) ?? null;
        (document.activeElement as HTMLElement)?.blur();
        window.focus();
      }
    } finally { busy = false; renderStatus(); }
  }
  function syncUi(): void {
    for (const b of col.querySelectorAll<HTMLButtonElement>('[data-mode]')) b.classList.toggle('on', b.dataset.mode === mode);
    q('#route-row').hidden = mode !== 'route';
    q('#loop-wrap').hidden = mode !== 'route';
    const showRun = !!state || mode === 'route';
    button('run').hidden = !showRun;
    button('run').textContent = busy ? '处理中…' : state ? '停止' : '开始';
    button('run').disabled = busy || !ready;
    button('run').classList.toggle('stop', !!state);
    q('.dpad').hidden = !state || state.mode !== 'manual' || state.paused;
    for (const control of q('.settings-card').querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) control.disabled = control === head.querySelector('button') ? busy : !!state || busy;
    opArea.classList.toggle('expanded',settingsOpen);
    opArea.hidden=drawing;
    settingsCard.inert = !settingsOpen || drawing;
    q('#draw-bar').hidden = !drawing;
    button('settings').classList.toggle('open',settingsOpen);
    button('settings').title = settingsOpen ? '收起设置' : '展开设置';
    button('settings').setAttribute('aria-label', button('settings').title);
    button('settings').setAttribute('aria-expanded', String(settingsOpen));
    q<HTMLInputElement>('form input').disabled = busy;
    q<HTMLButtonElement>('form button').disabled = busy;
  }
  function renderStatus(): void {
    const s = state;
    floatStatus.hidden=!s && !err.textContent;
    if(s)floatStatus.textContent=(s.paused?'暂停 · ':s.finished?'完成 · ':'')+s.speedMps.toFixed(1)+'m/s · '+s.steps+'步 · '+s.distanceM.toFixed(1)+'m';
    else if(err.textContent)floatStatus.textContent=err.textContent;
    coord.hidden=!!s;
    if (s) {
      coord.textContent = s.lat.toFixed(6) + ', ' + s.lon.toFixed(6);
      lastFix={lat:s.lat,lon:s.lon};
      map.setLiveMarker(s);
      if (s.mode === 'manual') map.setCenter(s);
      if (s.lastError) error(s.lastError);
    } else map.setLiveMarker(lastFix);
    syncUi();
  }
  async function refreshRoutes(): Promise<void> {
    routes = check(await api.routeList()) ?? [];
    routeSelect.replaceChildren(new Option('选择路线', ''));
    for (const rt of routes) routeSelect.add(new Option(rt.name, rt.id));
    routeSelect.value = routes.some(r => r.id === selectedRoute) ? selectedRoute : '';
    selectedRoute = routeSelect.value;
  }
  function fields(): Prefs {
    return {mode, anchor: anchor ?? undefined, loop: input('loop').checked,
      speedMps: numeric('speed'), cadenceSpm: numeric('cadence'), strideM: numeric('stride'),
      altitudeM: numeric('altitude'), headingDeg: numeric('heading'), accelerationMps2: numeric('acceleration'),
      speedJitterPct: numeric('speed-jitter'), strideJitterPct: numeric('stride-jitter'),
      cadenceJitterPct: numeric('cadence-jitter'), gpsNoiseM: numeric('drift'), lastRouteId: selectedRoute, mapCompatibility};
  }
  function validateFields(): void {
    for (const field of q('.settings-card').querySelectorAll<HTMLInputElement>('input[type=number]')) {
      if (!field.value || !Number.isFinite(Number(field.value)) || !field.reportValidity()) throw new Error('运动参数超出范围');
    }
    if (Math.abs(numeric('speed') - numeric('cadence') / 60 * numeric('stride')) > .001) throw new Error('速度必须等于步频 × 步幅 ÷ 60');
  }
  function syncGait(source: string): void {
    if (source === 'stride') input('speed').value = String(Number((numeric('stride') * numeric('cadence') / 60).toFixed(6)));
    else input('stride').value = String(Number(derivedStrideM(numeric('speed'), numeric('cadence')).toFixed(6)));
    for (const b of col.querySelectorAll('[data-preset]')) b.classList.remove('on');
  }
  for (const id of ['speed','cadence','stride']) input(id).addEventListener('input', () => syncGait(id));
  for (const b of col.querySelectorAll<HTMLButtonElement>('[data-preset]')) b.addEventListener('click', () => {
    const profile = PRESETS[b.dataset.preset as keyof typeof PRESETS];
    input('speed').value = String(profile.speedMps);
    input('cadence').value = String(profile.cadenceSpm);
    syncGait('speed');
    b.classList.add('on');
  });
  for (const field of col.querySelectorAll<HTMLInputElement>('input[type=range]')) field.addEventListener('input', () => {
    field.parentElement!.querySelector('output')!.textContent = field.value + (field.id === 'drift' ? 'm' : '%');
  });
  for (const b of col.querySelectorAll<HTMLButtonElement>('[data-mode]')) b.addEventListener('click', () => {
    mode = b.dataset.mode as typeof mode;
    previewRoute();
    syncUi();
  });
  routeSelect.addEventListener('change', () => { selectedRoute = routeSelect.value; previewRoute(); });
  q<HTMLSelectElement>('#map-alignment').addEventListener('change', () => {
    mapCompatibility=q<HTMLSelectElement>('#map-alignment').value==='google';
    map.setGoogleCompatibility(mapCompatibility);
  });
  map.onDoubleClick(p => { if (!drawing) applyPosition(p, false).catch(error); });
  q('[data-map=in]').addEventListener('click', () => map.zoomBy(1));
  q('[data-map=out]').addEventListener('click', () => map.zoomBy(-1));
  q('[data-map=center]').addEventListener('click', () => { if (state) map.setCenter(state); else if (anchor) map.setCenter(anchor); });
  q('form').addEventListener('submit', e => {
    e.preventDefault();
    void (async () => {
      if (busy) return;
      err.textContent = '';
      const term = q<HTMLInputElement>('.search-input').value.trim();
      if (!term) return;
      const pair = term.match(/^(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)$/);
      if (pair) {
        const p = {lat: Number(pair[1]), lon: Number(pair[2])};
        if (Math.abs(p.lat) > 85 || Math.abs(p.lon) > 180) throw new Error('经纬度超出范围');
        await applyPosition(p, true);
        return;
      }
      const submit = q<HTMLButtonElement>('form button');
      submit.disabled = true;
      try {
        const response = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(term), {signal: AbortSignal.timeout(6000)});
        if (!response.ok) throw new Error('地点搜索暂不可用');
        const hits = await response.json() as {lat: string; lon: string}[];
        if (!hits[0]) throw new Error('未找到地点');
        const p = {lat: Number(hits[0].lat), lon: Number(hits[0].lon)};
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 85 || Math.abs(p.lon) > 180) throw new Error('搜索结果坐标无效');
        await applyPosition(mapCompatibility ? toGoogleMap(p) : p, true);
      } finally { submit.disabled = false; }
    })().catch(error);
  });
  button('settings').addEventListener('click', () => { settingsOpen = !settingsOpen; syncUi(); });
  button('save-prefs').addEventListener('click', safe(async () => {
    validateFields();
    check(await api.locPrefsSave(fields()));
    button('save-prefs').textContent = '已保存';
    window.setTimeout(() => { settingsOpen = false; syncUi(); }, 600);
    window.setTimeout(() => button('save-prefs').textContent = '保存', 1000);
  }));
  async function poll(): Promise<void> {
    if (pollBusy || disposed || busy || !ready) return;
    pollBusy = true;
    try { state = check(await api.locationStatus(serial)) ?? null; renderStatus(); }
    finally { pollBusy = false; }
  }
  button('run').addEventListener('click', safe(async () => {
    if (busy) return;
    busy = true;
    err.textContent = '';
    syncUi();
    try {
      if (state) { await releaseAll(); check(await api.locationStop(serial)); state = null; }
      else {
        validateFields();
        const route = routes.find(r => r.id === selectedRoute)?.points;
        if (mode === 'route' && (!route || route.length < 2)) throw new Error('请选择或绘制路线');
        const start = mode === 'route' ? route![0]! : anchor;
        if (!start) throw new Error('请双击地图或输入坐标设置起点');
        const config = {...fields(), mode, anchor: start, route} as LocationConfig;
        check(await api.locationStart(serial, config));
        await api.locPrefsSave(fields());
        state = check(await api.locationStatus(serial)) ?? null;
        if (mode === 'manual') { (document.activeElement as HTMLElement)?.blur(); window.focus(); }
      }
    } finally { busy = false; renderStatus(); }
  }));
  function hold(source: string, key: NudgeKey, on: boolean): void {
    const before = [...held.values()].includes(key);
    if (on) held.set(source,key); else held.delete(source);
    const after = [...held.values()].includes(key);
    q('[data-key=' + key + ']').classList.toggle('hold', after);
    if (before !== after) void api.locationNudge(serial,key,after).then(check).catch(error);
  }
  async function releaseAll(): Promise<void> {
    const keys = [...new Set(held.values())];
    held.clear();
    for (const b of col.querySelectorAll('.hold')) b.classList.remove('hold');
    await Promise.all(keys.map(key => api.locationNudge(serial,key,false)));
  }
  for (const b of col.querySelectorAll<HTMLButtonElement>('[data-key]')) {
    const key = b.dataset.key as NudgeKey;
    b.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !state || state.paused) return;
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      hold('pointer:' + e.pointerId, key, true);
    });
    for (const event of ['pointerup','pointercancel','lostpointercapture']) b.addEventListener(event, e => hold('pointer:' + (e as PointerEvent).pointerId, key, false));
  }
  const keyMap: Record<string,NudgeKey> = {KeyW:'up',ArrowUp:'up',KeyS:'down',ArrowDown:'down',KeyA:'left',ArrowLeft:'left',KeyD:'right',ArrowRight:'right'};
  window.addEventListener('keydown', e => {
    const key = keyMap[e.code];
    if (!key || !state || mode !== 'manual' || state.paused || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    if ((e.target as HTMLElement).closest('input,select,textarea,[contenteditable=true]')) return;
    e.preventDefault();
    if (!e.repeat) hold(e.code,key,true);
  });
  window.addEventListener('keyup', e => {
    const key = held.get(e.code);
    if (key) { e.preventDefault(); hold(e.code,key,false); }
  });
  window.addEventListener('blur', () => void releaseAll());
  document.addEventListener('visibilitychange', () => { if (document.hidden) void releaseAll(); });
  function setDrawing(on: boolean): void {
    drawing = on;
    stroke = null;
    map.setDragEnabled(!on);
    if (on) { drawPts=[]; map.setPath([]); }
    else previewRoute(false);
    syncUi();
    if (on) input('draw-name').focus();
  }
  button('draw').addEventListener('click', () => setDrawing(true));
  button('draw-cancel').addEventListener('click', () => setDrawing(false));
  button('undo').addEventListener('click', () => { drawPts.pop(); map.setPath(drawPts); });
  mapHost.addEventListener('pointerdown', e => {
    if (!drawing || e.button !== 0) return;
    const r = mapHost.getBoundingClientRect();
    stroke = {pointerId:e.pointerId,x:e.clientX-r.left,y:e.clientY-r.top};
    drawPts.push(map.pixelToLatLng(stroke.x,stroke.y));
    map.setPath(drawPts);
    mapHost.setPointerCapture(e.pointerId);
  });
  mapHost.addEventListener('pointermove', e => {
    if (!stroke || stroke.pointerId !== e.pointerId) return;
    const r = mapHost.getBoundingClientRect();
    const x=e.clientX-r.left, y=e.clientY-r.top;
    if (Math.hypot(x-stroke.x,y-stroke.y) < 5 || drawPts.length >= 2000) return;
    stroke.x=x; stroke.y=y;
    drawPts.push(map.pixelToLatLng(x,y));
    map.setPath(drawPts);
  });
  for (const event of ['pointerup','pointercancel','lostpointercapture']) mapHost.addEventListener(event, () => stroke = null);
  async function saveRoute(points: MapPoint[], name: string): Promise<void> {
    if (points.length < 2) throw new Error('路线至少需要两个位置');
    selectedRoute = check(await api.routeSave(name || '新路线',points)) ?? '';
    await refreshRoutes();
    setDrawing(false);
    mode = 'route';
    previewRoute();
    syncUi();
  }
  button('draw-save').addEventListener('click', safe(async () => {
    button('draw-save').disabled=true;
    try { await saveRoute(drawPts, input('draw-name').value.trim()); }
    finally { button('draw-save').disabled=false; }
  }));
  button('import').addEventListener('click', () => input('route-file').click());
  input('route-file').addEventListener('change', safe(async () => {
    const file=input('route-file').files?.[0];
    if (!file) return;
    if (file.size > 2_000_000) throw new Error('路线文件不能超过 2MB');
    const points=check(await api.routeParse(await file.text())) ?? [];
    await saveRoute(points, file.name.replace(/\.[^.]+$/, ''));
    input('route-file').value='';
  }));
  const pollTimer=window.setInterval(() => void poll().catch(error), 250);
  const close = (): void => {
    void releaseAll();
    document.body.classList.remove('panel-ready');
    window.setTimeout(() => window.close(),160);
  };
  (window as unknown as {__panelClose: () => void}).__panelClose=close;
  window.addEventListener('beforeunload', () => { disposed=true; clearInterval(pollTimer); void releaseAll(); map.destroy(); });
  void (async () => {
    const prefs=check(await api.locPrefsLoad()) ?? {};
    const active=check(await api.locationStatus(serial)) ?? null;
    const p: Prefs = active ? {...active.config,lastRouteId:prefs.lastRouteId} : prefs;
    mode=p.mode ?? mode;
    const mapping: Record<string,keyof Prefs> = {speed:'speedMps',cadence:'cadenceSpm',stride:'strideM',altitude:'altitudeM',heading:'headingDeg',acceleration:'accelerationMps2','speed-jitter':'speedJitterPct','stride-jitter':'strideJitterPct','cadence-jitter':'cadenceJitterPct',drift:'gpsNoiseM'};
    for (const [id,key] of Object.entries(mapping)) if (typeof p[key] === 'number') input(id).value=String(p[key]);
    syncGait('speed');
    for (const field of col.querySelectorAll<HTMLInputElement>('input[type=range]')) field.dispatchEvent(new Event('input'));
    input('loop').checked=p.loop ?? true;
    mapCompatibility=p.mapCompatibility ?? true;
    q<HTMLSelectElement>('#map-alignment').value=mapCompatibility ? 'google' : 'gps';
    map.setGoogleCompatibility(mapCompatibility);
    if (p.anchor) setAnchor(p.anchor,true);
    selectedRoute=p.lastRouteId ?? '';
    await refreshRoutes();
    previewRoute(!active);
    if (active) { state=active; map.setPath(active.config.route ?? null); map.setCenter(active); }
    ready=true;
    renderStatus();
  })().catch(error);
  syncUi();
  requestAnimationFrame(() => document.body.classList.add('panel-ready'));
}
