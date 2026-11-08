import { useCallback, useEffect, useState } from 'react';
import { api, type EmuDevice, type HosAvd, type Scope } from '../api.ts';
import { ApkPanel } from '../components/ApkPanel.tsx';
import { RunsPanel } from '../components/RunsPanel.tsx';
import { gbFromMb } from '../components/VmEdit.tsx';
import { hosDeviceLabel } from '../../core/hosLabels.ts';

const SHARED_SCOPE: Scope = { kind: 'shared' };

/** HarmonyOS 虚拟机详情：信息、启动/关闭/删除、应用库与运行记录 */
export function HosDeviceDetail({
  name,
  backLabel,
  emus,
  onBack,
}: {
  name: string;
  backLabel?: string;
  emus: EmuDevice[];
  onBack: () => void;
}) {
  const [avd, setAvd] = useState<HosAvd | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  // 点击启动的时刻（null=非启动中）；上限按时间戳判定，轮询重置不会让兜底定时器失效
  const [starting, setStarting] = useState<number | null>(null);
  const [runsKey, setRunsKey] = useState(0);

  const reload = useCallback(() => {
    api.hosList().then((r) => {
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setAvd(r.data.find((a) => a.name === name) ?? null);
    });
  }, [name]);

  useEffect(() => {
    reload();
    const timer = setInterval(reload, 4_000);
    return () => clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    if (starting === null) return;
    if (avd?.running || Date.now() - starting > 320_000) setStarting(null);
  }, [avd, starting]);

  async function acceptLicense(): Promise<boolean> {
    if (!window.confirm('启动 HarmonyOS 模拟器需先接受华为软件服务协议。确认接受并继续？')) return false;
    const r = await api.hosAcceptLicense();
    if (!r.ok) {
      setError(r.error);
      return false;
    }
    return true;
  }

  async function launch() {
    setBusy('launch');
    setError('');
    setStarting(Date.now());
    let r = await api.hosStart(name);
    if (r.ok && r.data.needLicense && !(await acceptLicense())) {
      setStarting(null);
      setBusy('');
      return;
    }
    if (r.ok && r.data.needLicense) r = await api.hosStart(name);
    if (!r.ok) {
      setError(r.error);
      setStarting(null);
    }
    setBusy('');
  }

  async function stop() {
    setBusy('stop');
    setError('');
    const r = await api.hosStop(name);
    if (!r.ok) setError(r.error);
    setTimeout(reload, 1_500);
    setBusy('');
  }

  async function remove() {
    if (!window.confirm(`删除虚拟机 ${name}？该操作不可恢复。`)) return;
    setBusy('remove');
    setError('');
    const r = await api.hosDelete(name);
    if (!r.ok) {
      setError(r.error);
      setBusy('');
      return;
    }
    onBack();
  }

  const running = avd?.running ?? false;

  return (
    <div>
      <button className="back-link" onClick={onBack}>
        ← {backLabel ?? '返回'}
      </button>
      <div className="page-head">
        <h1 className="page-title mono">{name}</h1>
        <div className="page-actions">
          {running ? (
            <button className="btn btn-danger" disabled={busy !== ''} onClick={stop}>
              {busy === 'stop' ? '关闭中' : '关闭'}
            </button>
          ) : (
            <button
              className="btn btn-primary"
              disabled={busy !== '' || starting !== null}
              onClick={launch}
            >
              {starting !== null ? '启动中' : '启动'}
            </button>
          )}
          <button
            className="btn btn-danger"
            disabled={busy !== '' || running}
            title={running ? '先关闭再删除' : ''}
            onClick={remove}
          >
            删除
          </button>
        </div>
      </div>
      <div className="device-detail-grid">
        <div className="section" style={{ marginBottom: 0 }}>
          <div className="section-head">
            <h2 className="section-title">设备信息</h2>
          </div>
          <table className="tbl">
            <tbody>
              <tr>
                <th style={{ width: 110 }}>设备名称</th>
                <td>
                  <span className="mono">{name}</span>
                </td>
              </tr>
              <tr>
                <th>状态</th>
                <td>
                  {starting !== null ? (
                    <span className="chip warn">启动中</span>
                  ) : running ? (
                    <span className="chip ok">运行中</span>
                  ) : (
                    <span className="chip idle">已停止</span>
                  )}
                </td>
              </tr>
              <tr>
                <th>系统</th>
                <td>{avd?.osVersion || '—'}</td>
              </tr>
              <tr>
                <th>型号</th>
                <td>{avd ? (avd.productModel ?? hosDeviceLabel(avd.deviceType)) : '—'}</td>
              </tr>
              <tr>
                <th>内存</th>
                <td>
                  <span className="num">{avd?.ramMb ? `${gbFromMb(avd.ramMb)} GB` : '—'}</span>
                </td>
              </tr>
              <tr>
                <th>CPU 核数</th>
                <td>
                  <span className="num">{avd?.cpuCores ? `${avd.cpuCores} 核` : '—'}</span>
                </td>
              </tr>
              <tr>
                <th>硬盘容量</th>
                <td>
                  <span className="num">{avd?.storageMb ? `${gbFromMb(avd.storageMb)} GB` : '—'}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <ApkPanel scope={SHARED_SCOPE} emus={emus} onRecorded={() => setRunsKey((k) => k + 1)} />
      </div>
      <div style={{ marginTop: 16 }}>
        <RunsPanel scope={SHARED_SCOPE} refreshKey={runsKey} />
      </div>
      {error && (
        <div className="error-line" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}
