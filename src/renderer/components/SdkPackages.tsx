import { useCallback, useEffect, useState } from 'react';
import { api, onDownloadsChanged, type DownloadItem, type HarmonyComponent, type SdkPkg } from '../api.ts';
import { Segmented } from './Segmented.tsx';
import { flyToDownloads } from './Fly.tsx';
import { toast } from './Toast.tsx';
import type { EnvStatus } from '../App.tsx';

type System = 'android' | 'harmonyos';

/** SDK 组件管理（内联于设置 SDK 分区）：右上角 Android/HarmonyOS 切换，两侧结构一致 */
export function SdkPackages({ env, onChanged }: { env: EnvStatus | null; onChanged: () => void }) {
  const [system, setSystem] = useState<System>('android');
  const [tab, setTab] = useState<'installed' | 'available'>('installed');
  const [installed, setInstalled] = useState<SdkPkg[] | null>(null);
  const [available, setAvailable] = useState<SdkPkg[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [busyPkg, setBusyPkg] = useState('');

  // 进行中的下载任务（按包名索引），驱动安装按钮状态
  const [dl, setDl] = useState<Record<string, DownloadItem>>({});

  const harmonyComponents: HarmonyComponent[] = env?.harmony?.components ?? [];

  const reloadInstalled = useCallback(() => {
    api.sdkInstalled().then((r) => {
      if (r.ok) setInstalled(r.data);
      else setError(r.error);
    });
  }, []);

  useEffect(reloadInstalled, [reloadInstalled]);

  // 可安装列表只在首次切到该页签时拉取（需联网，慢）
  useEffect(() => {
    if (tab !== 'available' || available !== null || loading) return;
    setLoading(true);
    setError('');
    api.sdkAvailable().then((r) => {
      if (r.ok) setAvailable(r.data);
      else setError(r.error);
      setLoading(false);
    });
  }, [tab, available, loading]);

  // 下载快照：多任务互不影响，各按钮只反映自己
  useEffect(
    () =>
      onDownloadsChanged((s) => {
        const m: Record<string, DownloadItem> = {};
        for (const d of s.active) m[d.pkg] = d;
        setDl(m);
      }),
    [],
  );

  function install(pkg: string, rect: DOMRect) {
    flyToDownloads(rect);
    void api.sdkInstall(pkg).then((r) => {
      if (r.ok) toast(`${pkg} 安装完成`, 'ok');
      else toast(`安装失败：${r.error}`);
    });
  }

  async function uninstallAndroid(pkg: string) {
    setBusyPkg(pkg);
    setError('');
    const r = await api.sdkUninstall(pkg);
    setBusyPkg('');
    if (!r.ok) {
      setError(r.error);
      return;
    }
    toast(`${pkg} 卸载完成`, 'ok');
    reloadInstalled();
    onChanged();
  }

  async function uninstallHarmony(c: HarmonyComponent) {
    setBusyPkg(c.dir);
    setError('');
    const r = await api.harmonyUninstall(c.dir);
    setBusyPkg('');
    if (!r.ok) {
      setError(r.error);
      return;
    }
    toast(`${c.name} 卸载完成`, 'ok');
    onChanged();
  }

  const sysSwitch = (
    <div style={{ marginLeft: 'auto' }}>
      <Segmented
        options={[
          { id: 'android', label: 'Android' },
          { id: 'harmonyos', label: 'HarmonyOS' },
        ]}
        value={system}
        onChange={setSystem}
      />
    </div>
  );

  const q = query.trim().toLowerCase();
  const harmonyShown = q
    ? harmonyComponents.filter((c) => c.name.toLowerCase().includes(q) || (c.version ?? '').toLowerCase().includes(q))
    : harmonyComponents;

  function installBtn(pkg: string) {
    const st = dl[pkg];
    const busy = !!st && (st.state === 'downloading' || st.state === 'queued');
    return (
      <button
        className="btn btn-sm btn-primary"
        disabled={busy}
        onClick={(ev) => install(pkg, ev.currentTarget.getBoundingClientRect())}
      >
        {!st ? '安装' : st.state === 'queued' ? '排队中' : st.total > 0 ? `${st.percent}%` : '安装中'}
      </button>
    );
  }

  if (system === 'harmonyos') {
    return (
      <div>
        <div className="sdk-tabs">
          <div className={`sdk-tab${tab === 'installed' ? ' on' : ''}`} onClick={() => setTab('installed')}>
            已安装 {env?.harmony ? `(${harmonyComponents.length})` : ''}
          </div>
          <div className={`sdk-tab${tab === 'available' ? ' on' : ''}`} onClick={() => setTab('available')}>
            可安装
          </div>
          {sysSwitch}
        </div>
        <input
          className="sdk-search"
          placeholder="搜索组件或版本"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        <div className="sdk-list">
          {!env?.harmony && <div className="empty">未检测到 HarmonyOS SDK</div>}
          {env?.harmony && tab === 'installed' && harmonyComponents.length === 0 && <div className="empty">没有检测到组件</div>}
          {env?.harmony && tab === 'available' && <div className="empty">HarmonyOS SDK 组件经 DevEco Studio 下载</div>}
          {env?.harmony &&
            tab === 'installed' &&
            harmonyShown.map((c) => (
              <div key={c.dir} className="img-row" title={c.dir}>
                <div className="sdk-pkg">
                  <span className="mono">{c.name}</span>
                  <span className="sdk-desc">{c.version ?? c.dir}</span>
                </div>
                <button className="btn btn-sm btn-danger" disabled={busyPkg === c.dir} onClick={() => uninstallHarmony(c)}>
                  {busyPkg === c.dir ? '卸载中' : '卸载'}
                </button>
              </div>
            ))}
          {error && <div className="error-line" style={{ border: 'none' }}>{error}</div>}
        </div>
      </div>
    );
  }

  const list = (tab === 'installed' ? installed : available) ?? [];
  const shown = q ? list.filter((e) => e.pkg.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q)) : list;

  return (
    <div>
      <div className="sdk-tabs">
        <div className={`sdk-tab${tab === 'installed' ? ' on' : ''}`} onClick={() => setTab('installed')}>
          已安装 {installed ? `(${installed.length})` : ''}
        </div>
        <div className={`sdk-tab${tab === 'available' ? ' on' : ''}`} onClick={() => setTab('available')}>
          可安装 {available ? `(${available.length})` : ''}
        </div>
        {sysSwitch}
      </div>
      <input
        className="sdk-search"
        placeholder="搜索包名或描述"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
      />
      <div className="sdk-list">
        {tab === 'installed' && installed === null && (
          <div className="empty">
            <span className="spinner" />
          </div>
        )}
        {tab === 'available' && loading && (
          <div className="empty">
            <span className="spinner" /> 正在从仓库获取列表…
          </div>
        )}
        {error && <div className="error-line" style={{ border: 'none' }}>{error}</div>}
        {!loading && !error && shown.length === 0 && <div className="empty">没有匹配的组件</div>}
        {shown.map((e) => (
          <div key={e.pkg} className="img-row">
            <div className="sdk-pkg">
              <span className="mono">{e.pkg}</span>
              <span className="sdk-desc">
                {e.desc} {e.version && `· ${e.version}`}
              </span>
            </div>
            {tab === 'installed' ? (
              <button className="btn btn-sm btn-danger" disabled={busyPkg === e.pkg} onClick={() => uninstallAndroid(e.pkg)}>
                {busyPkg === e.pkg ? '卸载中' : '卸载'}
              </button>
            ) : (
              installBtn(e.pkg)
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
