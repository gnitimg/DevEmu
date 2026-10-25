import { useCallback, useEffect, useState } from 'react';
import { api, osFromImagePkg, prettyModel, type EmuDevice, type Scope } from '../api.ts';
import { Modal } from './Modal.tsx';
import { SdkManager } from './SdkManager.tsx';
import { EditVmModal, HwFields, parseHwFields, RECOMMEND_HW } from './VmEdit.tsx';
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
  const [starting, setStarting] = useState<Set<string>>(new Set());
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

  // 「启动中」：点击启动后持续到设备真正上线（或超时）
  useEffect(() => {
    if (starting.size === 0) return;
    const online = new Set(emus.filter((e) => e.state === 'device' && e.avdName).map((e) => e.avdName!));
    const next = new Set([...starting].filter((n) => !online.has(n)));
    if (next.size !== starting.size) setStarting(next);
    const timer = setTimeout(() => setStarting(new Set()), 240_000);
    return () => clearTimeout(timer);
  }, [emus, starting]);

  async function launch(name: string) {
    setBusyName(name);
    setError('');
    setStarting((s) => new Set(s).add(name));
    const r = await api.launchEmu(scope, name);
    if (!r.ok) {
      setError(r.error);
      setStarting((s) => {
        const n = new Set(s);
        n.delete(name);
        return n;
      });
    }
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
              const isStarting = starting.has(avd.name);
              return (
                <tr key={avd.name}>
                  <td>
                    <span className={`dot${isStarting ? ' starting' : run ? ' on' : ''}`} />
                    {isStarting ? '启动中' : run ? '运行中' : '已停止'}
                  </td>
                  <td className="mono">{avd.name}</td>
                  <td>{osFromImagePkg(avd.imagePkg)}</td>
                  <td>{prettyModel(avd.deviceName)}</td>
                  <td>
                    <div className="row-actions">
                      {run ? (
                        <button className="btn btn-sm btn-danger" disabled={busyName === avd.name} onClick={() => stop(avd.name)}>
                          {busyName === avd.name ? '关闭中' : '关闭'}
                        </button>
                      ) : (
                        <>
                          <button
                            className="btn btn-sm btn-primary"
                            disabled={busyName === avd.name || isStarting}
                            onClick={() => launch(avd.name)}
                          >
                            {isStarting ? '启动中' : '启动'}
                          </button>
                          <button className="btn btn-sm" disabled={isStarting} onClick={() => setEditing(avd.name)}>
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

function deviceTypeOf(def: { id: string; name: string }): string {
  const s = (def.id + ' ' + def.name).toLowerCase();
  if (/wear|watch/.test(s)) return '手表';
  if (/tablet|\btab\b/.test(s)) return '平板';
  if (/tv/.test(s)) return '电视';
  if (/desktop|2-in-1|foldable/.test(s)) return '桌面 / 折叠屏';
  if (/auto|car|ddi/.test(s)) return '车载';
  if (/phone|pixel|motorola|nexus/.test(s)) return '手机';
  return '其他';
}

const TYPE_ORDER = ['手机', '平板', '手表', '电视', '桌面 / 折叠屏', '车载', '其他'];

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
  const [defsError, setDefsError] = useState(false);
  const [deviceType, setDeviceType] = useState('');
  const [defId, setDefId] = useState('');
  const [osSeries, setOsSeries] = useState('');
  const [imagePkg, setImagePkg] = useState('');
  const [managing, setManaging] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [ram, setRam] = useState('');
  const [cores, setCores] = useState('');
  const [storage, setStorage] = useState('');

  const loadDefs = useCallback(() => {
    setDefsError(false);
    api.deviceDefs().then((r) => {
      if (r.ok && r.data.ok && r.data.defs) setDefs(r.data.defs);
      else setDefsError(true);
    });
  }, []);

  useEffect(loadDefs, [loadDefs]);

  const installed = env?.images ?? [];

  // 系统级联：左侧按大版本分组，右侧是该版本下的具体镜像
  const osGroups = new Map<string, typeof installed>();
  for (const img of installed) {
    const label = osFromImagePkg(img.pkg);
    const list = osGroups.get(label) ?? [];
    list.push(img);
    osGroups.set(label, list);
  }
  const osSeriesOptions = [...osGroups.entries()]
    .map(([label, imgs]) => ({ label, maxApi: Math.max(...imgs.map((i) => i.api)) }))
    .sort((a, b) => b.maxApi - a.maxApi);
  const osImageOptions = osSeries ? (osGroups.get(osSeries) ?? []) : [];

  // 型号级联：左侧设备类型，右侧该类型的具体机型
  const defTypeMap = new Map<string, DeviceDef[]>();
  for (const d of defs ?? []) {
    const t = deviceTypeOf(d);
    const list = defTypeMap.get(t) ?? [];
    list.push(d);
    defTypeMap.set(t, list);
  }
  const typeOptions = TYPE_ORDER.filter((t) => defTypeMap.has(t));
  const defOptions = deviceType ? (defTypeMap.get(deviceType) ?? []) : [];

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
        <label>型号</label>
        <div className="cascade-row">
          <select
            value={deviceType}
            onChange={(e) => {
              setDeviceType(e.target.value);
              setDefId('');
            }}
          >
            <option value="">设备类型</option>
            {typeOptions.map((t) => (
              <option key={t} value={t}>
                {t}（{defTypeMap.get(t)!.length}）
              </option>
            ))}
          </select>
          <select
            value={defId}
            onChange={(e) => setDefId(e.target.value)}
            disabled={!deviceType || defsError}
          >
            <option value="">{deviceType ? '选择机型' : '先选设备类型'}</option>
            {defOptions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        {defsError && (
          <div className="form-hint">
            机型列表读取失败{' '}
            <button className="link-btn" onClick={loadDefs}>
              重试
            </button>
          </div>
        )}
      </div>
      <div className="form-row">
        <label>系统</label>
        <div className="cascade-row">
          <select
            value={osSeries}
            onChange={(e) => {
              setOsSeries(e.target.value);
              setImagePkg('');
            }}
          >
            <option value="">大版本</option>
            {osSeriesOptions.map((o) => (
              <option key={o.label} value={o.label}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            value={imagePkg}
            onChange={(e) => setImagePkg(e.target.value)}
            disabled={!osSeries}
          >
            <option value="">{osSeries ? '选择镜像' : '先选大版本'}</option>
            {osImageOptions.map((img) => (
              <option key={img.pkg} value={img.pkg}>
                {img.tag} · {img.abi} · API {img.api}
              </option>
            ))}
          </select>
        </div>
        <div className="form-hint">
          <button className="link-btn" onClick={() => setManaging(true)}>
            管理 SDK
          </button>
        </div>
      </div>
      <div className="form-row">
        <button className="link-btn" onClick={() => setAdvanced((v) => !v)}>
          {advanced ? '收起高级配置' : '高级配置（可选）'}
        </button>
      </div>
      {advanced && (
        <HwFields ram={ram} setRam={setRam} cores={cores} setCores={setCores} storage={storage} setStorage={setStorage} />
      )}
      {error && <div className="error-line" style={{ border: 'none', padding: '0 0 0 1px' }}>{error}</div>}
    </Modal>
  );
}
