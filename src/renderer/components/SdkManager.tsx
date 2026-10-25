import { useCallback, useEffect, useState } from 'react';
import { api, type SdkPkg } from '../api.ts';
import { Modal } from './Modal.tsx';

export function SdkManager({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<'installed' | 'available'>('installed');
  const [data, setData] = useState<{ installed: SdkPkg[]; available: SdkPkg[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [busyPkg, setBusyPkg] = useState('');

  const reload = useCallback(() => {
    setLoading(true);
    setError('');
    api.sdkPackages().then((r) => {
      if (r.ok) setData(r.data);
      else setError(r.error);
      setLoading(false);
    });
  }, []);

  useEffect(reload, [reload]);

  async function act(pkg: string, action: 'sdkInstall' | 'sdkUninstall') {
    setBusyPkg(pkg);
    setError('');
    const r = await api[action](pkg);
    setBusyPkg('');
    if (!r.ok) {
      setError(r.error);
      return;
    }
    reload();
    onChanged();
  }

  const list = (tab === 'installed' ? data?.installed : data?.available) ?? [];
  const shown = query.trim()
    ? list.filter((e) => e.pkg.toLowerCase().includes(query.trim().toLowerCase()) || e.desc.includes(query.trim()))
    : list;

  return (
    <Modal
      title="管理 SDK"
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          关闭
        </button>
      }
    >
      <div className="sdk-tabs">
        <div className={`sdk-tab${tab === 'installed' ? ' on' : ''}`} onClick={() => setTab('installed')}>
          已安装 {data ? `(${data.installed.length})` : ''}
        </div>
        <div className={`sdk-tab${tab === 'available' ? ' on' : ''}`} onClick={() => setTab('available')}>
          可安装 {data ? `(${data.available.length})` : ''}
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
        {loading && (
          <div className="empty">
            <span className="spinner" /> 读取组件列表…
          </div>
        )}
        {!loading && error && <div className="error-line" style={{ border: 'none' }}>{error}</div>}
        {!loading && !error && shown.length === 0 && <div className="empty">没有匹配的组件</div>}
        {!loading &&
          shown.map((e) => (
            <div key={e.pkg} className="img-row">
              <div className="sdk-pkg">
                <span className="mono">{e.pkg}</span>
                <span className="sdk-desc">
                  {e.desc} {e.version && `· ${e.version}`}
                </span>
              </div>
              {tab === 'installed' ? (
                <button
                  className="btn btn-sm btn-danger"
                  disabled={busyPkg !== ''}
                  onClick={() => act(e.pkg, 'sdkUninstall')}
                >
                  {busyPkg === e.pkg ? '卸载中' : '卸载'}
                </button>
              ) : (
                <button
                  className="btn btn-sm btn-primary"
                  disabled={busyPkg !== ''}
                  onClick={() => act(e.pkg, 'sdkInstall')}
                >
                  {busyPkg === e.pkg ? '安装中' : '安装'}
                </button>
              )}
            </div>
          ))}
      </div>
      <div className="form-hint">安装与卸载经官方 sdkmanager 执行，大组件下载耗时数分钟。</div>
    </Modal>
  );
}
