import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import logoUrl from '../../assets/icon.png';
import usageMd from '../../assets/docs/usage.md?raw';
import { api, onAutoInstall, onDownloadsChanged, onEnvChanged, onHuaweiChanged, onUpdateAvailable, onUpdateDownloaded, onUpdateError, onUpdateProgress, onWinMaximized, type DownloadItem, type EmuDevice, type HarmonyInfo, type Scope } from './api.ts';
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
import { Modal } from './components/Modal.tsx';
import { Markdown } from './components/Markdown.tsx';
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

/** 侧栏新版本提醒卡状态：与 UpdatePrompt 弹窗共用主进程更新事件源 */
type UpdateNotice = {
  latest: string;
  current: string;
  phase: 'available' | 'downloading' | 'ready';
};

const ss = {
  get: (k: string, d: string) => sessionStorage.getItem(k) ?? d,
  set: (k: string, v: string) => sessionStorage.setItem(k, v),
  del: (k: string) => sessionStorage.removeItem(k),
};

const dlId = (d: DownloadItem) => `${d.pkg}#${d.startedAt}`;

/** 轮询结果浅比较：主进程每次返回新数组身份，内容相同也触发整树重渲染；
 *  数据规模小（≤百条），序列化对比 <0.1ms，相同即复用旧引用跳过渲染 */
