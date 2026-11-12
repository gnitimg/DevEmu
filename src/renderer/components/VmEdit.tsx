import { useEffect, useState } from 'react';
import { api, type Scope } from '../api.ts';
import { Modal } from './Modal.tsx';
import { displayedStorageGb, rawStorageGb } from '../../core/storageUnits.ts';

export const RECOMMEND_HW = { ramMb: 2048, cores: 4, storageGb: 16 };
/** 数据分区下限：再小 Android 的系统数据会很快占满整块存储 */
export const MIN_STORAGE_GB = 6;

/** MB 转 GB 文本（4 GB 而非 4.0 GB） */
export function gbFromMb(mb: number): string {
  return String(Math.round((mb / 1024) * 10) / 10);
}

/** 只保留一个小数点以内的数字，避免 Number() 得到 NaN 后被主进程静默丢弃 */
export function decimalInput(value: string): string {
  return value.replace(/[^\d.]/g, '').replace(/^(\d*\.?\d*).*$/, '$1');
}

export function HwFields({
  ram,
  setRam,
  cores,
  setCores,
  storage,
  setStorage,
  storageError,
  storageReadOnly,
  onStorageBlur,
}: {
  ram: string;
  setRam: (v: string) => void;
  cores: string;
  setCores: (v: string) => void;
  storage: string;
  setStorage: (v: string) => void;
  storageError?: string;
  storageReadOnly?: string;
  onStorageBlur?: () => void;
}) {
  return (
    <div className="hw-grid">
      <div className="form-row">
        <label>内存（GB）</label>
        <input
          value={ram}
          onChange={(e) => setRam(decimalInput(e.target.value))}
          placeholder={`推荐 ${gbFromMb(RECOMMEND_HW.ramMb)}`}
          inputMode="decimal"
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
        <label>硬盘容量（GB）</label>
        {storageReadOnly !== undefined ? (
          <span className="num">{storageReadOnly}</span>
        ) : (
          <input
            value={storage}
            onChange={(e) => setStorage(e.target.value.replace(/[^\d]/g, ''))}
            onBlur={onStorageBlur}
            className={storageError ? 'invalid' : undefined}
            aria-invalid={storageError ? true : undefined}
            placeholder={`推荐 ${RECOMMEND_HW.storageGb}`}
            inputMode="numeric"
          />
        )}
        {storageError !== undefined && <div className="form-error">{storageError}</div>}
      </div>
    </div>
  );
}

export function parseHwFields(ram: string, cores: string, storage: string) {
  const ramGb = ram ? Number(ram) : NaN;
  return {
    ramMb: Number.isFinite(ramGb) && ramGb > 0 ? Math.round(ramGb * 1024) : undefined,
    cores: cores ? Number(cores) : undefined,
    // 输入的是客人机显示的 GB 档位，落盘要换算成对应的 GiB 分区
    storageGb: storage ? rawStorageGb(Number(storage)) : undefined,
  };
}

export function EditVmModal({
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.avdHardware(scope, avdName).then((r) => {
      if (r.ok && r.data) {
        setRam(r.data.ramMb ? gbFromMb(r.data.ramMb) : '');
        setCores(r.data.cores ? String(r.data.cores) : '');
        setStorage(r.data.storageGb ? String(displayedStorageGb(r.data.storageGb)) : '');
      } else if (r.ok) {
        setError('读取配置失败');
      } else {
        setError(r.error);
      }
    });
  }, [scope, avdName]);

  async function save() {
    // parseHardware 对越界值静默丢弃（保存"成功"但没改）：这里先显式校验
    const ramN = ram ? Number(ram) : NaN;
    if (ram && (!Number.isInteger(ramN) || ramN < 1 || ramN > 32)) {
      setError('内存需为 1–32 GB 的整数');
      return;
    }
    const coresN = cores ? Number(cores) : NaN;
    if (cores && (!Number.isInteger(coresN) || coresN < 1 || coresN > 16)) {
      setError('CPU 核数需为 1–16 的整数');
      return;
    }
    setSaving(true);
    setError('');
    // 容量入口暂缓：只提交内存与核数，避免把显示档位误写回分区
    const r = await api.setAvdHardware(scope, avdName, parseHwFields(ram, cores, ''));
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
      <HwFields
        ram={ram}
        setRam={setRam}
        cores={cores}
        setCores={setCores}
        storage={storage}
        setStorage={setStorage}
        storageReadOnly={storage ? `${storage} GB` : '—'}
      />
      {error && <div className="error-line" style={{ border: 'none', padding: '0 0 0 1px' }}>{error}</div>}
    </Modal>
  );
}
