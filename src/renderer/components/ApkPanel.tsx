import { useCallback, useEffect, useState } from 'react';
import { api, type EmuDevice, type Scope } from '../api.ts';
import { fmtSize } from './Modal.tsx';
import type { ApkMeta } from '../../core/types.ts';

type Device = { type: 'android' | 'harmonyos'; serial: string; label: string };

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
          emus={emus}
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
  emus,
  scope,
  onClose,
  onRecorded,
}: {
  apk: ApkMeta;
  emus: EmuDevice[];
  scope: Scope;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  // Android 运行中的虚拟机 + HarmonyOS 在线设备，按包类型过滤
  useEffect(() => {
    const android: Device[] = emus
      .filter((e) => e.state === 'device' && e.avdName)
      .map((e) => ({ type: 'android' as const, serial: e.serial, label: e.avdName! }));
    const needHarmony = apk.kind === 'hap' || android.length === 0;
    if (!needHarmony) {
      setDevices(android);
      setTarget(android[0]?.serial ?? '');
      return;
    }
    setDevices(android);
    setTarget(android[0]?.serial ?? '');
    void api.harmonyTargets().then((r) => {
      const harmony: Device[] = (r.ok ? r.data : []).map((t) => ({ type: 'harmonyos' as const, serial: t, label: t }));
      setDevices((cur) => [...(cur ?? []), ...harmony]);
    });
  }, [apk, emus]);

  const usable = (devices ?? []).filter((d) => (apk.kind === 'hap' ? d.type === 'harmonyos' : d.type === 'android'));
  const selected = usable.find((e) => e.serial === target);

  useEffect(() => {
    if (!target && usable.length > 0) setTarget(usable[0]!.serial);
  }, [target, usable]);

  async function run(mode: 'install' | 'install-launch') {
    if (!selected) return;
    setBusy(mode);
    setError('');
    const installRes = await api.install(scope, apk.id, selected.serial);
    if (!installRes.ok || !installRes.data.ok) {
      const msg = installRes.ok ? installRes.data.error ?? '安装失败' : installRes.error;
      setError(`${apk.label ?? apk.fileName}：${msg}`);
      await api.recordRun(scope, { avdName: selected.label, serial: selected.serial, apkId: apk.id, result: 'install-failed', note: msg });
      onRecorded();
      setBusy('');
      return;
    }
    if (mode === 'install-launch') {
      const launchRes = await api.launch(scope, apk.id, selected.serial);
      if (!launchRes.ok || !launchRes.data.ok) {
        const msg = launchRes.ok ? launchRes.data.error ?? '启动失败' : launchRes.error;
        setError(`${apk.label ?? apk.fileName}：${msg}`);
        await api.recordRun(scope, { avdName: selected.label, serial: selected.serial, apkId: apk.id, result: 'launch-failed', note: msg });
        onRecorded();
        setBusy('');
        return;
      }
    }
    await api.recordRun(scope, { avdName: selected.label, serial: selected.serial, apkId: apk.id, result: 'ok' });
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
            <span className="chip" style={{ marginRight: 7 }}>{apk.kind === 'hap' ? 'HAP' : 'APK'}</span>
            <span className="install-apk-name">{apk.label ?? apk.fileName}</span>
            <span className="mono" style={{ color: 'var(--text-2)', fontSize: 11.5 }}>
              {apk.packageName ?? ''} {apk.versionName ? `· ${apk.versionName}` : ''}
            </span>
          </div>
          {devices === null ? (
            <div className="empty" style={{ padding: '18px 0' }}>
              <span className="spinner" />
            </div>
          ) : usable.length === 0 ? (
            <div className="empty" style={{ padding: '18px 0' }}>
              {apk.kind === 'hap' ? '没有 HarmonyOS 在线设备' : '先启动一台虚拟机'}
            </div>
          ) : (
            usable.map((e) => (
              <button
                key={e.serial}
                className={`device-option${target === e.serial ? ' on' : ''}`}
                onClick={() => setTarget(e.serial)}
              >
                <span className={`dot${e.type === 'android' ? ' on' : ' hm'}`} />
                <span className="device-option-name">{e.label}</span>
                <span className="chip" style={{ marginRight: 0 }}>{e.type === 'android' ? 'Android' : 'HarmonyOS'}</span>
                <span className="mono" style={{ color: 'var(--text-3)', fontSize: 11, marginLeft: 7 }}>
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
          <button className="btn" disabled={!selected || busy !== ''} onClick={() => run('install')}>
            {busy === 'install' ? '安装中' : '仅安装'}
          </button>
          <button className="btn btn-primary" disabled={!selected || busy !== ''} onClick={() => run('install-launch')}>
            {busy === 'install-launch' ? '测试中' : '安装并启动'}
          </button>
        </div>
      </div>
    </div>
  );
}
