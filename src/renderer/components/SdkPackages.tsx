import { useCallback, useEffect, useState } from 'react';
import { api, onSdkProgress, type HarmonyComponent, type SdkPkg } from '../api.ts';
import { Segmented } from './Segmented.tsx';
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
  const [progress, setProgress] = useState('');

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

  useEffect(() => onSdkProgress((line) => setProgress(line.trim().slice(0, 90))), []);

  async function act(pkg: string, action: 'sdkInstall' | 'sdkUninstall') {
    setBusyPkg(pkg);
    setError('');
    setProgress('');
    const r = await api[action](pkg);
    setBusyPkg('');
    setProgress('');
    if (!r.ok) {
      setError(r.error);
      return;
    }
    reloadInstalled();
    setAvailable(null);
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
                <button className="btn btn-sm btn-danger" disabled={busyPkg !== ''} onClick={() => uninstallHarmony(c)}>
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
              <button className="btn btn-sm btn-danger" disabled={busyPkg !== ''} onClick={() => act(e.pkg, 'sdkUninstall')}>
                {busyPkg === e.pkg ? '卸载中' : '卸载'}
              </button>
            ) : (
              <button className="btn btn-sm btn-primary" disabled={busyPkg !== ''} onClick={() => act(e.pkg, 'sdkInstall')}>
                {busyPkg === e.pkg ? '安装中' : '安装'}
              </button>
            )}
          </div>
        ))}
      </div>
      {busyPkg && progress && <div className="sdk-progress mono">{progress}</div>}
    </div>
  );
}
