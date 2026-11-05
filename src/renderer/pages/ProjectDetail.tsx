import { useMemo, useState } from 'react';
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
  onOpenVm,
}: {
  projectId: string;
  onBack: () => void;
  emus: EmuDevice[];
  refreshEmus: () => void;
  env: EnvStatus | null;
  onOpenSdkManage?: () => void;
  onOpenVm?: (name: string) => void;
}) {
  // 按项目 id memoize：scope 身份稳定，下游列表回调不随渲染重建
  const scope = useMemo<Scope>(() => ({ kind: 'project', projectId }), [projectId]);
  const [runsKey, setRunsKey] = useState(0);

  return (
    <div>
      <button className="back-link" onClick={onBack}>
        ← 返回项目列表
      </button>
      <div className="page-head">
        <h1 className="page-title">{projectId}</h1>
      </div>
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
    </div>
  );
}
