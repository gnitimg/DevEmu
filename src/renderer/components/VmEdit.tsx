import { useEffect, useState } from 'react';
import { api, type Scope } from '../api.ts';
import { Modal } from './Modal.tsx';

export const RECOMMEND_HW = { ramMb: 2048, cores: 4, storageGb: 6 };

export function HwFields({
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

export function parseHwFields(ram: string, cores: string, storage: string) {
  return {
    ramMb: ram ? Number(ram) : undefined,
    cores: cores ? Number(cores) : undefined,
    storageGb: storage ? Number(storage) : undefined,
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
      {error && <div className="error-line" style={{ border: 'none', padding: '0 0 0 1px' }}>{error}</div>}
    </Modal>
  );
}
