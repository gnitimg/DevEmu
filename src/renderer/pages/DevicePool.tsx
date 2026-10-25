import { useState } from 'react';
import type { EmuDevice, Scope } from '../api.ts';
import type { EnvStatus } from '../App.tsx';
import { VmPanel } from '../components/VmPanel.tsx';
import { ApkPanel } from '../components/ApkPanel.tsx';
import { RunsPanel } from '../components/RunsPanel.tsx';

type System = 'android' | 'harmonyos';

const SYSTEMS: { id: System; label: string }[] = [
  { id: 'android', label: 'Android' },
  { id: 'harmonyos', label: 'HarmonyOS' },
];

export function DevicePool({
  emus,
  refreshEmus,
  env,
  refreshEnv,
}: {
  emus: EmuDevice[];
  refreshEmus: () => void;
  env: EnvStatus | null;
  refreshEnv: () => void;
}) {
  const scope: Scope = { kind: 'shared' };
  const [runsKey, setRunsKey] = useState(0);
  const [system, setSystem] = useState<System>('android');
  const activeIdx = SYSTEMS.findIndex((s) => s.id === system);

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">设备池</h1>
        <span className="page-sub">公共设备，任意 APK 可安装测试</span>
        <div className="page-actions">
          <div className="sys-switch" role="tablist">
            <div className="sys-pill" style={{ transform: `translateX(${activeIdx * 100}%)` }} />
            {SYSTEMS.map((s) => (
              <button
                key={s.id}
                className={`sys-btn${system === s.id ? ' on' : ''}`}
                onClick={() => setSystem(s.id)}
                role="tab"
                aria-selected={system === s.id}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div key={system} className="sys-page">
        {system === 'android' ? (
          <>
            <VmPanel scope={scope} emus={emus} refreshEmus={refreshEmus} env={env} refreshEnv={refreshEnv} />
            <ApkPanel scope={scope} emus={emus} onRecorded={() => setRunsKey((k) => k + 1)} />
            <RunsPanel scope={scope} refreshKey={runsKey} />
          </>
        ) : (
          <div className="section">
            <div className="section-head">
              <h2 className="section-title">HarmonyOS 设备</h2>
            </div>
            <div className="empty">
              HarmonyOS 支持正在开发中，将经 DevEco 工具链与 hdc 接入本地模拟器
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
