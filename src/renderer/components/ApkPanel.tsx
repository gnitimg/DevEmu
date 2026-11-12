import { useCallback, useEffect, useState } from 'react';
import { api, type EmuDevice, type Scope } from '../api.ts';
import { fmtSize } from './Modal.tsx';
import { InstallModal } from './InstallModal.tsx';
import type { ApkMeta } from '../../core/types.ts';

export function ApkPanel({ scope, emus }: { scope: Scope; emus: EmuDevice[] }) {
  const [apps, setApps] = useState<ApkMeta[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<ApkMeta | null>(null); // 导入完成待选设备

  const reload = useCallback(() => {
    api.listApps(scope).then((r) => {
      if (r.ok) {
        setApps(r.data);
        setError('');
      } else setError(r.error);
    });
  }, [scope]);

  useEffect(reload, [reload]);

  async function doImport() {
    setImporting(true);
    setError('');
    const d = await api.openApkDialog();
    if (d.ok && d.data) {
      const r = await api.importApk(scope, d.data);
      if (!r.ok) setError(r.error);
      else {
        reload();
        setPending(r.data); // 弹出设备选择
      }
    }
    setImporting(false);
  }

  return (
    <div className="section">
      <div className="section-head">
        <h2 className="section-title">应用库</h2>
        {apps && <span className="section-count">{apps.length}</span>}
        <div className="section-actions">
          <button className="btn" onClick={doImport} disabled={importing}>
            {importing ? '导入中' : '导入应用'}
          </button>
        </div>
      </div>
      {apps === null ? (
        <div className="empty">
          <span className="spinner" />
        </div>
      ) : apps.length === 0 ? (
        <div className="empty">
          还没有导入应用
          <button className="btn btn-primary" onClick={doImport} disabled={importing}>
            导入
          </button>
        </div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>应用</th>
              <th>包名</th>
              <th style={{ width: 60 }}>版本</th>
              <th style={{ width: 70 }}>大小</th>
              <th style={{ width: 90 }}></th>
            </tr>
          </thead>
          <tbody>
            {apps.map((apk) => (
              <tr key={apk.id}>
                <td title={apk.fileName}>
                  <span className="chip" style={{ marginRight: 7 }}>
                    {apk.kind === 'hap' ? 'HAP' : 'APK'}
                  </span>
                  {apk.label ?? apk.fileName}
                </td>
                <td className="mono" style={{ color: 'var(--text-2)' }}>
                  {apk.packageName ?? '—'}
                </td>
                <td className="num">{apk.versionName ?? '—'}</td>
                <td className="num">{fmtSize(apk.size)}</td>
                <td>
                  <div className="row-actions">
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => setPending(apk)}
                      title="选择设备安装"
                    >
                      安装
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && <div className="error-line">{error}</div>}
      {pending && (
        <InstallModal apk={pending} emus={emus} scope={scope} onClose={() => setPending(null)} />
      )}
    </div>
  );
}
