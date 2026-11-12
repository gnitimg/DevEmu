import { useEffect, useState } from 'react';
import { api, type EmuDevice, type Scope } from '../api.ts';
import type { ApkMeta } from '../../core/types.ts';
import { Modal } from './Modal.tsx';
import { toast } from './Toast.tsx';

type Device = { type: 'android' | 'harmonyos'; serial: string; label: string };

export function InstallModal({
  apk,
  emus,
  scope,
  onClose,
}: {
  apk: ApkMeta;
  emus: EmuDevice[];
  scope: Scope;
  onClose: () => void;
}) {
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  // 在线设备都从 emus（3 秒轮询）派生：弹窗打开期间新上线的设备也能选到，
  // 不再打开时只查一次
  const android: Device[] = emus
    .filter((e) => e.state === 'device' && e.avdName && e.type !== 'harmonyos')
    .map((e) => ({ type: 'android' as const, serial: e.serial, label: e.avdName! }));
  const harmony: Device[] = emus
    .filter((e) => e.state === 'device' && e.type === 'harmonyos')
    .map((e) => ({ type: 'harmonyos' as const, serial: e.serial, label: e.serial }));

  const devices: Device[] = [...android, ...harmony];
  const usable = devices.filter((d) => (apk.kind === 'hap' ? d.type === 'harmonyos' : d.type === 'android'));
  const selected = usable.find((e) => e.serial === target);

  useEffect(() => {
    if ((!target || !selected) && usable.length > 0) setTarget(usable[0]!.serial);
  }, [target, selected, usable]);

  async function run(mode: 'install' | 'install-launch') {
    if (!selected) return;
    setBusy(mode);
    setError('');
    const installRes = await api.install(scope, apk.id, selected.serial);
    if (!installRes.ok || !installRes.data.ok) {
      const msg = installRes.ok ? installRes.data.error ?? '安装失败' : installRes.error;
      setError(`${apk.label ?? apk.fileName}：${msg}`);
      setBusy('');
      return;
    }
    if (mode === 'install-launch') {
      const launchRes = await api.launch(scope, apk.id, selected.serial);
      if (!launchRes.ok || !launchRes.data.ok) {
        const msg = launchRes.ok ? launchRes.data.error ?? '启动失败' : launchRes.error;
        setError(`${apk.label ?? apk.fileName}：${msg}`);
        setBusy('');
        return;
      }
    }
    setBusy('');
    toast(`${apk.label ?? apk.fileName} 已安装到 ${selected.label}`, 'ok');
    onClose();
  }

  // 安装/启动请求已发出且无法回滚：期间不允许关窗，避免界面看起来"已取消"
  // 而后续步骤继续执行
  const close = () => {
    if (busy === '') onClose();
  };

  return (
    <Modal title="安装到设备" className="install-modal" onClose={close} footer={
      <>
        <button className="btn" disabled={busy !== ''} onClick={close}>
          取消
        </button>
        <button className="btn" disabled={!selected || busy !== ''} onClick={() => run('install')}>
          {busy === 'install' ? '安装中' : '仅安装'}
        </button>
        <button className="btn btn-primary" disabled={!selected || busy !== ''} onClick={() => run('install-launch')}>
          {busy === 'install-launch' ? '安装并启动中' : '安装并启动'}
        </button>
      </>
    }>
      <div className="install-apk-line">
        <span className="chip" style={{ marginRight: 7 }}>{apk.kind === 'hap' ? 'HAP' : 'APK'}</span>
        <span className="install-apk-name">{apk.label ?? apk.fileName}</span>
        <span className="mono" style={{ color: 'var(--text-2)', fontSize: 11.5 }}>
          {apk.packageName ?? ''} {apk.versionName ? `· ${apk.versionName}` : ''}
        </span>
      </div>
      {usable.length === 0 ? (
        <div className="empty" style={{ padding: '18px 0' }}>
          {apk.kind === 'hap' ? '没有 HarmonyOS 在线设备' : '先启动一台虚拟机'}
        </div>
      ) : (
        usable.map((e) => (
          <button
            key={e.serial}
            className={`device-option${target === e.serial ? ' on' : ''}`}
            onClick={() => setTarget(e.serial)}
          >
            <span className={`dot${e.type === 'android' ? ' on' : ' hm'}`} />
            <span className="device-option-name">{e.label}</span>
            <span className="chip" style={{ marginRight: 0 }}>{e.type === 'android' ? 'Android' : 'HarmonyOS'}</span>
            <span className="mono" style={{ color: 'var(--text-3)', fontSize: 11, marginLeft: 7 }}>
              {e.serial}
            </span>
          </button>
        ))
      )}
      {error && <div className="error-line" style={{ border: 'none', padding: '4px 0 0' }}>{error}</div>}
    </Modal>
  );
}
