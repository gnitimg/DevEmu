import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  onHosStartFailed,
  type HosAvd,
  type HosImage,
} from '../api.ts';
import { Modal } from './Modal.tsx';
import { Select } from './Select.tsx';
import { toast } from './Toast.tsx';
import { MIN_STORAGE_GB, RECOMMEND_HW, gbFromMb } from './VmEdit.tsx';
import {
  HOS_DEFAULT_MODELS,
  HOS_IMAGE_FAMILIES,
  HOS_SYSTEM_STORAGE_GB,
  groupHosModels,
  hosDeviceFamily,
  hosDeviceLabel,
  hosFamilyOrder,
  hosScreenTypeLabel,
  hosSeries,
} from '../../core/hosLabels.ts';
import { hosDefaultName } from '../../core/vmNames.ts';
import { sameJson, type EnvStatus } from '../App.tsx';

function imageKey(img: HosImage): string {
  return `${img.deviceType}|${img.osVersion}`;
}

/** deviceType 用于创建时定位镜像；screenProfile 缺省表示该形态只能取默认机型 */
interface HosModelOption {
  name: string;
  deviceType: string;
  screenProfile?: string;
}

/** HarmonyOS 虚拟机管理：与 Android 设备池同构（列表 + 新建/启动/关闭/删除） */
export function HosVmPanel({
  env,
  refreshEmus,
  onOpenSdkManage,
  onOpenVm,
}: {
  env: EnvStatus | null;
  refreshEmus: () => void;
  onOpenSdkManage?: (system?: 'android' | 'harmonyos') => void;
  onOpenVm?: (name: string) => void;
}) {
  const [avds, setAvds] = useState<HosAvd[] | null>(null);
  const existingNames = useMemo(() => (avds ?? []).map((a) => a.name), [avds]);
  const [error, setError] = useState('');
  const [busyName, setBusyName] = useState('');
  // 名称 → 点击启动的时刻；启动成功后由轮询结果收敛，超时则回落
  const [starting, setStarting] = useState<Record<string, number>>({});
  const [creating, setCreating] = useState(false);

  const reload = useCallback(() => {
    api.hosList().then((r) => {
      if (r.ok) {
        // 主进程每次返回新数组身份：内容相同即复用旧引用，跳过面板重渲染
        setAvds((cur) => (sameJson(cur, r.data) ? cur : r.data));
        setError('');
      } else {
        setAvds((prev) => prev ?? []);
        setError(r.error);
      }
    });
  }, []);

  useEffect(() => {
    reload();
    const timer = setInterval(reload, 5_000);
    return () => clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    const entries = Object.entries(starting);
    if (entries.length === 0) return;
    const running = new Set((avds ?? []).filter((a) => a.running).map((a) => a.name));
    const next: Record<string, number> = {};
    for (const [name, at] of entries) {
      if (!running.has(name) && Date.now() - at < 320_000) next[name] = at;
      // 超时兜底静默还原按钮时进程可能只是挂起：补一条提示（当轮即移出，不重复弹）
      else if (!running.has(name)) toast(`${name} 启动超时，请查看日志`);
    }
    if (Object.keys(next).length !== entries.length) setStarting(next);
  }, [avds, starting]);

  useEffect(
    () =>
      onHosStartFailed(({ name, error: msg }) => {
        setStarting((s) => {
          const n = { ...s };
          delete n[name];
          return n;
        });
        setError(`${name} 启动失败：${msg}`);
        toast(`${name} 启动失败`);
      }),
    [],
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

  async function launch(name: string) {
    setBusyName(name);
    setError('');
    setStarting((s) => ({ ...s, [name]: Date.now() }));
    let r = await api.hosStart(name);
    if (r.ok && r.data.needLicense && !(await acceptLicense())) {
      setStarting((s) => {
        const n = { ...s };
        delete n[name];
        return n;
      });
      setBusyName('');
      return;
    }
    if (r.ok && r.data.needLicense) r = await api.hosStart(name);
    if (!r.ok) {
      setError(r.error);
      setStarting((s) => {
        const n = { ...s };
        delete n[name];
        return n;
      });
    }
    refreshEmus();
    setBusyName('');
  }

  async function stop(name: string) {
    setBusyName(name);
    setError('');
    const r = await api.hosStop(name);
    if (!r.ok) setError(r.error);
    setTimeout(reload, 1_500);
    setTimeout(refreshEmus, 1_500);
    setBusyName('');
  }

  async function remove(name: string) {
    if (!window.confirm(`删除虚拟机 ${name}？该操作不可恢复。`)) return;
    setBusyName(name);
    setError('');
    const r = await api.hosDelete(name);
    if (!r.ok) setError(r.error);
    reload();
    setBusyName('');
  }

  return (
    <div className="section">
      <div className="section-head">
        <h2 className="section-title">虚拟机</h2>
        {avds && <span className="section-count">{avds.length}</span>}
        <div className="section-actions">
          <button className="btn btn-primary" disabled={!env?.harmony} onClick={() => setCreating(true)}>
            新建虚拟机
          </button>
        </div>
      </div>
      {!env?.harmony ? (
        <div className="empty">
          未检测到 HarmonyOS SDK
          {onOpenSdkManage && (
            <div className="empty-actions">
              <button className="btn btn-sm btn-primary" onClick={() => onOpenSdkManage('harmonyos')}>
                前往 SDK 设置
              </button>
            </div>
          )}
        </div>
      ) : avds === null ? (
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
              <th style={{ width: 180 }}>系统</th>
              <th style={{ width: 150 }}>型号</th>
              <th style={{ width: 170 }}></th>
            </tr>
          </thead>
          <tbody>
            {avds.map((avd) => {
              const isStarting = avd.name in starting;
              return (
                <tr key={avd.name}>
                  <td>
                    {isStarting && !avd.running ? (
                      <span className="chip warn">启动中</span>
                    ) : avd.running ? (
                      <span className="chip ok">运行中</span>
                    ) : (
                      <span className="chip idle">已停止</span>
                    )}
                  </td>
                  <td>
                    {onOpenVm ? (
                      <button className="link-btn mono" style={{ fontSize: 12 }} onClick={() => onOpenVm(avd.name)}>
                        {avd.name}
                      </button>
                    ) : (
                      <span className="mono">{avd.name}</span>
                    )}
                  </td>
                  <td>{avd.osVersion || '—'}</td>
                  <td>{avd.productModel ?? hosDeviceLabel(avd.deviceType)}</td>
                  <td>
                    <div className="row-actions">
                      {avd.running ? (
                        <button className="btn btn-sm btn-danger" disabled={busyName === avd.name} onClick={() => stop(avd.name)}>
                          {busyName === avd.name ? '关闭中' : '关闭'}
                        </button>
                      ) : (
                        <button
                          className="btn btn-sm btn-primary"
                          disabled={busyName === avd.name || isStarting}
                          onClick={() => launch(avd.name)}
                        >
                          {isStarting ? '启动中' : '启动'}
                        </button>
                      )}
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={busyName === avd.name || avd.running}
                        title={avd.running ? '先停止再删除' : ''}
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
        <NewHosVmModal
          existing={existingNames}
          onClose={() => setCreating(false)}
          onOpenSdkManage={onOpenSdkManage}
          onDone={() => {
            setCreating(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function NewHosVmModal({
  existing,
  onClose,
  onDone,
  onOpenSdkManage,
}: {
  /** 现有名称：默认名按此递增编号 */
  existing: string[];
  onClose: () => void;
  onOpenSdkManage?: (system?: 'android' | 'harmonyos') => void;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [images, setImages] = useState<HosImage[] | null>(null);
  const [imagesError, setImagesError] = useState('');
  const [family, setFamily] = useState('');
  const [series, setSeries] = useState('');
  const [selKey, setSelKey] = useState('');
  const [models, setModels] = useState<HosModelOption[] | null>(null);
  const [modelsError, setModelsError] = useState('');
  const [modelsRetry, setModelsRetry] = useState(0);
  const [modelSeries, setModelSeries] = useState('');
  const [model, setModel] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [memory, setMemory] = useState('');
  const [cpu, setCpu] = useState('');
  const [storage, setStorage] = useState('');
  const [memoryError, setMemoryError] = useState('');
  const [cpuError, setCpuError] = useState('');
  const [storageError, setStorageError] = useState('');

  const loadImages = useCallback(() => {
    setImagesError('');
    api
      .hosImages()
      .then((r) => {
        if (!r.ok) {
          setImagesError(r.error);
          setImages([]);
          return;
        }
        setImages(r.data);
        setFamily((cur) => {
          if (cur && r.data.some((i) => hosDeviceFamily(i.deviceType).id === cur)) return cur;
          const first = r.data.find((i) => i.downloaded) ?? r.data[0];
          return first ? hosDeviceFamily(first.deviceType).id : '';
        });
      })
      .catch(() => {
        setImagesError('无法读取镜像列表，请重启应用后重试');
        setImages([]);
      });
  }, []);

  useEffect(loadImages, [loadImages]);

  // 第一列只到镜像家族：手机家族含直板/折叠/三折叠/宽折叠，形态由型号行尾标签区分
  useEffect(() => {
    if (!family) {
      setModels(null);
      setModelSeries('');
      setModel('');
      return;
    }
    let alive = true;
    setModels(null);
    setModelSeries('');
    setModel('');
    setModelsError('');
    const types = HOS_IMAGE_FAMILIES.find((f) => f.id === family)?.types ?? [family];
    Promise.all(types.map((t) => api.hosScreenProfiles(t)))
      .then((results) => {
        if (!alive) return;
        const failed = results.filter((r) => !r.ok);
        if (failed.length === types.length) {
          const first = failed[0];
          setModelsError(first && !first.ok ? first.error : '无法读取机型列表');
          setModels([]);
          return;
        }
        const opts: HosModelOption[] = [];
        types.forEach((t, i) => {
          const r = results[i]!;
          if (r.ok) {
            for (const name of r.data) opts.push({ name, deviceType: t, screenProfile: name });
          }
          const def = HOS_DEFAULT_MODELS[t];
          if (def && (!r.ok || r.data.length === 0) && !opts.some((o) => o.name === def))
            opts.push({ name: def, deviceType: t });
        });
        setModels(opts);
      })
      .catch(() => {
        if (!alive) return;
        setModelsError('无法读取机型列表');
        setModels([]);
      });
    return () => {
      alive = false;
    };
  }, [family, modelsRetry]);

  // 机型折叠成「系列 → 型号」两级，避免手机一次性列出几十个机型
  const modelGroups = groupHosModels((models ?? []).map((m) => m.name));
  const seriesModels = modelGroups.find((g) => g.name === modelSeries)?.models ?? [];
  const modelByName = new Map((models ?? []).map((m) => [m.name, m]));
  const modelInfo = modelByName.get(model) ?? null;
  const modelReady = models !== null && (models.length === 0 || modelInfo !== null);

  useEffect(() => {
    if (!models) return;
    const groups = groupHosModels(models.map((m) => m.name));
    setModelSeries((cur) => (groups.some((g) => g.name === cur) ? cur : (groups[0]?.name ?? '')));
  }, [models]);

  useEffect(() => {
    const list =
      groupHosModels((models ?? []).map((m) => m.name)).find((g) => g.name === modelSeries)
        ?.models ?? [];
    setModel((cur) => (list.includes(cur) ? cur : (list[0] ?? '')));
  }, [models, modelSeries]);

  // 机型自动选定后同步默认名称；用户改过名称就不再覆盖
  useEffect(() => {
    if (nameTouched || !model) return;
    setName(hosDefaultName(model, existing));
  }, [model, existing, nameTouched]);

  const families = [
    ...new Map(
      (images ?? []).map((i) => {
        const f = hosDeviceFamily(i.deviceType);
        return [f.id, f] as const;
      }),
    ).values(),
  ].sort((a, b) => hosFamilyOrder(a.id) - hosFamilyOrder(b.id));
  const familyTypes = HOS_IMAGE_FAMILIES.find((f) => f.id === family)?.types ?? [];
  // 系统镜像跟所选型号的真实形态走：折叠型号需要对应形态的镜像
  const activeType = modelInfo?.deviceType ?? familyTypes[0] ?? '';
  const typeDownloaded = (images ?? []).filter((i) => i.deviceType === activeType && i.downloaded);
  const seriesList = [...new Set(typeDownloaded.map((i) => hosSeries(i.osVersion)))];
  const versionList = typeDownloaded.filter((i) => hosSeries(i.osVersion) === series);
  const selected = versionList.find((i) => imageKey(i) === selKey) ?? versionList[0];
  const key = selected ? imageKey(selected) : '';

  useEffect(() => {
    const list = (images ?? []).filter((i) => i.deviceType === activeType && i.downloaded);
    const names = [...new Set(list.map((i) => hosSeries(i.osVersion)))];
    setSeries((cur) => (names.includes(cur) ? cur : (names[0] ?? '')));
  }, [activeType, images]);

  useEffect(() => {
    const list = (images ?? []).filter(
      (i) => i.deviceType === activeType && i.downloaded && hosSeries(i.osVersion) === series,
    );
    setSelKey((cur) => {
      if (list.some((i) => imageKey(i) === cur)) return cur;
      const first = list[0];
      return first ? imageKey(first) : '';
    });
  }, [activeType, series, images]);

  function checkMemory(v: string) {
    const n = v ? Number(v) : NaN;
    setMemoryError(v && (!Number.isInteger(n) || n < 2 || n > 32) ? '内存需为 2–32 GB 的整数' : '');
  }

  function checkCpu(v: string) {
    const n = v ? Number(v) : NaN;
    setCpuError(v && (!Number.isInteger(n) || n < 1 || n > 16) ? 'CPU 核数需为 1–16 的整数' : '');
  }

  function checkStorage(v: string) {
    const n = v ? Number(v) : NaN;
    const min = MIN_STORAGE_GB + HOS_SYSTEM_STORAGE_GB;
    setStorageError(
      v && (!Number.isInteger(n) || n < min || n > 1023)
        ? `硬盘容量需为 ${min}–1023 GB 的整数`
        : '',
    );
  }

  async function ensureLicense(need: boolean): Promise<boolean> {
    if (!need) return true;
    if (!window.confirm('安装或启动 HarmonyOS 模拟器需先接受华为软件服务协议。确认接受并继续？')) return false;
    const r = await api.hosAcceptLicense();
    if (!r.ok) {
      setError(r.error);
      return false;
    }
    return true;
  }

  async function create() {
    if (!name.trim() || !selected || !selected.downloaded || !modelReady) return;
    const memoryGb = memory ? Number(memory) : undefined;
    const cpuCores = cpu ? Number(cpu) : undefined;
    const totalStorageGb = storage ? Number(storage) : undefined;
    const storageGb =
      totalStorageGb === undefined ? undefined : totalStorageGb - HOS_SYSTEM_STORAGE_GB;
    const memoryBad =
      memoryGb !== undefined && (!Number.isInteger(memoryGb) || memoryGb < 2 || memoryGb > 32);
    const cpuBad =
      cpuCores !== undefined && (!Number.isInteger(cpuCores) || cpuCores < 1 || cpuCores > 16);
    const storageBad =
      totalStorageGb !== undefined &&
      (!Number.isInteger(totalStorageGb) ||
        totalStorageGb < MIN_STORAGE_GB + HOS_SYSTEM_STORAGE_GB ||
        totalStorageGb > 1023);
    if (memoryBad || cpuBad || storageBad) {
      checkMemory(memory);
      checkCpu(cpu);
      checkStorage(storage);
      return;
    }
    setCreating(true);
    setError('');
    const opts = {
      name: name.trim(),
      deviceType: modelInfo?.deviceType ?? activeType,
      osVersion: selected.osVersion,
      screenProfile: modelInfo?.screenProfile,
      memoryGb,
      storageGb,
      cpuCores,
    };
    let r = await api.hosCreate(opts);
    if (r.ok && r.data.needLicense && !(await ensureLicense(true))) {
      setCreating(false);
      return;
    }
    if (r.ok && r.data.needLicense) r = await api.hosCreate(opts);
    if (!r.ok) {
      setError(r.error);
      setCreating(false);
      return;
    }
    onDone();
  }

  return (
    <Modal
      title="新建虚拟机"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={
              creating ||
              !name.trim() ||
              !selected?.downloaded ||
              !modelReady ||
              !!memoryError ||
              !!cpuError ||
              !!storageError
            }
            onClick={() => void create()}
          >
            {creating ? '创建中' : '创建'}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label>名称</label>
        <input
          value={name}
          maxLength={64}
          onChange={(e) => {
            setName(e.target.value.replace(/[\\/:*?"<>|\r\n]/g, ''));
            setNameTouched(true);
          }}
          autoFocus
        />
      </div>
      <div className="form-row">
        <label>型号</label>
        <div className="cascade-row cols-3">
          <Select
            value={family}
            options={families.map((f) => ({ value: f.id, label: f.label }))}
            onChange={setFamily}
            placeholder={
              images === null ? '读取镜像中…' : families.length ? '设备类型' : '没有可用镜像'
            }
            disabled={!families.length}
          />
          <Select
            value={modelSeries}
            options={modelGroups.map((g) => ({
              value: g.name,
              label: `${g.name} 系列`,
              hint: String(g.models.length),
            }))}
            onChange={setModelSeries}
            placeholder={models === null ? '读取机型中…' : modelGroups.length ? '系列' : '默认机型'}
            disabled={!modelGroups.length}
          />
          <Select
            value={model}
            options={seriesModels.map((m) => ({
              value: m,
              label: m,
              tag: hosScreenTypeLabel(modelByName.get(m)?.deviceType ?? activeType, m),
            }))}
            onChange={setModel}
            placeholder={models === null ? '读取机型中…' : seriesModels.length ? '选择机型' : '默认机型'}
            disabled={!seriesModels.length}
          />
        </div>
        {modelsError && (
          <div className="form-error">
            {modelsError}{' '}
            <button className="link-btn" onClick={() => setModelsRetry((v) => v + 1)}>
              重试
            </button>
          </div>
        )}
      </div>
      <div className="form-row">
        <label style={{ display: 'flex', alignItems: 'center' }}>
          <span>系统</span>
          {onOpenSdkManage && (
            <button
              className="link-btn"
              style={{ marginLeft: 'auto', fontSize: 11.5 }}
              onClick={() => {
                onClose();
                onOpenSdkManage('harmonyos');
              }}
            >
              管理 SDK
            </button>
          )}
        </label>
        <div className="cascade-row">
          <Select
            value={series}
            options={seriesList.map((s) => ({ value: s, label: s }))}
            onChange={setSeries}
            placeholder={
              !family ? '先选设备类型' : seriesList.length ? '大版本' : '无已下载镜像'
            }
            disabled={!seriesList.length}
          />
          <Select
            value={key}
            options={versionList.map((i) => ({
              value: imageKey(i),
              label: i.osVersion,
              hint: i.softwareVersion,
            }))}
            onChange={setSelKey}
            placeholder={
              !series ? '先选大版本' : versionList.length ? '小版本' : '无已下载镜像'
            }
            disabled={!versionList.length}
          />
        </div>
        {imagesError && (
          <div className="form-error">
            {imagesError}{' '}
            <button className="link-btn" onClick={loadImages}>
              重试
            </button>
          </div>
        )}
      </div>
      <div className="form-row">
        <button className="adv-toggle" onClick={() => setAdvanced((v) => !v)}>
          高级配置
          <svg className={`adv-chev${advanced ? ' open' : ''}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 3.5 10.5 8 6 12.5" />
          </svg>
        </button>
      </div>
      <div className={`adv-body${advanced ? '' : ' collapsed'}`}>
        <div className="adv-inner">
          <div className="hw-grid">
            <div className="form-row">
              <label>内存（GB）</label>
              <input
                value={memory}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^\d]/g, '');
                  setMemory(v);
                  if (memoryError) checkMemory(v);
                }}
                onBlur={() => checkMemory(memory)}
                className={memoryError ? 'invalid' : undefined}
                aria-invalid={memoryError ? true : undefined}
                placeholder={`推荐 ${gbFromMb(RECOMMEND_HW.ramMb)}`}
                inputMode="numeric"
              />
              {memoryError && <div className="form-error">{memoryError}</div>}
            </div>
            <div className="form-row">
              <label>CPU 核数</label>
              <input
                value={cpu}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^\d]/g, '');
                  setCpu(v);
                  if (cpuError) checkCpu(v);
                }}
                onBlur={() => checkCpu(cpu)}
                className={cpuError ? 'invalid' : undefined}
                aria-invalid={cpuError ? true : undefined}
                placeholder={`推荐 ${RECOMMEND_HW.cores}`}
                inputMode="numeric"
              />
              {cpuError && <div className="form-error">{cpuError}</div>}
            </div>
            <div className="form-row">
              <label>硬盘容量（GB）</label>
              <input
                value={storage}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^\d]/g, '');
                  setStorage(v);
                  if (storageError) checkStorage(v);
                }}
                onBlur={() => checkStorage(storage)}
                className={storageError ? 'invalid' : undefined}
                aria-invalid={storageError ? true : undefined}
                placeholder={`推荐 ${RECOMMEND_HW.storageGb + HOS_SYSTEM_STORAGE_GB}`}
                inputMode="numeric"
              />
              {storageError && <div className="form-error">{storageError}</div>}
            </div>
          </div>
        </div>
      </div>
      {error && <div className="error-line" style={{ border: 'none', padding: '0 0 0 1px' }}>{error}</div>}
    </Modal>
  );
}
