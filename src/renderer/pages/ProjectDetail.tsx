import { useMemo } from 'react';
import type { EmuDevice, Scope } from '../api.ts';
import type { EnvStatus } from '../App.tsx';
import { VmPanel } from '../components/VmPanel.tsx';
import { ApkPanel } from '../components/ApkPanel.tsx';
import { CrashesPanel } from '../components/CrashesPanel.tsx';

export function ProjectDetail({
  projectId,
  name,
  onBack,
  emus,
  refreshEmus,
  env,
  onOpenSdkManage,
  onOpenVm,
}: {
  projectId: string;
  /** 展示用项目名：id 是清洗后的机器串（project-xxx），直接露出无意义 */
  name: string;
  onBack: () => void;
  emus: EmuDevice[];
  refreshEmus: () => void;
  env: EnvStatus | null;
  onOpenSdkManage?: () => void;
  onOpenVm?: (name: string) => void;
}) {
  // 按项目 id memoize：scope 身份稳定，下游列表回调不随渲染重建
  const scope = useMemo<Scope>(() => ({ kind: 'project', projectId }), [projectId]);

  return (
    <div>
      <button className="back-link" onClick={onBack}>
        ← 返回项目列表
      </button>
      <div className="page-head">
        <h1 className="page-title">{name}</h1>
      </div>
      <VmPanel
        scope={scope}
        emus={emus}
        refreshEmus={refreshEmus}
        env={env}
        onOpenSdkManage={onOpenSdkManage}
        onOpenVm={onOpenVm}
      />
      <ApkPanel scope={scope} emus={emus} />
      <CrashesPanel scope={scope} os="android" />
    </div>
  );
}
