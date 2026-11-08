import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import logoUrl from '../../assets/icon.png';
import { api, onAutoInstall, onDownloadsChanged, onEnvChanged, onHuaweiChanged, onWinMaximized, type DownloadItem, type EmuDevice, type HarmonyInfo, type Scope } from './api.ts';
import { Projects } from './pages/Projects.tsx';
import { ProjectDetail } from './pages/ProjectDetail.tsx';
import { DevicePool } from './pages/DevicePool.tsx';
import { DeviceDetail } from './pages/DeviceDetail.tsx';
import { HosDeviceDetail } from './pages/HosDeviceDetail.tsx';
import { Downloads } from './pages/Downloads.tsx';
import { Settings } from './pages/Settings.tsx';
import { Toaster, toast } from './components/Toast.tsx';
import { UpdatePrompt } from './components/UpdatePrompt.tsx';
import { FlyLayer } from './components/Fly.tsx';
import type { AvdInfo, HosAvd, ProjectMeta, Settings as SettingsData } from '../core/types.ts';

type DeviceSystem = 'android' | 'harmonyos';

type Page = 'projects' | 'devices' | 'device-detail' | 'downloads' | 'settings';

export interface EnvStatus {
  settings: SettingsData;
  sdk: { root: string } | null;
  java: string | null;
  harmony: HarmonyInfo | null;
  version: string;
  images: { pkg: string; api: number; tag: string; abi: string }[];
}

const ss = {
  get: (k: string, d: string) => sessionStorage.getItem(k) ?? d,
  set: (k: string, v: string) => sessionStorage.setItem(k, v),
  del: (k: string) => sessionStorage.removeItem(k),
};

const dlId = (d: DownloadItem) => `${d.pkg}#${d.startedAt}`;

