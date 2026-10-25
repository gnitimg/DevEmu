import { useCallback, useEffect, useState } from 'react';
import { api, type EmuDevice } from './api.ts';
import { Projects } from './pages/Projects.tsx';
import { ProjectDetail } from './pages/ProjectDetail.tsx';
import { DevicePool } from './pages/DevicePool.tsx';
import { Settings } from './pages/Settings.tsx';
import type { ProjectMeta } from '../core/types.ts';

type Page = 'projects' | 'devices' | 'settings';

export interface EnvStatus {
  settings: { dataRoot: string; sdkPath?: string; javaPath?: string; gpuMode?: string };
  sdk: { root: string } | null;
  java: string | null;
  images: { pkg: string; api: number; tag: string; abi: string }[];
}

export function App() {
  const [page, setPage] = useState<Page>('projects');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [env, setEnv] = useState<EnvStatus | null>(null);
  const [emus, setEmus] = useState<EmuDevice[]>([]);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [sideOpen, setSideOpen] = useState(true);
  const [projectsOpen, setProjectsOpen] = useState(true);

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

  // 侧栏项目列表跟随数据变化（新建/删除后自动同步）
  useEffect(() => {
    const refresh = () =>
      api.listProjects().then((r) => {
        if (r.ok) setProjects(r.data);
      });
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, []);

  const goto = (p: Page) => {
    setPage(p);
    if (p === 'projects') setProjectId(null);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <button className="brand" onClick={() => setSideOpen((v) => !v)} title={sideOpen ? '收起侧栏' : '展开侧栏'}>
          <span className="brand-logo">DE</span>
          <span className="brand-name">DevEmu</span>
          <svg
            className={`brand-chev${sideOpen ? '' : ' flip'}`}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10 3.5 5.5 8l4.5 4.5" />
          </svg>
        </button>
        <div className="topbar-flex" />
        {env && (
          <button
            className={`sdk-chip${env.sdk ? '' : ' err'}`}
            onClick={() => goto('settings')}
            title={env.sdk ? env.sdk.root : '未检测到 Android SDK，点击前往设置'}
          >
            <span className={`dot${env.sdk ? ' on' : ''}`} />
            {env.sdk ? 'SDK 就绪' : 'SDK 未检测到'}
          </button>
        )}
      </header>
      <div className="body">
        <aside className={`sidebar${sideOpen ? '' : ' collapsed'}`}>
          <div className="side-label">工作目录</div>
          <SideItem
            icon={
              <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5v6A1.5 1.5 0 0 1 12.5 14h-9A1.5 1.5 0 0 1 2 12.5v-8Z" />
            }
            label="项目"
            active={page === 'projects'}
            expanded={projectsOpen}
            hasChildren
            sideOpen={sideOpen}
            onToggle={() => {
              if (!sideOpen) {
                setSideOpen(true);
                setProjectsOpen(true);
                goto('projects');
              } else {
                setProjectsOpen((v) => !v);
                goto('projects');
              }
            }}
          >
            {projects.map((p) => (
              <button
                key={p.id}
                className={`side-child${page === 'projects' && projectId === p.id ? ' active' : ''}`}
                onClick={() => {
                  setPage('projects');
                  setProjectId(p.id);
                }}
                title={p.name}
              >
                {p.name}
              </button>
            ))}
            {projects.length === 0 && <div className="side-child side-child-empty">暂无项目</div>}
          </SideItem>
          <SideItem
            icon={
              <>
                <rect x="5" y="2" width="6" height="12" rx="1.2" />
                <path d="M7.5 12h1" />
              </>
            }
            label="设备池"
            active={page === 'devices'}
            sideOpen={sideOpen}
            onToggle={() => {
              if (!sideOpen) setSideOpen(true);
              goto('devices');
            }}
          />
          <SideItem
            icon={
              <>
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </>
            }
            viewBox="0 0 24 24"
            label="设置"
            active={page === 'settings'}
            sideOpen={sideOpen}
            onToggle={() => {
              if (!sideOpen) setSideOpen(true);
              goto('settings');
            }}
          />
        </aside>
        <main className="content">
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
    </div>
  );
}

function SideItem({
  icon,
  label,
  active,
  expanded,
  hasChildren,
  sideOpen,
  viewBox = '0 0 16 16',
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  expanded?: boolean;
  hasChildren?: boolean;
  sideOpen: boolean;
  viewBox?: string;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className={`side-group${active ? ' group-active' : ''}`}>
      <button
        className={`side-item${active ? ' active' : ''}`}
        onClick={onToggle}
        title={sideOpen ? label : label}
      >
        <svg
          viewBox={viewBox}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {icon}
        </svg>
        <span className="side-item-label">{label}</span>
        {hasChildren && sideOpen && (
          <svg
            className={`side-chev${expanded ? ' open' : ''}`}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 3.5 10.5 8 6 12.5" />
          </svg>
        )}
      </button>
      {children && <div className={`side-children${expanded && sideOpen ? '' : ' hidden'}`}>{children}</div>}
    </div>
  );
}