export const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

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
  // 收起态子项浮层：点图标不展开侧栏，改为在图标右侧弹出该分组的子项列表；
  // 锚点在打开时按图标屏幕坐标算一次，窗口尺寸变化直接关闭不跟随。
  // 铃铛钉在窗口底部，通知浮层改用 bottom 锚点向上展开，避免超出下缘
  const [sideFly, setSideFly] = useState<{
    kind: 'projects' | 'devices' | 'notice';
    x: number;
    y?: number;
    bottom?: number;
  } | null>(null);
  const sideFlyRef = useRef<HTMLDivElement | null>(null);
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
  // 新版本提醒：弹窗负责完整流程，这里只保留可重入的下载/安装入口
  const [updateNotice, setUpdateNotice] = useState<UpdateNotice | null>(null);
  // 首次安装完成打开后主动展示使用说明（引导配置已存在即老用户，不打扰）
  const [firstRunDoc, setFirstRunDoc] = useState(false);

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

  useEffect(() => {
    api.isFirstRun().then((r) => {
      if (r.ok && r.data) setFirstRunDoc(true);
    });
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

  // 新版本提醒跟随主进程更新事件；错误只回退卡片状态，失败原因由 update:error 统一弹窗。
  // 同版本且卡片已进入下载中/就绪态时保持相位不回退（下载完成后再点检查更新的场景）
  useEffect(() => {
    const un1 = onUpdateAvailable((p) =>
      setUpdateNotice((cur) =>
        cur && cur.phase !== 'available' && cur.latest === p.latest
          ? cur
          : { latest: p.latest, current: p.current, phase: 'available' },
      ),
    );
    const un2 = onUpdateProgress(() =>
      setUpdateNotice((cur) => (cur && cur.phase === 'available' ? { ...cur, phase: 'downloading' } : cur)),
    );
    const un3 = onUpdateDownloaded((p) =>
      setUpdateNotice((cur) =>
        // 渲染层重载后卡片可能还没建立：用就绪广播的版本号重建
        cur ? { ...cur, phase: 'ready' } : { latest: p.version, current: '', phase: 'ready' },
      ),
    );
    const un4 = onUpdateError(() =>
      setUpdateNotice((cur) => (cur && cur.phase === 'downloading' ? { ...cur, phase: 'available' } : cur)),
    );
    return () => {
      un1();
      un2();
      un3();
      un4();
    };
  }, []);

  // 侧栏胶囊总进度：所有进行中任务（含排队）已下载 / 总大小
  // 下载状态统一在此提示：开始（含排队）、完成、失败、取消；首帧只建立基线，
  // 否则重放历史会重复弹窗
  const seenActiveRef = useRef<Set<string> | null>(null);
  const seenFinishedRef = useRef<Set<string> | null>(null);
  useEffect(
    () =>
      onDownloadsChanged((s) => {
        setDlActive((cur) => (sameJson(cur, s.active) ? cur : s.active));
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
          // 应用更新包的完成/失败由更新弹窗与 update:error 广播承接，不重复弹 toast
          if (d.ephemeral && d.state !== 'cancelled') continue;
          if (d.state === 'done') toast(`${d.desc} 下载完成`, 'ok');
          else if (d.state === 'failed') toast(`${d.desc} 失败：${d.error ?? '未知错误'}`);
          else toast(`${d.desc} 已取消`, 'ok');
        }
      }),
    [],
  );
  const dlTotal = dlActive.reduce((a, d) => a + d.total, 0);
  // 与下载管理条目条同源：字节任务的 percent 为真实比值×95（为解压/落位保留上限），
  // 若按原始字节比值画，胶囊会跑在条目条前面（用户可见的两条不一致）
  const dlPct =
    dlActive.length > 0
      ? Math.round(dlActive.reduce((a, d) => a + d.percent, 0) / dlActive.length)
      : 0;
  // 全部任务完成（归档延迟窗口内）：进度条用 0.5s 动画补满再消失
  const dlAllDone = dlActive.length > 0 && dlActive.every((d) => d.state === 'done');

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

  // 侧栏通知：HarmonyOS SDK 提醒 + 新版本提醒，数量驱动收起态铃铛红点
  const hosNotice = !!env && !env.harmony && huaweiLogin !== null;
  const noticeCount = (hosNotice ? 1 : 0) + (updateNotice ? 1 : 0);
  // 通知中心条目：展开态内联与收起态浮层共用同一组卡片，多通知时单卡轮播
  const noticeItems: React.ReactNode[] = [];
  if (hosNotice) noticeItems.push(<HosNoticeContent loggedIn={huaweiLogin === true} />);
  if (updateNotice) noticeItems.push(<UpdateNoticeContent notice={updateNotice} />);

  const toggleSideFly = (kind: 'projects' | 'devices' | 'notice', e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const v = kind === 'notice' ? { bottom: window.innerHeight - r.bottom - 8 } : { y: r.top };
    setSideFly((cur) => (cur?.kind === kind ? null : { kind, x: r.right + 8, ...v }));
  };

  // 浮层关闭时机：点面板外（图标自身除外，交给 onToggle 做开合切换）、Esc、
  // 窗口尺寸变化、侧栏展开（展开态有自己的子项列表，浮层无意义）
  useEffect(() => {
    if (!sideFly) return;
    if (sideOpen) {
      setSideFly(null);
      return;
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (sideFlyRef.current?.contains(t as Node)) return;
      // 图标与铃铛自身的点击交给各自 onToggle 做开合切换，这里不抢
      if (t instanceof Element && t.closest('.side-item, .side-bell')) return;
      setSideFly(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSideFly(null);
    };
    const onResize = () => setSideFly(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [sideFly, sideOpen]);

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
        if (r.ok) setEmus((cur) => (sameJson(cur, r.data) ? cur : r.data));
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
        if (r.ok) setProjects((cur) => (sameJson(cur, r.data) ? cur : r.data));
      });
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, []);

  // 侧栏设备池设备列表同步
  useEffect(() => {
    const refresh = () =>
      api.listAvds({ kind: 'shared' }).then((r) => {
        if (r.ok) setSharedAvds((cur) => (sameJson(cur, r.data) ? cur : r.data));
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
        if (live && r.ok) setHosAvds((cur) => (sameJson(cur, r.data) ? cur : r.data));
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
      {firstRunDoc && (
        <Modal title="使用说明" className="doc-modal" onClose={() => setFirstRunDoc(false)}>
          <Markdown src={usageMd} />
        </Modal>
      )}
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
            onToggle={(e) => {
              if (!sideOpen) {
                goto('projects');
                toggleSideFly('projects', e);
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
            onToggle={(e) => {
              if (!sideOpen) {
                setPage('devices');
                setDeviceName(null);
                toggleSideFly('devices', e);
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
          {noticeItems.length > 0 && <NoticeCarousel items={noticeItems} />}
          <div className="side-footer">
            {!sideOpen && (
              <button
                className={`side-bell${noticeCount > 0 ? ' has-dot' : ''}`}
                title="通知"
                onClick={(e) => toggleSideFly('notice', e)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8" />
                  <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
                </svg>
              </button>
            )}
            <button
              className={`side-dl${page === 'downloads' ? ' on' : ''}${dlActive.length > 0 ? ' dl-running' : ''}`}
              title="下载管理"
              onClick={() => goto('downloads')}
            >
              {dlActive.length > 0 && (
                <span className="side-dl-bar">
                  <span
                    className={`side-dl-fill${dlAllDone ? ' done' : dlTotal === 0 ? ' indet' : ''}`}
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
        {sideFly && !sideOpen && sideFly.kind === 'notice' && (
          <div ref={sideFlyRef} className="side-fly side-fly-notice" style={{ left: sideFly.x, bottom: sideFly.bottom }}>
            {noticeCount === 0 ? <div className="side-fly-empty">暂无通知</div> : <NoticeCarousel items={noticeItems} />}
          </div>
        )}
        {sideFly && !sideOpen && sideFly.kind !== 'notice' && (
          <div ref={sideFlyRef} className="side-fly" style={{ left: sideFly.x, top: sideFly.y }}>
            {sideFly.kind === 'projects' ? (
              projects.length === 0 ? (
                <div className="side-fly-empty">暂无项目</div>
              ) : (
                projects.map((p) => (
                  <button
                    key={p.id}
                    className={`side-fly-item${page === 'projects' && projectId === p.id ? ' on' : ''}`}
                    onClick={() => {
                      setPage('projects');
                      setProjectId(p.id);
                      setSideFly(null);
                    }}
                    title={p.name}
                  >
                    {p.name}
                  </button>
                ))
              )
            ) : (
              <>
                {sharedAvds.length === 0 && hosAvds.length === 0 && <div className="side-fly-empty">暂无设备</div>}
                {sharedAvds.map((a) => (
                  <button
                    key={a.name}
                    className={`side-fly-item${
                      page === 'device-detail' &&
                      deviceScope === 'shared' &&
                      deviceSystem === 'android' &&
                      deviceName === a.name
                        ? ' on'
                        : ''
                    }`}
                    onClick={() => {
                      openDevice(a.name, 'shared', 'android');
                      setSideFly(null);
                    }}
                    title={a.name}
                  >
                    {a.name}
                  </button>
                ))}
                {hosAvds.map((a) => (
                  <button
                    key={`hos:${a.name}`}
                    className={`side-fly-item${
                      page === 'device-detail' &&
                      deviceScope === 'shared' &&
                      deviceSystem === 'harmonyos' &&
                      deviceName === a.name
                        ? ' on'
                        : ''
                    }`}
                    onClick={() => {
                      openDevice(a.name, 'shared', 'harmonyos');
                      setSideFly(null);
                    }}
                    title={`${a.name}（HarmonyOS）`}
                  >
                    {a.name}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
        <main className="content">
          {page === 'projects' &&
            (projectId === null ? (
              <Projects onOpen={setProjectId} />
            ) : (
              <ProjectDetail
                projectId={projectId}
                name={projects.find((p) => p.id === projectId)?.name ?? projectId}
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
                onRenamed={(n) => setDeviceName(n)}
                onBack={() => {
                  setPage('devices');
                  setDeviceName(null);
                }}
              />
            ) : (
              <DeviceDetail
                // 切设备必须重挂：编辑草稿、启动中计时都按组件实例保存，
                // 复用实例会把上一台的名称/内存配置保存到新设备
                key={`${deviceName}:${deviceScope === 'shared' ? 'shared' : deviceScope}`}
                avdName={deviceName}
                scope={detailScope}
                emus={emus}
                refreshEmus={refreshEmus}
                backLabel={
                  deviceScope === 'shared'
                    ? '返回设备池'
                    : `返回 ${projects.find((p) => p.id === deviceScope)?.name ?? deviceScope}`
                }
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
  onToggle: (e: React.MouseEvent) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className={`side-group${active ? ' group-active' : ''}`}>
      <button
        className={`side-item${active ? ' active' : ''}${indicated ? ' indicated' : ''}`}
        onClick={onToggle}
        title={label}
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

/** HarmonyOS SDK 提醒内容（不带卡片外框）：展开态与收起态浮层共用 */
function HosNoticeContent({ loggedIn }: { loggedIn: boolean }) {
  return (
    <>
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
      {loggedIn ? (
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
    </>
  );
}

/** 新版本提醒内容（不带卡片外框）：phase 与 UpdatePrompt 弹窗同步，动作可直接重入下载/安装 */
function UpdateNoticeContent({ notice }: { notice: UpdateNotice }) {
  return (
    <>
      <div className="side-notice-head">
        <svg
          className="side-notice-icon"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M8 2.5v7" />
          <path d="M5 7l3 3 3-3" />
          <path d="M3 11.5v1A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-1" />
        </svg>
        {notice.phase === 'downloading' && <span>正在下载 v{notice.latest}</span>}
        {notice.phase === 'ready' && <span>v{notice.latest} 已就绪</span>}
        {notice.phase === 'available' && <span>发现新版本 v{notice.latest}</span>}
      </div>
      {notice.phase === 'available' && (
        <>
          <p className="side-notice-text">当前版本 v{notice.current}，可以更新到 v{notice.latest}</p>
          <button className="side-notice-link" onClick={() => void api.updateDownload()}>
            下载并安装 ›
          </button>
        </>
      )}
      {notice.phase === 'downloading' && <p className="side-notice-text">更新包正在下载</p>}
      {notice.phase === 'ready' && (
        <>
          <p className="side-notice-text">安装包已下载并通过完整性校验，重启后将安装新版本</p>
          <button
            className="side-notice-link"
            onClick={() =>
              void api.updateInstall().then((r) => {
                if (!r.ok) toast(r.error);
              })
            }
          >
            立即安装并重启 ›
          </button>
        </>
      )}
    </>
  );
}

/** 通知轮播：单卡展示 + 卡内底部圆点；多通知时自动轮换（5s，悬停暂停），圆点可点跳 */
function NoticeCarousel({ items }: { items: React.ReactNode[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = items.length;
  // 通知减少时把游标收回有效范围
  useEffect(() => {
    setIndex((i) => Math.min(i, count - 1));
  }, [count]);
  // index 进依赖：手动跳点后重新计时，保证两次切换间隔一致
  useEffect(() => {
    if (paused || count <= 1) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % count), 5000);
    return () => clearInterval(timer);
  }, [paused, count, index]);
  if (count === 0) return null;
  return (
    <div
      className="side-notice notice-carousel"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="notice-viewport">
        <div className="notice-track" style={{ transform: `translateX(-${index * 100}%)` }}>
          {items.map((node, i) => (
            <div key={i} className="notice-slide">
              {node}
            </div>
          ))}
        </div>
      </div>
      {count > 1 && (
        <div className="notice-dots">
          {items.map((_, i) => (
            <button
              key={i}
              className={`notice-dot${i === index ? ' on' : ''}`}
              aria-label={`第 ${i + 1} 条通知`}
              onClick={() => setIndex(i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
