import { useCallback, useEffect, useState } from 'react';
import { api, onHosStartFailed, type EmuDevice, type HosAvd, type Scope } from '../api.ts';
import { sameJson } from '../App.tsx';
import { CrashesPanel } from '../components/CrashesPanel.tsx';
import { DeviceAppsPanel } from '../components/DeviceAppsPanel.tsx';
import { toast } from '../components/Toast.tsx';
import { gbFromMb } from '../components/VmEdit.tsx';
import { hosDeviceLabel } from '../../core/hosLabels.ts';

const SHARED_SCOPE: Scope = { kind: 'shared' };

/** HarmonyOS 虚拟机详情：信息、启动/关闭/删除、应用库与运行记录 */
export function HosDeviceDetail({
  name,
  backLabel,
  emus,
  onBack,
  onRenamed,
}: {
  name: string;
  backLabel?: string;
  emus: EmuDevice[];
  onBack: () => void;
  onRenamed?: (name: string) => void;
}) {
  const [avd, setAvd] = useState<HosAvd | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  // 点击启动的时刻（null=非启动中）；上限按时间戳判定，轮询重置不会让兜底定时器失效
  const [starting, setStarting] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [ram, setRam] = useState('');
  const [cores, setCores] = useState('');
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => {
    api.hosList().then((r) => {
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setError('');
      // 详情对象每轮是主进程新构造的身份：内容相同即跳过，避免 4s 轮询整页重渲染
      const next = r.data.find((a) => a.name === name) ?? null;
      setAvd((cur) => (sameJson(cur, next) ? cur : next));
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

  // 启动失败主进程只广播不回传：不订阅则"启动中"要挂到超时兜底才消失
  useEffect(
    () =>
      onHosStartFailed(({ name: failed, error: msg }) => {
        if (failed !== name) return;
        setStarting(null);
        setError(`${name} 启动失败：${msg}`);
        toast(`${name} 启动失败`);
      }),
    [name],
  );

  async function acceptLicense(): Promise<boolean> {
    if (!window.confirm('启动 HarmonyOS 模拟器需先接受华为软件服务协议。确认接受并继续？')) return false;
    const r = await api.hosAcceptLicense();
    if (!r.ok) {
      setError(r.error);
      return false;
    }
    return true;
  }

  async function start(target: string) {
    setBusy('launch');
    setError('');
    setStarting(Date.now());
    let r = await api.hosStart(target);
    if (r.ok && r.data.needLicense && !(await acceptLicense())) {
      setStarting(null);
      setBusy('');
      return;
    }
    if (r.ok && r.data.needLicense) r = await api.hosStart(target);
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

  function startEdit() {
    setNameDraft(name);
    setRam(avd?.ramMb ? gbFromMb(avd.ramMb) : '');
    setCores(avd?.cpuCores ? String(avd.cpuCores) : '');
    setEditing(true);
  }

  async function saveEdit() {
    setError('');
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setError('名称不能为空');
      return;
    }
    if (trimmed !== name && running) {
      setError('请先关闭虚拟机再重命名');
      return;
    }

    const ramGb = ram ? Number(ram) : NaN;
    if (ram && (!Number.isInteger(ramGb) || ramGb < 2 || ramGb > 32)) {
      setError('内存需为 2–32 GB 的整数');
      return;
    }
    const coresN = cores ? Number(cores) : NaN;
    if (cores && (!Number.isInteger(coresN) || coresN < 1 || coresN > 16)) {
      setError('CPU 核数需为 1–16 的整数');
      return;
    }
    const next = {
      ramMb: ram ? Math.round(ramGb * 1024) : undefined,
      cores: cores ? coresN : undefined,
    };
    // 清空的输入框视为"保持现状"：undefined 混入比较会误判 changed，
    // 导致运行中的虚拟机被确认重启后又被主进程拒为参数错误
    const changed =
      (next.ramMb !== undefined && next.ramMb !== avd?.ramMb) ||
      (next.cores !== undefined && next.cores !== avd?.cpuCores);
    if (trimmed === name && !changed) {
      setEditing(false);
      return;
    }
    const restart = running && changed;
    if (restart && !window.confirm('修改硬件配置需要重启虚拟机才能生效，是否立即重启？')) return;

    setSaving(true);
    if (restart) {
      const sr = await api.hosStop(name);
      if (!sr.ok) {
        setError(sr.error);
        setSaving(false);
        return;
      }
    }

    let current = name;
    if (trimmed !== name) {
      const rr = await api.hosRename(name, trimmed);
      if (!rr.ok) {
        setError(rr.error);
        setSaving(false);
        if (restart) start(name);
        return;
      }
      current = trimmed;
      onRenamed?.(trimmed);
    }

    if (changed) {
      const r = await api.hosSetHardware(current, next);
      if (!r.ok) {
        setError(r.error);
        setSaving(false);
        if (restart) start(current);
        return;
      }
    }

    setSaving(false);
    setEditing(false);
    if (trimmed === name) reload();
    if (restart) start(current);
  }

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
              onClick={() => start(name)}
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
                      maxLength={64}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveEdit();
                        if (e.key === 'Escape') setEditing(false);
                      }}
                    />
                  ) : (
                    <span className="mono">{name}</span>
                  )}
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
                  {running && (
                    <span className="mono" style={{ color: 'var(--text-3)', marginLeft: 10 }}>
                      {name}
                    </span>
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
                  {editing ? (
                    <div className="cell-input-row">
                      <input
                        className="cell-input"
                        value={ram}
                        onChange={(e) => setRam(e.target.value.replace(/[^\d]/g, ''))}
                        inputMode="numeric"
                      />
                      <span className="cell-unit">GB</span>
                    </div>
                  ) : (
                    <span className="num">{avd?.ramMb ? `${gbFromMb(avd.ramMb)} GB` : '—'}</span>
                  )}
                </td>
              </tr>
              <tr>
                <th>CPU 核数</th>
                <td>
                  {editing ? (
                    <div className="cell-input-row">
                      <input
                        className="cell-input"
                        value={cores}
                        onChange={(e) => setCores(e.target.value.replace(/[^\d]/g, ''))}
                        inputMode="numeric"
                      />
                      <span className="cell-unit">核</span>
                    </div>
                  ) : (
                    <span className="num">{avd?.cpuCores ? `${avd.cpuCores} 核` : '—'}</span>
                  )}
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

        <DeviceAppsPanel
          scope={SHARED_SCOPE}
          os="harmonyos"
          running={running}
          emus={emus}
        />
      </div>
      <div style={{ marginTop: 16 }}>
        <CrashesPanel scope={SHARED_SCOPE} os="hos" device={name} />
      </div>
      {error && (
        <div className="error-line" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}
