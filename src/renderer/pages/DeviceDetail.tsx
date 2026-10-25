import { useCallback, useEffect, useState } from 'react';
import { api, osFromImagePkg, prettyModel, type EmuDevice } from '../api.ts';
import { EditVmModal } from '../components/VmEdit.tsx';
import { RunsPanel } from '../components/RunsPanel.tsx';
import type { AvdInfo } from '../../core/types.ts';

export function DeviceDetail({
  avdName,
  emus,
  refreshEmus,
  onBack,
}: {
  avdName: string;
  emus: EmuDevice[];
  refreshEmus: () => void;
  onBack: () => void;
}) {
  const scope = { kind: 'shared' as const };
  const [avd, setAvd] = useState<AvdInfo | null>(null);
  const [hw, setHw] = useState<{ ramMb?: number; cores?: number; storageGb?: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(() => {
    api.listAvds(scope).then((r) => {
      if (r.ok) setAvd(r.data.find((a) => a.name === avdName) ?? null);
      else setError(r.error);
    });
    api.avdHardware(scope, avdName).then((r) => {
      if (r.ok) setHw(r.data);
    });
  }, [avdName]);

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

  return (
    <div>
      <button className="back-link" onClick={onBack}>
        ← 返回设备池
      </button>
      <div className="page-head">
        <h1 className="page-title mono">{avdName}</h1>
      </div>
      <div className="device-detail-grid">
        <div className="section" style={{ marginBottom: 0 }}>
          <div className="section-head">
            <h2 className="section-title">设备信息</h2>
          </div>
          <table className="tbl">
            <tbody>
              <tr>
                <th style={{ width: 110 }}>状态</th>
                <td>
                  <span className={`dot${starting ? ' starting' : run ? ' on' : ''}`} />
                  {starting ? '启动中' : run ? '运行中' : '已停止'}
                  {run && <span className="mono" style={{ color: 'var(--text-3)', marginLeft: 10 }}>{run.serial}</span>}
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
                <td className="num">{hw?.ramMb ? `${hw.ramMb} MB` : '—'}</td>
              </tr>
              <tr>
                <th>CPU 核数</th>
                <td className="num">{hw?.cores ?? '—'}</td>
              </tr>
              <tr>
                <th>数据分区</th>
                <td className="num">{hw?.storageGb ? `${hw.storageGb} GB` : '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="section" style={{ marginBottom: 0 }}>
          <div className="section-head">
            <h2 className="section-title">基本操作</h2>
          </div>
          <div className="device-ops">
            {run ? (
              <button className="btn btn-danger" disabled={busy !== ''} onClick={stop}>
                {busy === 'stop' ? '关闭中' : '关闭（强制）'}
              </button>
            ) : (
              <button className="btn btn-primary" disabled={busy !== '' || starting} onClick={launch}>
                {starting ? '启动中' : '启动'}
              </button>
            )}
            <button className="btn" disabled={busy !== '' || !!run || starting} onClick={() => setEditing(true)}>
              配置
            </button>
            <button className="btn btn-danger" disabled={busy !== '' || !!run} title={run ? '先关闭再删除' : ''} onClick={remove}>
              删除
            </button>
            {error && <div className="error-line" style={{ border: 'none', padding: '6px 0 0' }}>{error}</div>}
          </div>
        </div>
      </div>
      <div style={{ marginTop: 16 }}>
        <RunsPanel scope={scope} refreshKey={0} />
      </div>
      {editing && (
        <EditVmModal
          scope={scope}
          avdName={avdName}
          onDone={() => {
            setEditing(false);
            reload();
          }}
        />
      )}
    </div>
  );
}
