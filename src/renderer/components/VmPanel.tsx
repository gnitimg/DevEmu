import { useCallback, useEffect, useState } from 'react';
import { api, type EmuDevice, type ImageEntry, type Scope } from '../api.ts';
import { Modal } from './Modal.tsx';
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
              <th>镜像</th>
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
                  <td className="mono" style={{ color: 'var(--text-2)' }}>
                    {shortPkg(avd.imagePkg)}
                  </td>
                  <td>
                    <div className="row-actions">
                      {run ? (
                        <button className="btn btn-sm" disabled={busyName === avd.name} onClick={() => stop(avd.name)}>
                          停止
                        </button>
                      ) : (
                        <button
                          className="btn btn-sm btn-primary"
                          disabled={busyName === avd.name}
                          onClick={() => launch(avd.name)}
                        >
                          启动
                        </button>
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

function shortPkg(pkg?: string): string {
  if (!pkg) return '—';
  const parts = pkg.split(';');
  return `${parts[1] ?? ''} · ${parts[2] ?? ''} · ${parts[3] ?? ''}`;
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
  const [available, setAvailable] = useState<ImageEntry[] | null>(null);
  const [loadingAvail, setLoadingAvail] = useState(false);
  const [downloading, setDownloading] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.deviceDefs().then((r) => {
      if (r.ok && r.data.ok && r.data.defs) {
        setDefs(r.data.defs);
        const preferred = r.data.defs.find((d) => /^pixel_/.test(d.id));
        setDefId(preferred ? preferred.id : (r.data.defs[0]?.id ?? ''));
      }
    });
  }, []);

  const installed = env?.images ?? [];

  async function loadAvailable() {
    setLoadingAvail(true);
    setError('');
    const r = await api.availableImages();
    if (r.ok) setAvailable(r.data);
    else setError(r.error);
    setLoadingAvail(false);
  }

  async function download(pkg: string) {
    setDownloading(pkg);
    setError('');
    const r = await api.downloadImage(pkg);
    setDownloading('');
    if (!r.ok) {
      setError(r.error);
      return;
    }
    refreshEnv();
    setImagePkg(pkg);
    setAvailable(null);
  }

  async function create() {
    if (!name.trim() || !imagePkg) return;
    setCreating(true);
    setError('');
    const r = await api.createAvd(scope, name.trim(), imagePkg, defId);
    if (!r.ok || !r.data.ok) {
      setError(r.ok ? r.data.error ?? '创建失败' : r.error);
      setCreating(false);
      return;
    }
    onDone();
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
        <label>系统镜像</label>
        <select value={imagePkg} onChange={(e) => setImagePkg(e.target.value)}>
          <option value="">选择已安装的镜像</option>
          {installed.map((img) => (
            <option key={img.pkg} value={img.pkg}>
              API {img.api} · {img.tag} · {img.abi}
            </option>
          ))}
        </select>
        <div className="form-hint">
          没有合适的？{' '}
          <button className="link-btn" onClick={loadAvailable} disabled={loadingAvail}>
            {loadingAvail ? '查询中' : '从 SDK 仓库获取'}
          </button>
        </div>
        {available && (
          <div className="img-list">
            {available.map((e) => (
              <div key={e.pkg} className="img-row">
                <span className="mono" title={e.pkg}>
                  {e.pkg}
                </span>
                <button
                  className="btn btn-sm"
                  disabled={downloading !== ''}
                  onClick={() => download(e.pkg)}
                >
                  {downloading === e.pkg ? '下载中' : '下载'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="form-row">
        <label>机型</label>
        <select value={defId} onChange={(e) => setDefId(e.target.value)}>
          {defs === null ? <option value="">读取中</option> : null}
          {defs?.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      {error && <div className="error-line" style={{ border: 'none', padding: '0 0 0 1px' }}>{error}</div>}
      <div className="form-hint">下载镜像可能需要数分钟，取决于网络。</div>
    </Modal>
  );
}
