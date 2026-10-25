import { useCallback, useEffect, useState } from 'react';
import { api, osFromImagePkg, prettyModel, type EmuDevice, type Scope } from '../api.ts';
import { RunsPanel } from '../components/RunsPanel.tsx';
import { fmtTime } from '../components/Modal.tsx';
import type { ApkMeta, AvdInfo } from '../../core/types.ts';

export function DeviceDetail({
  avdName,
  scope,
  emus,
  refreshEmus,
  onBack,
  backLabel,
  onRenamed,
}: {
  avdName: string;
  scope: Scope;
  emus: EmuDevice[];
  refreshEmus: () => void;
  onBack: () => void;
  backLabel?: string;
  onRenamed?: (name: string) => void;
}) {
  const [avd, setAvd] = useState<AvdInfo | null>(null);
  const [hw, setHw] = useState<{ ramMb?: number; cores?: number; storageGb?: number } | null>(null);
  const [apps, setApps] = useState<ApkMeta[] | null>(null);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [runsKey, setRunsKey] = useState(0);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [ram, setRam] = useState('');
  const [cores, setCores] = useState('');
  const [storage, setStorage] = useState('');
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [apkBusy, setApkBusy] = useState('');

  const reload = useCallback(() => {
    api.listAvds(scope).then((r) => {
      if (r.ok) setAvd(r.data.find((a) => a.name === avdName) ?? null);
      else setError(r.error);
    });
    api.avdHardware(scope, avdName).then((r) => {
      if (r.ok) setHw(r.data);
    });
    api.listApps(scope).then((r) => {
      if (r.ok) setApps(r.data);
    });
  }, [avdName, scope]);

  useEffect(reload, [reload]);

  const run = emus.find((e) => e.state === 'device' && e.avdName === avdName);

  useEffect(() => {
    if (!starting) return;
    if (run) setStarting(false);
    const t = setTimeout(() => setStarting(false), 240_000);
    return () => clearTimeout(t);
  }, [run, starting]);

  async function launch() {
    setBusy('launch');
    setError('');
    setStarting(true);
    const r = await api.launchEmu(scope, avdName);
    if (!r.ok) {
      setError(r.error);
      setStarting(false);
    }
    refreshEmus();
    setBusy('');
  }

  async function stop() {
    setBusy('stop');
    setError('');
    const r = await api.stopEmu(scope, avdName);
    if (!r.ok) setError(r.error);
    setTimeout(refreshEmus, 1500);
    setBusy('');
  }

  async function remove() {
    if (!window.confirm(`删除虚拟机 ${avdName}？该操作不可恢复。`)) return;
    setBusy('remove');
    setError('');
    const r = await api.deleteAvd(scope, avdName);
    if (!r.ok || !r.data.ok) {
      setError(r.ok ? r.data.error ?? '删除失败' : r.error);
      setBusy('');
      return;
    }
    onBack();
  }

  function startEdit() {
    setNameDraft(avdName);
    setRam(hw?.ramMb ? String(hw.ramMb) : '');
    setCores(hw?.cores ? String(hw.cores) : '');
    setStorage(hw?.storageGb ? String(Math.round(hw.storageGb)) : '');
    setEditing(true);
  }

  async function saveEdit() {
    setSaving(true);
    setError('');
    const trimmed = nameDraft.trim();
    if (trimmed !== avdName) {
      if (!trimmed) {
        setError('名称不能为空');
        setSaving(false);
        return;
      }
      if (run) {
        setError('请先关闭虚拟机再重命名');
        setSaving(false);
        return;
      }
      const rr = await api.renameAvd(scope, avdName, trimmed);
      if (!rr.ok || !rr.data.ok) {
        setError(rr.ok ? rr.data.error ?? '重命名失败' : rr.error);
        setSaving(false);
        return;
      }
      onRenamed?.(trimmed);
    }
    const r = await api.setAvdHardware(scope, trimmed, {
      ramMb: ram ? Number(ram) : undefined,
      cores: cores ? Number(cores) : undefined,
      storageGb: storage ? Number(storage) : undefined,
    });
    setSaving(false);
    if (!r.ok || !r.data.ok) {
      setError(r.ok ? r.data.error ?? '保存失败' : r.error);
      return;
    }
    setEditing(false);
    reload();
  }

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

  async function apkAction(apk: ApkMeta, action: 'update' | 'remove') {
    setApkBusy(apk.id);
    setError('');
    if (action === 'update') {
      const r = await api.install(scope, apk.id, run!.serial);
      if (!r.ok || !r.data.ok) setError(r.ok ? r.data.error ?? '更新失败' : r.error);
      setApkBusy('');
      return;
    }
    const r = await api.removeApk(scope, apk.id);
    if (!r.ok) setError(r.error);
    reload();
    setApkBusy('');
  }

  return (
    <div>
      <button className="back-link" onClick={onBack}>
        ← {backLabel ?? '返回'}
      </button>
      <div className="page-head">
        <h1 className="page-title mono">{avdName}</h1>
        <div className="page-actions">
          {run ? (
            <button className="btn btn-danger" disabled={busy !== ''} onClick={stop}>
              {busy === 'stop' ? '关闭中' : '关闭'}
            </button>
          ) : (
            <button className="btn btn-primary" disabled={busy !== '' || starting} onClick={launch}>
              {starting ? '启动中' : '启动'}
            </button>
          )}
          <button className="btn btn-danger" disabled={busy !== '' || !!run} title={run ? '先关闭再删除' : ''} onClick={remove}>
            删除
          </button>
        </div>
      </div>
      <div className="device-detail-grid">
        <div className="section" style={{ marginBottom: 0 }}>
          <div className="section-head">
            <h2 className="section-title">设备信息</h2>
            <div className="section-actions">
              {editing ? (
                <>
                  <button className="btn btn-sm" disabled={saving} onClick={() => setEditing(false)}>
                    取消
                  </button>
                  <button className="btn btn-sm btn-primary" disabled={saving} onClick={saveEdit}>
                    {saving ? '保存中' : '保存'}
                  </button>
                </>
              ) : (
                <button className="btn btn-sm" onClick={startEdit}>
                  编辑
                </button>
              )}
            </div>
          </div>
          <table className="tbl">
            <tbody>
              <tr>
                <th style={{ width: 110 }}>设备名称</th>
                <td>
                  {editing ? (
                    <input
                      className="cell-input"
                      style={{ width: 180 }}
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value.replace(/[^\w.-]/g, ''))}
                    />
                  ) : (
                    <span className="mono">{avdName}</span>
                  )}
                </td>
              </tr>
              <tr>
                <th>状态</th>
                <td>
                  <span className={`dot${starting ? ' starting' : run ? ' on' : ''}`} />
                  {starting ? '启动中' : run ? '运行中' : '已停止'}
                  {run && (
                    <span className="mono" style={{ color: 'var(--text-3)', marginLeft: 10 }}>
                      {run.serial}
                    </span>
                  )}
                </td>
              </tr>
              <tr>
                <th>系统</th>
                <td>{avd ? osFromImagePkg(avd.imagePkg) : '—'}</td>
              </tr>
              <tr>
                <th>型号</th>
                <td>{avd ? prettyModel(avd.deviceName) : '—'}</td>
              </tr>
              <tr>
                <th>内存</th>
                <td>
                  {editing ? (
                    <input className="cell-input" value={ram} onChange={(e) => setRam(e.target.value.replace(/[^\d]/g, ''))} placeholder="MB" />
                  ) : (
                    <span className="num">{hw?.ramMb ? `${hw.ramMb} MB` : '—'}</span>
                  )}
                </td>
              </tr>
              <tr>
                <th>CPU 核数</th>
                <td>
                  {editing ? (
                    <input className="cell-input" value={cores} onChange={(e) => setCores(e.target.value.replace(/[^\d]/g, ''))} />
                  ) : (
                    <span className="num">{hw?.cores ?? '—'}</span>
                  )}
                </td>
              </tr>
              <tr>
                <th>数据分区</th>
                <td>
                  {editing ? (
                    <input className="cell-input" value={storage} onChange={(e) => setStorage(e.target.value.replace(/[^\d]/g, ''))} placeholder="GB" />
                  ) : (
                    <span className="num">{hw?.storageGb ? `${hw.storageGb} GB` : '—'}</span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="section" style={{ marginBottom: 0 }}>
          <div className="section-head">
            <h2 className="section-title">测试的应用</h2>
            <div className="section-actions">
              <button className="btn" onClick={doImport} disabled={importing}>
                {importing ? '导入中' : '导入'}
              </button>
            </div>
          </div>
          {apps === null ? (
            <div className="empty">
              <span className="spinner" />
            </div>
          ) : apps.length === 0 ? (
            <div className="empty">暂无应用</div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 44 }}>编号</th>
                  <th>应用名称</th>
                  <th style={{ width: 70 }}>版本号</th>
                  <th style={{ width: 90 }}>导入时间</th>
                  <th style={{ width: 130 }}></th>
                </tr>
              </thead>
              <tbody>
                {apps.map((apk, i) => (
                  <tr key={apk.id}>
                    <td className="num">{i + 1}</td>
                    <td title={apk.packageName ?? apk.fileName}>{apk.label ?? apk.fileName}</td>
                    <td className="num">{apk.versionName ?? '—'}</td>
                    <td className="num">{fmtTime(apk.importedAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="btn btn-sm"
                          disabled={!run || apkBusy !== ''}
                          title={run ? '安装到设备（覆盖更新）' : '先启动设备'}
                          onClick={() => apkAction(apk, 'update')}
                        >
                          {apkBusy === apk.id ? '更新中' : '更新'}
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={apkBusy !== ''}
                          onClick={() => {
                            if (window.confirm(`从库中移除 ${apk.fileName}？`)) apkAction(apk, 'remove');
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <div style={{ marginTop: 16 }}>
        <RunsPanel scope={scope} refreshKey={runsKey} />
      </div>
      {error && <div className="error-line" style={{ marginTop: 12 }}>{error}</div>}
    </div>
  );
}
