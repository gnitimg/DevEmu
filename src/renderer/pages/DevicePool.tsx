import { useState } from 'react';
import type { EmuDevice, Scope } from '../api.ts';
import type { EnvStatus } from '../App.tsx';
import { VmPanel } from '../components/VmPanel.tsx';
import { HosVmPanel } from '../components/HosVmPanel.tsx';
import { ApkPanel } from '../components/ApkPanel.tsx';
import { RunsPanel } from '../components/RunsPanel.tsx';
import { Segmented } from '../components/Segmented.tsx';

type System = 'android' | 'harmonyos';

const SYSTEMS: { id: System; label: string }[] = [
  { id: 'android', label: 'Android' },
  { id: 'harmonyos', label: 'HarmonyOS' },
];

// 模块级单例：scope 对象身份稳定，下游 useCallback([scope]) 才不会每轮重渲染都重建
const SHARED_SCOPE: Scope = { kind: 'shared' };

export function DevicePool({
  emus,
  refreshEmus,
  env,
  system,
  onSystem,
  onOpenSdkManage,
  onOpenVm,
}: {
  emus: EmuDevice[];
  refreshEmus: () => void;
  env: EnvStatus | null;
  /** 页签由 App 持有：从详情返回时保持进入前的系统 */
  system: System;
  onSystem: (system: System) => void;
  onOpenSdkManage?: (system?: 'android' | 'harmonyos') => void;
  onOpenVm?: (name: string, system: System) => void;
}) {
  const scope = SHARED_SCOPE;
  const [runsKey, setRunsKey] = useState(0);

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">设备池</h1>
        <div className="page-actions">
          <Segmented options={SYSTEMS} value={system} onChange={onSystem} />
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
              onOpenVm={(name) => onOpenVm?.(name, 'android')}
            />
            <ApkPanel scope={scope} emus={emus} onRecorded={() => setRunsKey((k) => k + 1)} />
            <RunsPanel scope={scope} refreshKey={runsKey} />
          </>
        ) : (
          <>
            <HosVmPanel
              env={env}
              refreshEmus={refreshEmus}
              onOpenSdkManage={onOpenSdkManage}
              onOpenVm={(name) => onOpenVm?.(name, 'harmonyos')}
            />
            <ApkPanel scope={scope} emus={emus} onRecorded={() => setRunsKey((k) => k + 1)} />
            <RunsPanel scope={scope} refreshKey={runsKey} />
          </>
        )}
      </div>
    </div>
  );
}
