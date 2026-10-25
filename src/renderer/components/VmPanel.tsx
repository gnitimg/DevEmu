import { useCallback, useEffect, useState } from 'react';
import { api, osFromImagePkg, prettyModel, type EmuDevice, type Scope } from '../api.ts';
import { Modal } from './Modal.tsx';
import { SdkManager } from './SdkManager.tsx';
import type { EnvStatus } from '../App.tsx';
import type { AvdInfo, DeviceDef } from '../../core/types.ts';

export function VmPanel({
  scope,
  emus,
  refreshEmus,
  env,
  refreshEnv,
}: {
  scope: Scope;
  emus: EmuDevice[];
  refreshEmus: () => void;
  env: EnvStatus | null;
  refreshEnv: () => void;
}) {
  const [avds, setAvds] = useState<AvdInfo[] | null>(null);
  const [error, setError] = useState('');
  const [busyName, setBusyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.listAvds(scope).then((r) => {
      if (r.ok) setAvds(r.data);
      else setError(r.error);
    });
  }, [scope]);

  useEffect(reload, [reload]);

  const runningOf = (name: string): EmuDevice | undefined =>
    emus.find((e) => e.state === 'device' && e.avdName === name);

  async function launch(name: string) {
    setBusyName(name);
    setError('');
    const r = await api.launchEmu(scope, name);
    if (!r.ok) setError(r.error);
    refreshEmus();
    setBusyName('');
  }

  async function stop(name: string) {
    setBusyName(name);
    setError('');
    const r = await api.stopEmu(scope, name);
    if (!r.ok) setError(r.error);
    setTimeout(refreshEmus, 1500);
    setBusyName('');
  }

  async function remove(name: string) {
    if (!window.confirm(`删除虚拟机 ${name}？该操作不可恢复。`)) return;
    setBusyName(name);
    setError('');
    const r = await api.deleteAvd(scope, name);
    if (!r.ok || !r.data.ok) setError(r.ok ? r.data.error ?? '删除失败' : r.error);
    reload();
    setBusyName('');
  }

  return (
    <div className="section">
      <div className="section-head">
        <h2 className="section-title">虚拟机</h2>
        {avds && <span className="section-count">{avds.length}</span>}
        <div className="section-actions">
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            新建虚拟机
          </button>
        </div>
      </div>
      {avds === null ? (
        <div className="empty">
          <span className="spinner" />
        </div>
      ) : avds.length === 0 ? (
        <div className="empty">
          还没有虚拟机
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            创建一个
          </button>
        </div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 90 }}>状态</th>
              <th>名称</th>
              <th style={{ width: 130 }}>系统</th>
              <th style={{ width: 150 }}>型号</th>
              <th style={{ width: 170 }}></th>
            </tr>
          </thead>
          <tbody>
            {avds.map((avd) => {
              const run = runningOf(avd.name);
              return (
                <tr key={avd.name}>
                  <td>
                    <span className={`dot${run ? ' on' : ''}`} />
                    {run ? '运行中' : '已停止'}
                  </td>
                  <td className="mono">{avd.name}</td>
                  <td>{osFromImagePkg(avd.imagePkg)}</td>
                  <td>{prettyModel(avd.deviceName)}</td>
                  <td>
                    <div className="row-actions">
                      {run ? (
                        <button className="btn btn-sm" disabled={busyName === avd.name} onClick={() => stop(avd.name)}>
                          停止
                        </button>
                      ) : (
                        <>
                          <button
                            className="btn btn-sm btn-primary"
                            disabled={busyName === avd.name}
                            onClick={() => launch(avd.name)}
                          >
                            启动
                          </button>
                          <button className="btn btn-sm" onClick={() => setEditing(avd.name)}>
                            配置
                          </button>
                        </>
                      )}
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={busyName === avd.name || !!run}
                        title={run ? '先停止再删除' : ''}
                        onClick={() => remove(avd.name)}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {error && <div className="error-line">{error}</div>}
      {editing !== null && (
        <EditVmModal
          scope={scope}
          avdName={editing}
          onDone={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {creating && (
        <NewVmModal
          scope={scope}
          env={env}
          refreshEnv={refreshEnv}
          onDone={() => {
            setCreating(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

export const RECOMMEND_HW = { ramMb: 2048, cores: 4, storageGb: 6 };

function HwFields({
  ram,
  setRam,
  cores,
  setCores,
  storage,
  setStorage,
}: {
  ram: string;
  setRam: (v: string) => void;
  cores: string;
  setCores: (v: string) => void;
  storage: string;
  setStorage: (v: string) => void;
}) {
  return (
    <div className="hw-grid">
      <div className="form-row">
        <label>内存（MB）</label>
        <input
          value={ram}
          onChange={(e) => setRam(e.target.value.replace(/[^\d]/g, ''))}
          placeholder={`推荐 ${RECOMMEND_HW.ramMb}`}
          inputMode="numeric"
        />
      </div>
      <div className="form-row">
        <label>CPU 核数</label>
        <input
          value={cores}
          onChange={(e) => setCores(e.target.value.replace(/[^\d]/g, ''))}
          placeholder={`推荐 ${RECOMMEND_HW.cores}`}
          inputMode="numeric"
        />
      </div>
      <div className="form-row">
        <label>数据分区（GB）</label>
        <input
          value={storage}
          onChange={(e) => setStorage(e.target.value.replace(/[^\d]/g, ''))}
          placeholder={`推荐 ${RECOMMEND_HW.storageGb}`}
          inputMode="numeric"
        />
      </div>
    </div>
  );
}

function parseHwFields(ram: string, cores: string, storage: string) {
  return {
    ramMb: ram ? Number(ram) : undefined,
    cores: cores ? Number(cores) : undefined,
    storageGb: storage ? Number(storage) : undefined,
  };
}

function EditVmModal({
  scope,
  avdName,
  onDone,
}: {
  scope: Scope;
  avdName: string;
  onDone: () => void;
}) {
  const [ram, setRam] = useState('');
  const [cores, setCores] = useState('');
  const [storage, setStorage] = useState('');
  const [current, setCurrent] = useState<{ ramMb?: number; cores?: number; storageGb?: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.avdHardware(scope, avdName).then((r) => {
      if (r.ok && r.data) {
        setCurrent(r.data);
        setRam(r.data.ramMb ? String(r.data.ramMb) : '');
        setCores(r.data.cores ? String(r.data.cores) : '');
        setStorage(r.data.storageGb ? String(Math.round(r.data.storageGb)) : '');
      } else if (r.ok) {
        setError('读取配置失败');
      } else {
        setError(r.error);
      }
    });
  }, [scope, avdName]);

  async function save() {
    setSaving(true);
    setError('');
    const r = await api.setAvdHardware(scope, avdName, parseHwFields(ram, cores, storage));
    if (!r.ok || !r.data.ok) {
      setError(r.ok ? r.data.error ?? '保存失败' : r.error);
      setSaving(false);
      return;
    }
    onDone();
  }

  return (
    <Modal
      title={`配置 ${avdName}`}
      onClose={onDone}
      footer={
        <>
          <button className="btn" onClick={onDone}>
            取消
          </button>
          <button className="btn btn-primary" disabled={saving} onClick={save}>
            {saving ? '保存中' : '保存'}
          </button>
        </>
      }
    >
      <HwFields ram={ram} setRam={setRam} cores={cores} setCores={setCores} storage={storage} setStorage={setStorage} />
      <div className="form-hint">
        当前：内存 {current?.ramMb ?? '—'} MB · {current?.cores ?? '—'} 核 · 数据分区{' '}
        {current?.storageGb ?? '—'} GB。清空某项则保持不变。
      </div>
      {error && <div className="error-line" style={{ border: 'none', padding: '0 0 0 1px' }}>{error}</div>}
    </Modal>
  );
}

function NewVmModal({
  scope,
  env,
  refreshEnv,
  onDone,
}: {
  scope: Scope;
  env: EnvStatus | null;
  refreshEnv: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [defs, setDefs] = useState<DeviceDef[] | null>(null);
  const [defId, setDefId] = useState('');
  const [imagePkg, setImagePkg] = useState('');
  const [managing, setManaging] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [ram, setRam] = useState('');
  const [cores, setCores] = useState('');
  const [storage, setStorage] = useState('');

  useEffect(() => {
    api.deviceDefs().then((r) => {
      if (r.ok && r.data.ok && r.data.defs) {
        setDefs(r.data.defs);
        // 推荐较新的 Pixel 机型，避免按字母序选到 pixel_2
        const preferred =
          r.data.defs.find((d) => /^pixel_(9|8|7)/.test(d.id)) ??
          r.data.defs.find((d) => /^pixel_/.test(d.id)) ??
          r.data.defs[0];
        setDefId(preferred ? preferred.id : '');
      }
    });
  }, []);

  const installed = env?.images ?? [];

  async function create() {
    if (!name.trim() || !imagePkg) return;
    setCreating(true);
    setError('');
    const r = await api.createAvd(scope, name.trim(), imagePkg, defId, parseHwFields(ram, cores, storage));
    if (!r.ok || !r.data.ok) {
      setError(r.ok ? r.data.error ?? '创建失败' : r.error);
      setCreating(false);
      return;
    }
    onDone();
  }

  if (managing) {
    return (
      <SdkManager
        onClose={() => setManaging(false)}
        onChanged={() => {
          refreshEnv();
        }}
      />
    );
  }

  return (
    <Modal
      title="新建虚拟机"
      onClose={onDone}
      footer={
        <>
          <button className="btn" onClick={onDone}>
            取消
          </button>
          <button className="btn btn-primary" disabled={creating || !name.trim() || !imagePkg} onClick={create}>
            {creating ? '创建中' : '创建'}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label>名称（字母、数字、下划线）</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 pixel6_test" autoFocus />
      </div>
      <div className="form-row">
        <label>系统</label>
        <select value={imagePkg} onChange={(e) => setImagePkg(e.target.value)}>
          <option value="">选择已安装的镜像</option>
          {installed.map((img) => (
            <option key={img.pkg} value={img.pkg}>
              {osFromImagePkg(img.pkg)}（API {img.api}）· {img.tag} · {img.abi}
            </option>
          ))}
        </select>
        <div className="form-hint">
          缺少镜像或组件？{' '}
          <button className="link-btn" onClick={() => setManaging(true)}>
            管理 SDK
          </button>
        </div>
      </div>
      <div className="form-row">
        <label>型号</label>
        <select value={defId} onChange={(e) => setDefId(e.target.value)}>
          {defs === null ? <option value="">读取中</option> : null}
          {defs?.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <button className="link-btn" onClick={() => setAdvanced((v) => !v)}>
          {advanced ? '收起高级配置' : '高级配置（可选）'}
        </button>
      </div>
      {advanced && (
        <>
          <HwFields ram={ram} setRam={setRam} cores={cores} setCores={setCores} storage={storage} setStorage={setStorage} />
          <div className="form-hint" style={{ marginBottom: 10 }}>
            留空使用推荐配置：内存 {RECOMMEND_HW.ramMb} MB · {RECOMMEND_HW.cores} 核 · 数据分区 {RECOMMEND_HW.storageGb} GB。
          </div>
        </>
      )}
      {error && <div className="error-line" style={{ border: 'none', padding: '0 0 0 1px' }}>{error}</div>}
    </Modal>
  );
}
