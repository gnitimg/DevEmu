import { useCallback, useEffect, useState } from 'react';
import { api, osFromImagePkg, prettyModel, scopeKeyOf, type EmuDevice, type Scope } from '../api.ts';
import { CrashesPanel } from '../components/CrashesPanel.tsx';
import { DeviceAppsPanel } from '../components/DeviceAppsPanel.tsx';
import { decimalInput, gbFromMb } from '../components/VmEdit.tsx';
import { displayedStorageGb } from '../../core/storageUnits.ts';
import type { AvdInfo } from '../../core/types.ts';

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
  // 点击启动的时刻（null=非启动中）；上限按时间戳判定，定时器会被轮询重置而永不触发
  const [starting, setStarting] = useState<number | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [ram, setRam] = useState('');
  const [cores, setCores] = useState('');
  const [storage, setStorage] = useState('');
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => {
    api.listAvds(scope).then((r) => {
      if (r.ok) {
        setError('');
        setAvd(r.data.find((a) => a.name === avdName) ?? null);
      } else setError(r.error);
    });
    api.avdHardware(scope, avdName).then((r) => {
      if (r.ok) setHw(r.data);
    });
  }, [avdName, scope]);

  useEffect(reload, [reload]);

  // offline 也是 qemu 在跑（adb 通道抖动）：按"运行中"处理，与 VmPanel 同口径。
  // 同名虚拟机可存在于不同作用域，必须按 scopeKey 认领，否则会把别的
  // 作用域实例当成这台，更新 APK 就会装错设备
  const run = emus.find(
    (e) =>
      e.serial.startsWith('emulator-') &&
      e.avdName === avdName &&
      e.scopeKey === scopeKeyOf(scope),
  );

  // 启动中：设备上线或超时（与主进程 waitBooted 300s 对齐留缓冲）后清除。
  // 用定时器而不是靠重渲染判定：设备列表快照不变时不会重渲染，超时检查会永不执行
  useEffect(() => {
    if (starting === null) return;
    if (run) {
      setStarting(null);
      return;
    }
    const left = starting + 320_000 - Date.now();
    const t = setTimeout(() => setStarting(null), Math.max(0, left));
    return () => clearTimeout(t);
  }, [run, starting]);

  async function launch() {
    setBusy('launch');
    setError('');
    setStarting(Date.now());
    const r = await api.launchEmu(scope, avdName);
    if (!r.ok) {
      setError(r.error);
      setStarting(null);
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
    setRam(hw?.ramMb ? gbFromMb(hw.ramMb) : '');
    setCores(hw?.cores ? String(hw.cores) : '');
    setStorage(hw?.storageGb ? String(Math.round(hw.storageGb)) : '');
    setEditing(true);
  }

  function relaunch(name: string) {
    setStarting(Date.now());
    void api.launchEmu(scope, name).then((r) => {
      if (!r.ok) {
        setError(`重启失败：${r.error}`);
        setStarting(null);
      }
      refreshEmus();
    });
  }

  async function saveEdit() {
    setError('');
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setError('名称不能为空');
      return;
    }
    if (trimmed !== avdName && run) {
      setError('请先关闭虚拟机再重命名');
      return;
    }

    const ramGb = ram ? Number(ram) : NaN;
    const next = {
      ramMb: Number.isFinite(ramGb) && ramGb > 0 ? Math.round(ramGb * 1024) : undefined,
      cores: cores ? Number(cores) : undefined,
      storageGb: storage ? Number(storage) : undefined,
    };
    const currentStorage = hw?.storageGb !== undefined ? Math.round(hw.storageGb) : undefined;
    // 清空的输入框视为"保持现状"：undefined 混入比较会误判 changed 导致白重启
    const changed =
      (next.ramMb !== undefined && next.ramMb !== hw?.ramMb) ||
      (next.cores !== undefined && next.cores !== hw?.cores) ||
      (next.storageGb !== undefined && next.storageGb !== currentStorage);
    if (trimmed === avdName && !changed) {
      setEditing(false);
      return;
    }
    // 开机时改配置必须先停机；缩小数据分区会截断镜像里的已用数据，任何状态都只允许扩容
    if (next.storageGb !== undefined && currentStorage !== undefined && next.storageGb < currentStorage) {
      setError(`硬盘容量只能扩容（当前 ${currentStorage} GB）`);
      return;
    }
    const restart = !!run && changed;
    const grow = next.storageGb !== undefined && currentStorage !== undefined && next.storageGb > currentStorage;
    const confirmText = grow
      ? '扩容可能需要重建数据分区；修改硬件配置需要重启虚拟机才能生效，是否继续？'
      : '修改硬件配置需要重启虚拟机才能生效，是否立即重启？';
    if (restart && !window.confirm(confirmText)) return;

    setSaving(true);
    if (restart) {
      const sr = await api.stopEmu(scope, avdName);
      if (!sr.ok) {
        setError(sr.error);
        setSaving(false);
        return;
      }
      refreshEmus();
    }

    if (trimmed !== avdName) {
      const rr = await api.renameAvd(scope, avdName, trimmed);
      if (!rr.ok || !rr.data.ok) {
        setError(rr.ok ? rr.data.error ?? '重命名失败' : rr.error);
        setSaving(false);
        if (restart) relaunch(avdName);
        return;
      }
      onRenamed?.(trimmed);
    }

    let r = await api.setAvdHardware(scope, trimmed, next);
    if (!r.ok && r.needsWipe) {
      const approve = window.confirm(
        `该虚拟机镜像的数据分区已加密，无法在不丢失数据的前提下扩容。继续将清空虚拟机内的全部数据，并按 ${next.storageGb} GB 重建，是否继续？`,
      );
      if (!approve) {
        setSaving(false);
        if (restart) relaunch(trimmed);
        return;
      }
      r = await api.setAvdHardware(scope, trimmed, next, { wipeData: true });
    }
    setSaving(false);
    if (!r.ok || !r.data.ok) {
      setError(r.ok ? r.data.error ?? '保存失败' : r.error);
      if (restart) relaunch(trimmed);
      return;
    }
    setEditing(false);
    reload();
    if (restart) relaunch(trimmed);
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
                    <button className="btn btn-primary" disabled={busy !== '' || starting !== null} onClick={launch}>
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
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveEdit();
                        if (e.key === 'Escape') setEditing(false);
                      }}
                    />
                  ) : (
                    <span className="mono">{avdName}</span>
                  )}
                </td>
              </tr>
              <tr>
                <th>状态</th>
                <td>
                  {starting ? (
                    <span className="chip warn">启动中</span>
                  ) : run ? (
                    <span className="chip ok">运行中</span>
                  ) : (
                    <span className="chip idle">已停止</span>
                  )}
                  {run && (
                    <span className="mono" style={{ color: 'var(--text-3)', marginLeft: 10 }}>
                      {avdName}
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
                    <div className="cell-input-row">
                      <input className="cell-input" value={ram} onChange={(e) => setRam(decimalInput(e.target.value))} inputMode="decimal" />
                      <span className="cell-unit">GB</span>
                    </div>
                  ) : (
                    <span className="num">{hw?.ramMb ? `${gbFromMb(hw.ramMb)} GB` : '—'}</span>
                  )}
                </td>
              </tr>
              <tr>
                <th>CPU 核数</th>
                <td>
                  {editing ? (
                    <div className="cell-input-row">
                      <input className="cell-input" value={cores} onChange={(e) => setCores(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" />
                      <span className="cell-unit">核</span>
                    </div>
                  ) : (
                    <span className="num">{hw?.cores ? `${hw.cores} 核` : '—'}</span>
                  )}
                </td>
              </tr>
              <tr>
                <th>硬盘容量</th>
                <td>
                  {/* 扩容入口暂缓开放：核心扩容/重建逻辑保留在 avd.ts 与主进程，恢复时还原此输入框 */}
                  <span className="num">{hw?.storageGb ? `${displayedStorageGb(hw.storageGb)} GB` : '—'}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <DeviceAppsPanel
          scope={scope}
          os="android"
          running={!!run}
          serial={run?.serial}
          emus={emus}
        />
      </div>
      <div style={{ marginTop: 16 }}>
        <CrashesPanel scope={scope} os="android" device={avdName} />
      </div>
      {error && <div className="error-line" style={{ marginTop: 12 }}>{error}</div>}
    </div>
  );
}