export function App() {
  // 导航状态持久化：刷新/整页重载后回到原页面，不跳首页
  const [page, setPage] = useState<Page>(() => ss.get('de.page', 'projects') as Page);
  const [projectId, setProjectId] = useState<string | null>(() => sessionStorage.getItem('de.projectId'));
  const [deviceName, setDeviceName] = useState<string | null>(() => sessionStorage.getItem('de.deviceName'));
  // 详情页所属作用域：'shared' 或项目 id
  const [deviceScope, setDeviceScope] = useState<'shared' | string>(() => ss.get('de.deviceScope', 'shared'));
  // 详情页所属系统：决定渲染 Android 还是 HarmonyOS 详情，同时记忆设备池页签
  const [deviceSystem, setDeviceSystem] = useState<DeviceSystem>(() =>
    ss.get('de.deviceSystem', 'android') === 'harmonyos' ? 'harmonyos' : 'android',
  );
  const [env, setEnv] = useState<EnvStatus | null>(null);
  const [emus, setEmus] = useState<EmuDevice[]>([]);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [sharedAvds, setSharedAvds] = useState<AvdInfo[]>([]);
  const [hosAvds, setHosAvds] = useState<HosAvd[]>([]);
  const [sideOpen, setSideOpen] = useState(() => sessionStorage.getItem('de.sideOpen') !== '0');
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [devicesOpen, setDevicesOpen] = useState(true);
  // 分区恢复时兼容旧值：'download' 已并入 'network'
  const [settingsSection, setSettingsSection] = useState(() => {
    const saved = ss.get('de.settingsSection', 'storage');
    return saved === 'download' ? 'network' : saved;
  });
  const [maximized, setMaximized] = useState(false);
  // SDK 设置页默认展示的系统页签：从 HarmonyOS 设备池进入时直达 HarmonyOS
  const [sdkSystem, setSdkSystem] = useState<'android' | 'harmonyos'>('android');
  const [dlActive, setDlActive] = useState<DownloadItem[]>([]);
  // null 表示尚未查完登录状态，避免闪卡片
  const [huaweiLogin, setHuaweiLogin] = useState<boolean | null>(null);

  useEffect(() => {
    ss.set('de.page', page);
    ss.set('de.deviceScope', deviceScope);
    ss.set('de.deviceSystem', deviceSystem);
    ss.set('de.settingsSection', settingsSection);
    ss.set('de.sideOpen', sideOpen ? '1' : '0');
    if (projectId) ss.set('de.projectId', projectId);
    else ss.del('de.projectId');
    if (deviceName) ss.set('de.deviceName', deviceName);
    else ss.del('de.deviceName');
  }, [page, projectId, deviceName, deviceScope, deviceSystem, settingsSection, sideOpen]);

  useEffect(() => {
    api.winIsMaximized().then((r) => {
      if (r.ok) setMaximized(r.data);
    });
    return onWinMaximized(setMaximized);
  }, []);

  // 华为账号登录状态：侧栏提醒卡片跟随（登录窗口里登录成功后自动消失）
  useEffect(() => {
    api
      .huaweiState()
      .then((r) => {
        if (r.ok) setHuaweiLogin(r.data.loggedIn);
      })
      .catch(() => setHuaweiLogin(false));
    return onHuaweiChanged(setHuaweiLogin);
  }, []);

  // 侧栏胶囊总进度：所有进行中任务（含排队）已下载 / 总大小
  // 下载状态统一在此提示：开始（含排队）、完成、失败、取消；首帧只建立基线，
  // 否则重放历史会重复弹窗
  const seenActiveRef = useRef<Set<string> | null>(null);
  const seenFinishedRef = useRef<Set<string> | null>(null);
  useEffect(
    () =>
      onDownloadsChanged((s) => {
        setDlActive(s.active);
        const prevActive = seenActiveRef.current;
        seenActiveRef.current = new Set(s.active.map(dlId));
        const prevFinished = seenFinishedRef.current;
        seenFinishedRef.current = new Set(s.finished.map(dlId));
        if (!prevActive || !prevFinished) return;
        for (const d of s.active) {
          if (prevActive.has(dlId(d))) continue;
          toast(`${d.desc} ${d.state === 'queued' ? '已加入下载队列' : '开始下载'}`, 'ok');
        }
        for (const d of s.finished) {
          if (prevFinished.has(dlId(d))) continue;
          if (d.state === 'done') toast(`${d.desc} 下载完成`, 'ok');
          else if (d.state === 'failed') toast(`${d.desc} 失败：${d.error ?? '未知错误'}`);
          else toast(`${d.desc} 已取消`, 'ok');
        }
      }),
    [],
  );
  const dlTotal = dlActive.reduce((a, d) => a + d.total, 0);
  const dlDone = dlActive.reduce((a, d) => a + d.downloaded, 0);
  // 文件任务用字节；sdkmanager 任务无字节量，用阶段化显示进度均值
  const dlPct =
    dlTotal > 0
      ? Math.min(100, Math.round((dlDone / dlTotal) * 100))
      : dlActive.length > 0
        ? Math.round(dlActive.reduce((a, d) => a + d.percent, 0) / dlActive.length)
        : 0;

  // scope 按 deviceScope memoize：内联对象每次渲染都是新身份，
  // 会把 DeviceDetail 内 useCallback([scope]) 的列表回调每轮重建、反复重拉
  const detailScope = useMemo<Scope>(
    () =>
      deviceScope === 'shared'
        ? { kind: 'shared' }
        : { kind: 'project', projectId: deviceScope },
    [deviceScope],
  );

  // 设备启动完成后的自动补装结果：失败逐个提示，成功汇总一条
  useEffect(
    () =>
      onAutoInstall((p) => {
        const failed = p.results.filter((r) => !r.ok);
        for (const f of failed) toast(`${f.label} 自动安装失败：${f.error ?? '未知错误'}`);
        const installed = p.results.length - failed.length;
        if (installed > 0) toast(`已自动安装 ${installed} 个应用${failed.length ? `，${failed.length} 个失败` : ''}`, 'ok');
      }),
    [],
  );

  const goto = (p: Page) => {
    setPage(p);
    if (p === 'projects') setProjectId(null);
  };

  const openSdkManage = (system: 'android' | 'harmonyos' = 'android') => {
    setSdkSystem(system);
    setSettingsSection('sdk');
    goto('settings');
  };

  const openDevice = (
    name: string,
    scope: 'shared' | string,
    system: DeviceSystem = 'android',
  ) => {
    setDeviceName(name);
    setDeviceScope(scope);
    setDeviceSystem(system);
    setPage('device-detail');
  };

  const refreshEnv = useCallback(() => {
    api.envStatus().then((r) => {
      if (r.ok) setEnv(r.data);
    });
  }, []);

  // 在飞保护：一轮超过 3 秒（PowerShell/hdc 慢）时不叠发起下一轮，
  // 避免子进程与请求并发堆积
  const emusInFlight = useRef(false);
  const refreshEmus = useCallback(() => {
    if (emusInFlight.current) return;
    emusInFlight.current = true;
    api
      .listEmulators()
      .then((r) => {
        if (r.ok) setEmus(r.data);
      })
      .finally(() => {
        emusInFlight.current = false;
      });
  }, []);

  useEffect(() => {
    refreshEnv();
    refreshEmus();
    const timer = setInterval(refreshEmus, 3000);
    return () => clearInterval(timer);
  }, [refreshEnv, refreshEmus]);

  // 环境安装完成：刷新环境探测（结果提示由下载状态统一弹窗）
  useEffect(() => onEnvChanged(() => refreshEnv()), [refreshEnv]);

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

  // 侧栏设备池设备列表同步
  useEffect(() => {
    const refresh = () =>
      api.listAvds({ kind: 'shared' }).then((r) => {
        if (r.ok) setSharedAvds(r.data);
      });
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, []);

  // 侧栏 HarmonyOS 虚拟机同步：SDK 未就绪时不调用（每次都要 spawn Emulator.exe）
  const hasHos = env?.harmony !== null && env?.harmony !== undefined;
  useEffect(() => {
    if (!hasHos) {
      setHosAvds([]);
      return;
    }
    let live = true;
    const refresh = () =>
      api.hosList().then((r) => {
        if (live && r.ok) setHosAvds(r.data);
      });
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [hasHos]);

  return (
    <div className="shell">
      <Toaster />
      <FlyLayer />
      <UpdatePrompt />
      <header className="topbar">
        <button className="brand" onClick={() => setSideOpen((v) => !v)} title={sideOpen ? '收起侧栏' : '展开侧栏'}>
          <img className="brand-logo" src={logoUrl} alt="DevEmu" draggable={false} />
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
        <div className="winctl">
          <button className="winctl-btn" title="最小化" onClick={() => void api.winMinimize()}>
            <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <path d="M0 5.5h10" />
            </svg>
          </button>
          <button className="winctl-btn" title={maximized ? '还原' : '最大化'} onClick={() => void api.winToggleMaximize()}>
            {maximized ? (
              <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                <rect x="0.5" y="2.5" width="7" height="7" />
                <path d="M2.8 2.2V0.5h6.7v6.7H7.8" />
              </svg>
            ) : (
              <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                <rect x="0.5" y="0.5" width="9" height="9" />
              </svg>
            )}
          </button>
          <button className="winctl-btn winctl-close" title="关闭" onClick={() => void api.winClose()}>
            <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <path d="M0 0l10 10M10 0L0 10" />
            </svg>
          </button>
        </div>
      </header>
      <div className="body">
        <aside className={`sidebar${sideOpen ? '' : ' collapsed'}`}>
          <div className="side-scroll">
          <SideItem
            icon={
              <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5v6A1.5 1.5 0 0 1 12.5 14h-9A1.5 1.5 0 0 1 2 12.5v-8Z" />
            }
            label="项目"
            active={page === 'projects' && projectId === null}
            indicated={(page === 'projects' && projectId !== null) || (page === 'device-detail' && deviceScope !== 'shared')}
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
                className={`side-child${
                  (page === 'projects' && projectId === p.id) || (page === 'device-detail' && deviceScope === p.id)
                    ? ' active'
                    : ''
                }`}
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
            indicated={page === 'device-detail' && deviceScope === 'shared'}
            expanded={devicesOpen}
            hasChildren
            sideOpen={sideOpen}
            onToggle={() => {
              if (!sideOpen) {
                setSideOpen(true);
                setDevicesOpen(true);
                setPage('devices');
              } else {
                setDevicesOpen((v) => !v);
                setPage('devices');
                setDeviceName(null);
              }
            }}
          >
            {sharedAvds.map((a) => (
              <button
                key={a.name}
                className={`side-child${
                  page === 'device-detail' &&
                  deviceScope === 'shared' &&
                  deviceSystem === 'android' &&
                  deviceName === a.name
                    ? ' active'
                    : ''
                }`}
                onClick={() => openDevice(a.name, 'shared', 'android')}
                title={a.name}
              >
                {a.name}
              </button>
            ))}
            {hosAvds.map((a) => (
              <button
                key={`hos:${a.name}`}
                className={`side-child${
                  page === 'device-detail' &&
                  deviceScope === 'shared' &&
                  deviceSystem === 'harmonyos' &&
                  deviceName === a.name
                    ? ' active'
                    : ''
                }`}
                onClick={() => openDevice(a.name, 'shared', 'harmonyos')}
                title={`${a.name}（HarmonyOS）`}
              >
                {a.name}
              </button>
            ))}
            {sharedAvds.length === 0 && hosAvds.length === 0 && (
              <div className="side-child side-child-empty">暂无设备</div>
            )}
          </SideItem>
          </div>
          {env && !env.harmony && huaweiLogin !== null && (
            <div className="side-notice">
              <div className="side-notice-head">
                <svg
                  className="side-notice-icon"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M8 1.8 14.8 13.8H1.2L8 1.8Z" />
                  <path d="M8 6.4v3.2" />
                  <path d="M8 12.1h.01" />
                </svg>
                <span>需要注意</span>
              </div>
              {huaweiLogin ? (
                <>
                  <p className="side-notice-text">HarmonyOS SDK 未检测到。已登录华为账号，可下载命令行工具并自动落位</p>
                  <button
                    className="side-notice-link"
                    onClick={() => {
                      void api.huaweiDownloadCenter().then((d) => {
                        if (!d.ok) toast(d.error);
                        else if (d.data.started) toast('正在获取官方下载地址，进度见“下载管理”', 'ok');
                        else if (d.data.reason === 'window') toast('官方下载页已打开', 'ok');
                        else toast('已有下载任务在进行中');
                      });
                    }}
                  >
                    下载并自动落位 ›
                  </button>
                </>
              ) : (
                <>
                  <p className="side-notice-text">如果要使用 HarmonyOS SDK 进行开发，你必须登录你的华为账号</p>
                  <button className="side-notice-link" onClick={() => void api.huaweiLogin()}>
                    点击跳转登录 ›
                  </button>
                </>
              )}
            </div>
          )}
          <div className="side-footer">
            <button
              className={`side-dl${page === 'downloads' ? ' on' : ''}${dlActive.length > 0 ? ' dl-running' : ''}`}
              title="下载管理"
              onClick={() => goto('downloads')}
            >
              {dlActive.length > 0 && (
                <span className="side-dl-bar">
                  <span
                    className={`side-dl-fill${dlTotal === 0 ? ' indet' : ''}`}
                    style={dlTotal > 0 ? { width: `${dlPct}%` } : undefined}
                  />
                </span>
              )}
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2.5v7" />
                <path d="M5 7l3 3 3-3" />
                <path d="M3 11.5v1A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-1" />
              </svg>
              <span className="side-dl-label">下载管理</span>
            </button>
            <button
              className={`side-set${page === 'settings' ? ' on' : ''}`}
              title="设置"
              onClick={() => goto('settings')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
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
                onOpenSdkManage={openSdkManage}
                onOpenVm={(name) => openDevice(name, projectId)}
              />
            ))}
          {page === 'devices' && (
            <DevicePool
              emus={emus}
              refreshEmus={refreshEmus}
              env={env}
              system={deviceSystem}
              onSystem={setDeviceSystem}
              onOpenSdkManage={openSdkManage}
              onOpenVm={(name, system) => openDevice(name, 'shared', system)}
            />
          )}
          {page === 'device-detail' && deviceName !== null && (
            deviceSystem === 'harmonyos' && deviceScope === 'shared' ? (
              <HosDeviceDetail
                name={deviceName}
                emus={emus}
                backLabel="返回设备池"
                onBack={() => {
                  setPage('devices');
                  setDeviceName(null);
                }}
              />
            ) : (
              <DeviceDetail
                avdName={deviceName}
                scope={detailScope}
                emus={emus}
                refreshEmus={refreshEmus}
                backLabel={deviceScope === 'shared' ? '返回设备池' : `返回 ${deviceScope}`}
                onRenamed={(n) => setDeviceName(n)}
                onBack={() => {
                  setPage(deviceScope === 'shared' ? 'devices' : 'projects');
                  if (deviceScope !== 'shared') setProjectId(deviceScope);
                  setDeviceName(null);
                }}
              />
            )
          )}
          {page === 'downloads' && <Downloads />}
          {page === 'settings' && (
            <Settings
              env={env}
              refreshEnv={refreshEnv}
              section={settingsSection}
              onSection={setSettingsSection}
              sdkSystem={sdkSystem}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function SideItem({
  icon,
  label,
  active,
  indicated,
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
  /** 子项选中时父级仅保留左侧指示条，不亮蓝底 */
  indicated?: boolean;
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
        className={`side-item${active ? ' active' : ''}${indicated ? ' indicated' : ''}`}
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
