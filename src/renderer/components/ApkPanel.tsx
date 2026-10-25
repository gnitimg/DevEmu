import { useCallback, useEffect, useState } from 'react';
import { api, type EmuDevice, type Scope } from '../api.ts';
import { fmtSize } from './Modal.tsx';
import type { ApkMeta } from '../../core/types.ts';

export function ApkPanel({
  scope,
  emus,
  onRecorded,
}: {
  scope: Scope;
  emus: EmuDevice[];
  onRecorded: () => void;
}) {
  const [apps, setApps] = useState<ApkMeta[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<ApkMeta | null>(null); // 导入完成待选设备

  const running = emus.filter((e) => e.state === 'device' && e.avdName);

  const reload = useCallback(() => {
    api.listApps(scope).then((r) => {
      if (r.ok) setApps(r.data);
      else setError(r.error);
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
        <h2 className="section-title">APK 库</h2>
        {apps && <span className="section-count">{apps.length}</span>}
        <div className="section-actions">
          <button className="btn" onClick={doImport} disabled={importing}>
            {importing ? '导入中' : '导入 APK'}
          </button>
        </div>
      </div>
      {apps === null ? (
        <div className="empty">
          <span className="spinner" />
        </div>
      ) : apps.length === 0 ? (
        <div className="empty">
          还没有导入 APK
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
                <td title={apk.fileName}>{apk.label ?? apk.fileName}</td>
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
                      测试
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
        <InstallModal
          apk={pending}
          running={running}
          scope={scope}
          onClose={() => setPending(null)}
          onRecorded={onRecorded}
        />
      )}
    </div>
  );
}

function InstallModal({
  apk,
  running,
  scope,
  onClose,
  onRecorded,
}: {
  apk: ApkMeta;
  running: EmuDevice[];
  scope: Scope;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const [target, setTarget] = useState(running[0]?.serial ?? '');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const selected = running.find((e) => e.serial === target);

  async function run(mode: 'install' | 'install-launch') {
    if (!target) return;
    setBusy(mode);
    setError('');
    const avdName = running.find((e) => e.serial === target)?.avdName ?? '';
    const installRes = await api.install(scope, apk.id, target);
    if (!installRes.ok || !installRes.data.ok) {
      const msg = installRes.ok ? installRes.data.error ?? '安装失败' : installRes.error;
      setError(`${apk.label ?? apk.fileName}：${msg}`);
      await api.recordRun(scope, { avdName, serial: target, apkId: apk.id, result: 'install-failed', note: msg });
      onRecorded();
      setBusy('');
      return;
    }
    if (mode === 'install-launch') {
      const launchRes = await api.launch(scope, apk.id, target);
      if (!launchRes.ok || !launchRes.data.ok) {
        const msg = launchRes.ok ? launchRes.data.error ?? '启动失败' : launchRes.error;
        setError(`${apk.label ?? apk.fileName}：${msg}`);
        await api.recordRun(scope, { avdName, serial: target, apkId: apk.id, result: 'launch-failed', note: msg });
        onRecorded();
        setBusy('');
        return;
      }
    }
    await api.recordRun(scope, { avdName, serial: target, apkId: apk.id, result: 'ok' });
    onRecorded();
    setBusy('');
    onClose();
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 420 }}>
        <div className="modal-head">
          <h3 className="modal-title">安装到设备</h3>
          <button className="modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="install-apk-line">
            <span className="install-apk-name">{apk.label ?? apk.fileName}</span>
            <span className="mono" style={{ color: 'var(--text-2)', fontSize: 11.5 }}>
              {apk.packageName ?? ''} {apk.versionName ? `· ${apk.versionName}` : ''}
            </span>
          </div>
          {running.length === 0 ? (
            <div className="empty" style={{ padding: '18px 0' }}>先启动一台虚拟机</div>
          ) : (
            running.map((e) => (
              <button
                key={e.serial}
                className={`device-option${target === e.serial ? ' on' : ''}`}
                onClick={() => setTarget(e.serial)}
              >
                <span className="dot on" />
                <span className="device-option-name">{e.avdName}</span>
                <span className="mono" style={{ color: 'var(--text-3)', fontSize: 11 }}>
                  {e.serial}
                </span>
              </button>
            ))
          )}
          {error && <div className="error-line" style={{ border: 'none', padding: '4px 0 0' }}>{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn" disabled={!target || busy !== ''} onClick={() => run('install')}>
            {busy === 'install' ? '安装中' : '仅安装'}
          </button>
          <button className="btn btn-primary" disabled={!target || busy !== ''} onClick={() => run('install-launch')}>
            {busy === 'install-launch' ? '测试中' : '安装并启动'}
          </button>
        </div>
      </div>
    </div>
  );
}
