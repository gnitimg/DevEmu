import { useCallback, useEffect, useState } from 'react';
import { api, onSdkProgress, type HarmonyInfo, type SdkPkg } from '../api.ts';
import { Segmented } from './Segmented.tsx';
import type { EnvStatus } from '../App.tsx';

type System = 'android' | 'harmonyos';

/** SDK 组件管理（内联于设置 SDK 分区）：右上角 Android/HarmonyOS 切换 */
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

  // HarmonyOS 侧
  const [targets, setTargets] = useState<string[] | null>(null);
  const [targetsBusy, setTargetsBusy] = useState(false);
  const [targetsError, setTargetsError] = useState('');

  const harmony: HarmonyInfo | null = env?.harmony ?? null;
  const harmonyPath = env?.settings.harmonySdkPath ?? harmony?.sdkRoot ?? '';

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

  async function browseHarmony() {
    const d = await api.openDirDialog('选择 HarmonyOS SDK 目录');
    if (d.ok && d.data && env) {
      const r = await api.saveSettings({ ...env.settings, harmonySdkPath: d.data });
      if (r.ok) onChanged();
      else setTargetsError(r.error);
    }
  }

  async function refreshTargets() {
    if (!harmony) return;
    setTargetsBusy(true);
    setTargetsError('');
    const r = await api.harmonyTargets();
    setTargetsBusy(false);
    if (r.ok) {
      setTargets(r.data);
    } else {
      setTargets(null);
      setTargetsError(r.error);
    }
  }

  const list = (tab === 'installed' ? installed : available) ?? [];
  const q = query.trim().toLowerCase();
  const shown = q ? list.filter((e) => e.pkg.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q)) : list;

  if (system === 'harmonyos') {
    return (
      <div>
        <div className="sdk-tabs">
          <div className="sdk-tab on">HarmonyOS SDK</div>
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
        </div>
        <div className="settings-row" style={{ borderBottom: '1px solid var(--border)' }}>
          <span className="settings-row-label">SDK 路径</span>
          <div className="path-row">
            <input value={harmonyPath} readOnly spellCheck={false} title={harmonyPath} placeholder="未检测到" />
            <button className="btn" onClick={browseHarmony}>
              浏览
            </button>
          </div>
        </div>
        {!harmony ? (
          <div className="empty">未检测到 HarmonyOS SDK</div>
        ) : (
          <>
            <div className="settings-row" style={{ borderBottom: '1px solid var(--border)' }}>
              <span className="settings-row-label">hdc</span>
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={harmony.hdc}>
                {harmony.hdc}
                {harmony.apiVersion ? ` · ${harmony.apiVersion}` : ''}
              </span>
            </div>
            <div className="settings-row" style={{ borderBottom: '1px solid var(--border)' }}>
              <span className="settings-row-label">设备</span>
              <div className="path-row" style={{ flex: 1 }}>
                {targetsBusy ? (
                  <span className="empty" style={{ padding: 0 }}>
                    <span className="spinner" />
                  </span>
                ) : targets && targets.length > 0 ? (
                  targets.map((t) => (
                    <span key={t} className="chip ok mono">
                      {t}
                    </span>
                  ))
                ) : (
                  <span style={{ fontSize: 12, color: targetsError ? 'var(--danger)' : 'var(--text-3)' }}>
                    {targetsError || (targets ? '无在线设备' : '未查询')}
                  </span>
                )}
                <button className="btn" onClick={refreshTargets} disabled={targetsBusy}>
                  刷新
                </button>
              </div>
            </div>
            <div className="sdk-list" style={{ marginTop: 10 }}>
              {harmony.components.map((c) => (
                <div key={c.dir} className="img-row" title={c.dir}>
                  <div className="sdk-pkg">
                    <span className="mono">{c.name}</span>
                    <span className="sdk-desc">{c.version ?? c.dir}</span>
                  </div>
                </div>
              ))}
              {harmony.components.length === 0 && <div className="empty">没有检测到组件</div>}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="sdk-tabs">
        <div className={`sdk-tab${tab === 'installed' ? ' on' : ''}`} onClick={() => setTab('installed')}>
          已安装 {installed ? `(${installed.length})` : ''}
        </div>
        <div className={`sdk-tab${tab === 'available' ? ' on' : ''}`} onClick={() => setTab('available')}>
          可安装 {available ? `(${available.length})` : ''}
        </div>
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
