import { useState } from 'react';
import type { EmuDevice, Scope } from '../api.ts';
import type { EnvStatus } from '../App.tsx';
import { VmPanel } from '../components/VmPanel.tsx';
import { ApkPanel } from '../components/ApkPanel.tsx';
import { RunsPanel } from '../components/RunsPanel.tsx';
import { Segmented } from '../components/Segmented.tsx';

type System = 'android' | 'harmonyos';

const SYSTEMS: { id: System; label: string }[] = [
  { id: 'android', label: 'Android' },
  { id: 'harmonyos', label: 'HarmonyOS' },
];

export function DevicePool({
  emus,
  refreshEmus,
  env,
  onOpenSdkManage,
  onOpenVm,
}: {
  emus: EmuDevice[];
  refreshEmus: () => void;
  env: EnvStatus | null;
  onOpenSdkManage?: () => void;
  onOpenVm?: (name: string) => void;
}) {
  const scope: Scope = { kind: 'shared' };
  const [runsKey, setRunsKey] = useState(0);
  const [system, setSystem] = useState<System>('android');

  const harmonyDevices = emus.filter((e) => e.type === 'harmonyos');

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">设备池</h1>
        <div className="page-actions">
          <Segmented options={SYSTEMS} value={system} onChange={setSystem} />
        </div>
      </div>
      <div key={system} className="sys-page">
        {system === 'android' ? (
          <>
            <VmPanel
              scope={scope}
              emus={emus}
              refreshEmus={refreshEmus}
              env={env}
              onOpenSdkManage={onOpenSdkManage}
              onOpenVm={onOpenVm}
            />
            <ApkPanel scope={scope} emus={emus} onRecorded={() => setRunsKey((k) => k + 1)} />
            <RunsPanel scope={scope} refreshKey={runsKey} />
          </>
        ) : (
          <>
            <div className="section" style={{ marginBottom: 16 }}>
              <div className="section-head">
                <h2 className="section-title">HarmonyOS 设备</h2>
                {env?.harmony && <span className="section-count">{harmonyDevices.length}</span>}
                <div className="section-actions">
                  <button className="btn" onClick={refreshEmus}>
                    刷新
                  </button>
                </div>
              </div>
              {!env?.harmony ? (
                <div className="empty">未检测到 HarmonyOS SDK，请在设置的 SDK 分区配置</div>
              ) : harmonyDevices.length === 0 ? (
                <div className="empty">暂无在线设备（hdc list targets）</div>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 90 }}>状态</th>
                      <th>设备序列号</th>
                    </tr>
                  </thead>
                  <tbody>
                    {harmonyDevices.map((d) => (
                      <tr key={d.serial}>
                        <td>
                          <span className="dot on" />
                          在线
                        </td>
                        <td className="mono">{d.serial}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <ApkPanel scope={scope} emus={emus} onRecorded={() => setRunsKey((k) => k + 1)} />
            <RunsPanel scope={scope} refreshKey={runsKey} />
          </>
        )}
      </div>
    </div>
  );
}
