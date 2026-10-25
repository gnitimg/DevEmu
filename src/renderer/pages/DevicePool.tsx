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
}: {
  emus: EmuDevice[];
  refreshEmus: () => void;
  env: EnvStatus | null;
  onOpenSdkManage?: () => void;
}) {
  const scope: Scope = { kind: 'shared' };
  const [runsKey, setRunsKey] = useState(0);
  const [system, setSystem] = useState<System>('android');

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
            <VmPanel scope={scope} emus={emus} refreshEmus={refreshEmus} env={env} onOpenSdkManage={onOpenSdkManage} />
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
