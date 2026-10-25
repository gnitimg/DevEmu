import { useState } from 'react';
import type { EmuDevice, Scope } from '../api.ts';
import type { EnvStatus } from '../App.tsx';
import { VmPanel } from '../components/VmPanel.tsx';
import { ApkPanel } from '../components/ApkPanel.tsx';
import { RunsPanel } from '../components/RunsPanel.tsx';

export function ProjectDetail({
  projectId,
  onBack,
  emus,
  refreshEmus,
  env,
  onOpenSdkManage,
}: {
  projectId: string;
  onBack: () => void;
  emus: EmuDevice[];
  refreshEmus: () => void;
  env: EnvStatus | null;
  onOpenSdkManage?: () => void;
}) {
  const scope: Scope = { kind: 'project', projectId };
  const [runsKey, setRunsKey] = useState(0);

  return (
    <div>
      <button className="back-link" onClick={onBack}>
        ← 返回项目列表
      </button>
      <div className="page-head">
        <h1 className="page-title">{projectId}</h1>
        <span className="page-sub">虚拟机与数据仅本项目可见</span>
      </div>
      <VmPanel scope={scope} emus={emus} refreshEmus={refreshEmus} env={env} onOpenSdkManage={onOpenSdkManage} />
      <ApkPanel scope={scope} emus={emus} onRecorded={() => setRunsKey((k) => k + 1)} />
      <RunsPanel scope={scope} refreshKey={runsKey} />
    </div>
  );
}
