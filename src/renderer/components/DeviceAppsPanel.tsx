import { useCallback, useEffect, useState } from 'react';
import { api, type EmuDevice, type Scope } from '../api.ts';
import { fmtTime } from './Modal.tsx';
import { InstallModal } from './InstallModal.tsx';
import { toast } from './Toast.tsx';
import type { ApkMeta } from '../../core/types.ts';

/**
 * 设备详情的「测试的应用」面板：Android 与 HarmonyOS 共用同一套结构与文案。
 * HarmonyOS 没有实例名→hdc serial 映射，安装一律走设备选择弹窗。
 */
export function DeviceAppsPanel({
  scope,
  os,
  running,
  serial,
  emus,
}: {
  scope: Scope;
  os: 'android' | 'harmonyos';
  running: boolean;
  /** Android 运行中设备的 adb serial */
  serial?: string;
  emus: EmuDevice[];
}) {
  const [apps, setApps] = useState<ApkMeta[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [apkBusy, setApkBusy] = useState('');
  const [pending, setPending] = useState<ApkMeta | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(() => {
    api.listApps(scope).then((r) => {
      if (r.ok) {
        setApps(r.data);
        setError('');
      } else setError(r.error);
    });
  }, [scope]);

  useEffect(reload, [reload]);

  const installable = (apk: ApkMeta) => (os === 'android' ? apk.kind !== 'hap' : apk.kind === 'hap');

  async function installDirect(apk: ApkMeta) {
    if (!serial) return;
    const r = await api.install(scope, apk.id, serial);
    if (!r.ok || !r.data.ok) {
      toast(
        `${apk.label ?? apk.fileName} 安装失败：${r.ok ? r.data.error ?? '未知错误' : r.error}`,
      );
    }
  }

  async function doImport() {
    setImporting(true);
    setError('');
    const d = await api.openApkDialog();
    if (d.ok && d.data) {
      const r = await api.importApk(scope, d.data);
      if (!r.ok) {
        toast(`导入失败：${r.error}`);
      } else {
        reload();
        if (running && installable(r.data)) {
          if (serial) {
            setInstalling(true);
            await installDirect(r.data);
            setInstalling(false);
          } else {
            setPending(r.data);
          }
        }
      }
    }
    setImporting(false);
  }

  async function apkAction(apk: ApkMeta, action: 'update' | 'remove') {
    setError('');
    if (action === 'update') {
      if (!serial) {
        setPending(apk);
        return;
      }
      setApkBusy(apk.id);
      await installDirect(apk);
      setApkBusy('');
      return;
    }
    const r = await api.removeApk(scope, apk.id);
    if (!r.ok) setError(r.error);
    reload();
    setApkBusy('');
  }

  return (
    <div className="section" style={{ marginBottom: 0 }}>
      <div className="section-head">
        <h2 className="section-title">测试的应用</h2>
        <div className="section-actions">
          <button className="btn" onClick={doImport} disabled={importing || installing}>
            {installing ? '安装中' : importing ? '导入中' : '导入'}
          </button>
        </div>
      </div>
      {apps === null ? (
        <div className="empty">
          <span className="spinner" />
        </div>
      ) : apps.length === 0 ? (
        <div className="empty">暂无应用</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 44 }}>编号</th>
              <th>应用名称</th>
              <th style={{ width: 70 }}>版本号</th>
              <th style={{ width: 90 }}>导入时间</th>
              <th style={{ width: 130 }}></th>
            </tr>
          </thead>
          <tbody>
            {apps.map((apk, i) => (
              <tr key={apk.id}>
                <td className="num">{i + 1}</td>
                <td title={apk.packageName ?? apk.fileName}>
                  <span className="chip" style={{ marginRight: 7 }}>
                    {apk.kind === 'hap' ? 'HAP' : 'APK'}
                  </span>
                  {apk.label ?? apk.fileName}
                </td>
                <td className="num">{apk.versionName ?? '—'}</td>
                <td className="num">{fmtTime(apk.importedAt)}</td>
                <td>
                  <div className="row-actions">
                    {installable(apk) && (
                      <button
                        className="btn btn-sm"
                        // HAP 安装一律走设备选择弹窗（InstallModal 可选任意在线
                        // HOS 设备），本机停止不应挡住入口；Android 直装依赖本
                        // 机 serial，本机停止时置灰引导先启动
                        disabled={(os === 'android' && !running) || apkBusy !== ''}
                        title={
                          os === 'android' && !running
                            ? '先启动设备'
                            : '安装到设备（覆盖更新）'
                        }
                        onClick={() => apkAction(apk, 'update')}
                      >
                        {apkBusy === apk.id ? '更新中' : '更新'}
                      </button>
                    )}
                    <button
                      className="btn btn-sm btn-danger"
                      disabled={apkBusy !== ''}
                      onClick={() => {
                        if (window.confirm(`从库中移除 ${apk.fileName}？`)) apkAction(apk, 'remove');
                      }}
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && <div className="error-line">{error}</div>}
      {pending && (
        <InstallModal apk={pending} emus={emus} scope={scope} onClose={() => setPending(null)} />
      )}
    </div>
  );
}
