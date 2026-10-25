import { useState } from 'react';
import type { EmuDevice, Scope } from '../api.ts';
import type { EnvStatus } from '../App.tsx';
import { VmPanel } from '../components/VmPanel.tsx';
import { ApkPanel } from '../components/ApkPanel.tsx';
import { RunsPanel } from '../components/RunsPanel.tsx';

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

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">设备池</h1>
        <span className="page-sub">公共设备，任意 APK 可安装测试</span>
      </div>
      <VmPanel scope={scope} emus={emus} refreshEmus={refreshEmus} env={env} refreshEnv={refreshEnv} />
      <ApkPanel scope={scope} emus={emus} onRecorded={() => setRunsKey((k) => k + 1)} />
      <RunsPanel scope={scope} refreshKey={runsKey} />
    </div>
  );
}
