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
  const [target, setTarget] = useState('');
  const [busyId, setBusyId] = useState('');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');

  const running = emus.filter((e) => e.state === 'device' && e.avdName);

  useEffect(() => {
    if (running.length === 0) {
      setTarget('');
    } else if (!running.some((e) => e.serial === target)) {
      setTarget(running[0]!.serial);
    }
  }, [emus]);

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
      reload();
    }
    setImporting(false);
  }

  async function runTest(apk: ApkMeta) {
    if (!target) return;
    setBusyId(apk.id);
    setError('');
    const installRes = await api.install(scope, apk.id, target);
    if (!installRes.ok || !installRes.data.ok) {
      const msg = installRes.ok ? installRes.data.error ?? '安装失败' : installRes.error;
      setError(`${apk.label ?? apk.fileName}：${msg}`);
      await api.recordRun(scope, {
        avdName: running.find((e) => e.serial === target)?.avdName ?? '',
        serial: target,
        apkId: apk.id,
        result: 'install-failed',
        note: msg,
      });
      onRecorded();
      setBusyId('');
      return;
    }
    const launchRes = await api.launch(scope, apk.id, target);
    if (!launchRes.ok || !launchRes.data.ok) {
      const msg = launchRes.ok ? launchRes.data.error ?? '启动失败' : launchRes.error;
      setError(`${apk.label ?? apk.fileName}：${msg}`);
      await api.recordRun(scope, {
        avdName: running.find((e) => e.serial === target)?.avdName ?? '',
        serial: target,
        apkId: apk.id,
        result: 'launch-failed',
        note: msg,
      });
      onRecorded();
      setBusyId('');
      return;
    }
    await api.recordRun(scope, {
      avdName: running.find((e) => e.serial === target)?.avdName ?? '',
      serial: target,
      apkId: apk.id,
      result: 'ok',
    });
    onRecorded();
    setBusyId('');
  }

  async function simpleAction(apk: ApkMeta, action: 'clearData' | 'uninstall') {
    if (!target) return;
    setBusyId(apk.id);
    setError('');
    const r = await api[action](scope, apk.id, target);
    if (!r.ok) setError(r.error);
    setBusyId('');
  }

  async function remove(apk: ApkMeta) {
    if (!window.confirm(`从库中移除 ${apk.fileName}？不影响已安装到设备的应用。`)) return;
    setBusyId(apk.id);
    const r = await api.removeApk(scope, apk.id);
    if (!r.ok) setError(r.error);
    reload();
    setBusyId('');
  }

  return (
    <div className="section">
      <div className="section-head">
        <h2 className="section-title">APK 库</h2>
        {apps && <span className="section-count">{apps.length}</span>}
        <div className="section-actions">
          {running.length > 0 ? (
            <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ width: 160 }}>
              {running.map((e) => (
                <option key={e.serial} value={e.serial}>
                  {e.avdName}（{e.serial}）
                </option>
              ))}
            </select>
          ) : (
            <span className="form-hint" style={{ marginTop: 0 }}>
              先启动一台虚拟机
            </span>
          )}
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
              <th style={{ width: 230 }}></th>
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
                      disabled={!target || busyId === apk.id}
                      title={target ? '安装并启动，记录一次测试' : '先启动一台虚拟机'}
                      onClick={() => runTest(apk)}
                    >
                      {busyId === apk.id ? '测试中' : '测试'}
                    </button>
                    <button
                      className="btn btn-sm"
                      disabled={!target || busyId === apk.id}
                      onClick={() => simpleAction(apk, 'clearData')}
                    >
                      清数据
                    </button>
                    <button
                      className="btn btn-sm"
                      disabled={!target || busyId === apk.id}
                      onClick={() => simpleAction(apk, 'uninstall')}
                    >
                      卸载
                    </button>
                    <button className="btn btn-sm btn-danger" disabled={busyId === apk.id} onClick={() => remove(apk)}>
                      移除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && <div className="error-line">{error}</div>}
    </div>
  );
}
