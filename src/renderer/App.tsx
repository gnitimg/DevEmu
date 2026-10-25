import { useCallback, useEffect, useState } from 'react';
import { api, type EmuDevice } from './api.ts';
import { Projects } from './pages/Projects.tsx';
import { ProjectDetail } from './pages/ProjectDetail.tsx';
import { DevicePool } from './pages/DevicePool.tsx';
import { Settings } from './pages/Settings.tsx';

type Page = 'projects' | 'devices' | 'settings';

export interface EnvStatus {
  settings: { dataRoot: string; sdkPath?: string; javaPath?: string };
  sdk: { root: string } | null;
  java: string | null;
  images: { pkg: string; api: number; tag: string; abi: string }[];
}

export function App() {
  const [page, setPage] = useState<Page>('projects');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [env, setEnv] = useState<EnvStatus | null>(null);
  const [emus, setEmus] = useState<EmuDevice[]>([]);

  const refreshEnv = useCallback(() => {
    api.envStatus().then((r) => {
      if (r.ok) setEnv(r.data);
    });
  }, []);

  const refreshEmus = useCallback(() => {
    api.listEmulators().then((r) => {
      if (r.ok) setEmus(r.data);
    });
  }, []);

  useEffect(() => {
    refreshEnv();
    refreshEmus();
    const timer = setInterval(refreshEmus, 3000);
    return () => clearInterval(timer);
  }, [refreshEnv, refreshEmus]);

  return (
    <div className="app">
      <aside className="nav">
        <div className="nav-logo" title="DevEmu">
          DE
        </div>
        <NavBtn active={page === 'projects'} title="项目" onClick={() => setPage('projects')}>
          <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5v6A1.5 1.5 0 0 1 12.5 14h-9A1.5 1.5 0 0 1 2 12.5v-8Z" />
        </NavBtn>
        <NavBtn active={page === 'devices'} title="设备池" onClick={() => setPage('devices')}>
          <rect x="5" y="2" width="6" height="12" rx="1.2" />
          <path d="M7.5 12h1" />
        </NavBtn>
        <div className="nav-flex" />
        <NavBtn active={page === 'settings'} title="设置" onClick={() => setPage('settings')}>
          <circle cx="8" cy="8" r="2" />
          <path d="M8 2.5v1.6M8 11.9v1.6M2.5 8h1.6M11.9 8h1.6M4.2 4.2l1.1 1.1M10.7 10.7l1.1 1.1M11.8 4.2l-1.1 1.1M5.3 10.7l-1.1 1.1" />
        </NavBtn>
      </aside>
      <main className="content">
        {env && !env.sdk && page !== 'settings' && (
          <div className="banner-error" onClick={() => setPage('settings')}>
            未检测到 Android SDK，点击前往设置配置路径
          </div>
        )}
        {page === 'projects' &&
          (projectId === null ? (
            <Projects onOpen={setProjectId} />
          ) : (
            <ProjectDetail
              projectId={projectId}
              onBack={() => setProjectId(null)}
              emus={emus}
              refreshEmus={refreshEmus}
              env={env}
              refreshEnv={refreshEnv}
            />
          ))}
        {page === 'devices' && (
          <DevicePool emus={emus} refreshEmus={refreshEmus} env={env} refreshEnv={refreshEnv} />
        )}
        {page === 'settings' && <Settings env={env} refreshEnv={refreshEnv} />}
      </main>
    </div>
  );
}

function NavBtn({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button className={`nav-btn${active ? ' active' : ''}`} title={title} onClick={onClick}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}
