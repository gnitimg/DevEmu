import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  ENV_LABELS,
  type CameraMode,
  type EnvKind,
  type StorageInfo,
} from '../api.ts';
import { Modal } from '../components/Modal.tsx';
import { toast } from '../components/Toast.tsx';
import { SdkPackages } from '../components/SdkPackages.tsx';
import { Segmented } from '../components/Segmented.tsx';
import { RoutePanel } from '../components/RoutePanel.tsx';
import { Select } from '../components/Select.tsx';
import { AgentPanel } from '../components/AgentPanel.tsx';
import { About } from './About.tsx';
import type { EnvStatus } from '../App.tsx';

export type Section =
  | 'storage'
  | 'sdk'
  | 'network'
  | 'emulator'
  | 'agent'
  | 'about';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'storage', label: '存储' },
  { id: 'sdk', label: 'SDK' },
  { id: 'network', label: '网络与下载' },
  { id: 'emulator', label: '模拟器' },
  { id: 'agent', label: 'Agent 接入' },
  { id: 'about', label: '关于' },
];

const SPEED_OPTIONS: { kbps: number; label: string }[] = [
  { kbps: 0, label: '不限速' },
  { kbps: 256, label: '256 KB/s' },
  { kbps: 512, label: '512 KB/s' },
  { kbps: 1024, label: '1 MB/s' },
  { kbps: 2048, label: '2 MB/s' },
  { kbps: 4096, label: '4 MB/s' },
  { kbps: 8192, label: '8 MB/s' },
  { kbps: 16384, label: '16 MB/s' },
];

/** 存储维护操作的确认弹窗文案 */
const CONFIRM_META = {
  clearLogs: {
    title: '清除日志',
    confirm: '清除',
    text: '将删除 logs 目录下的全部日志文件。日志只用于排查问题，清除不影响虚拟机与项目数据。',
  },
  clearAvds: {
    title: '清除所有虚拟机',
    confirm: '全部删除',
    text: '运行中的虚拟机会先被关闭，随后删除共享库与所有项目里的全部虚拟机（含配置、磁盘与快照）。应用库与运行记录保留。',
  },
  reset: {
    title: '软件重置',
    confirm: '重置并重启',
    text: '将关闭所有虚拟机并停止控制桥，删除项目、虚拟机、应用库、下载记录、日志与全部设置，然后自动重启应用。此操作不可恢复。',
  },
} as const;
type ConfirmOp = keyof typeof CONFIRM_META;

export function Settings({
  env,
  refreshEnv,
  section,
  onSection,
  sdkSystem,
}: {
  env: EnvStatus | null;
  refreshEnv: () => void;
  section: string;
  onSection: (s: Section) => void;
  sdkSystem?: 'android' | 'harmonyos';
}) {
  const [dataRoot, setDataRoot] = useState('');
  const [sdkPath, setSdkPath] = useState('');
  const [harmonyPath, setHarmonyPath] = useState('');
  const [javaPath, setJavaPath] = useState('');
  const [gpuMode, setGpuMode] = useState('');
  const [cameraMode, setCameraMode] = useState<CameraMode>('emulated');
  const [webcam, setWebcam] = useState('webcam0');
  const [webcams, setWebcams] = useState<{ id: string; label: string }[]>([]);
  const [pillEnabled, setPillEnabled] = useState(true);
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyPort, setProxyPort] = useState('7890');
  const [maxKbps, setMaxKbps] = useState(0);
  const [parallel, setParallel] = useState('2');
  const [androidRoute, setAndroidRoute] = useState<'direct' | 'proxy'>(
    'direct',
  );
  const [harmonyRoute, setHarmonyRoute] = useState<'direct' | 'proxy'>(
    'direct',
  );
  const [savedAt, setSavedAt] = useState(0);
  const [hintOn, setHintOn] = useState(false);
  const [error, setError] = useState('');
  // 浏览目录未找到环境时的“在此安装”弹窗
  const [installAsk, setInstallAsk] = useState<{
    kind: EnvKind;
    field: 'sdkPath' | 'harmonyPath' | 'javaPath';
    dir: string;
    title: string;
  } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [confirmAsk, setConfirmAsk] = useState<ConfirmOp | null>(null);
  // 数据迁移：选目标目录 → 确认 → 迁移并断开全部设备 → 提示重启
  const [migrateAsk, setMigrateAsk] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [migrateDone, setMigrateDone] = useState(false);
  // 数据根迁移（跨盘复制数 GB、期间主进程同步执行）需确认后才执行
  const [rootAsk, setRootAsk] = useState<{
    dir: string;
    projects: { id: string; name: string }[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  // 改动序号：设置一有变化就 +1；自动保存按“已落盘序号”判断是否仍需写盘。
  // 卸载时若仍有未落盘改动就立即补写——600ms 防抖定时器会随卸载被清掉
  const saveRev = useRef(0);
  const savedRev = useRef(0);
  const touch = () => {
    saveRev.current += 1;
  };
  // 只在首次拿到 env 时回填一次；之后一律以用户输入为准，
  // 避免保存后的 env 刷新把正在编辑的值跳回旧值
  const syncedOnce = useRef(false);
  const envPaths = useRef<{ sdk?: string; harmony?: string; java?: string }>({});

  useEffect(() => {
    if (env && !syncedOnce.current) {
      syncedOnce.current = true;
      setDataRoot(env.settings.dataRoot);
      setSdkPath(env.settings.sdkPath ?? env.sdk?.root ?? '');
      setHarmonyPath(env.settings.harmonySdkPath ?? env.harmony?.sdkRoot ?? '');
      setJavaPath(env.settings.javaPath ?? env.java ?? '');
      setGpuMode(env.settings.gpuMode ?? 'angle_indirect');
      setCameraMode(
        env.settings.cameraMode === 'webcam' ||
          env.settings.cameraMode === 'screen'
          ? env.settings.cameraMode
          : 'emulated',
      );
      setWebcam(
        env.settings.webcam && /^webcam\d+$/.test(env.settings.webcam)
          ? env.settings.webcam
          : 'webcam0',
      );
      setPillEnabled(env.settings.pillEnabled !== false);
      setProxyEnabled(env.settings.proxyEnabled === true);
      setProxyPort(
        env.settings.proxyPort ? String(env.settings.proxyPort) : '7890',
      );
      setMaxKbps(
        env.settings.maxDownloadKbps && env.settings.maxDownloadKbps > 0
          ? env.settings.maxDownloadKbps
          : 0,
      );
      setParallel(
        env.settings.parallelDownloads
          ? String(env.settings.parallelDownloads)
          : '2',
      );
      setAndroidRoute(
        env.settings.androidDownloadRoute === 'proxy' ? 'proxy' : 'direct',
      );
      setHarmonyRoute(
        env.settings.harmonyDownloadRoute === 'proxy' ? 'proxy' : 'direct',
      );
    }
  }, [env]);

  useEffect(() => {
    if (!env) return;
    // 首次已由上面的回填处理；之后只跟随"设置里真正变化"的路径，
    // 避免导入 HarmonyOS SDK 后 env 刷新了、字段却还保留旧值被自动保存写回
    const prev = envPaths.current;
    const next = {
      sdk: env.settings.sdkPath ?? env.sdk?.root ?? '',
      harmony: env.settings.harmonySdkPath ?? env.harmony?.sdkRoot ?? '',
      java: env.settings.javaPath ?? env.java ?? '',
    };
    if (prev.sdk === undefined) {
      envPaths.current = next;
      return;
    }
    if (next.sdk !== prev.sdk) setSdkPath(next.sdk);
    if (next.harmony !== prev.harmony) setHarmonyPath(next.harmony);
    if (next.java !== prev.java) setJavaPath(next.java);
    envPaths.current = next;
  }, [env]);

  useEffect(() => {
    if (!savedAt) return;
    setHintOn(true);
    const t = setTimeout(() => setHintOn(false), 1800);
    return () => clearTimeout(t);
  }, [savedAt]);

  const persistNow = useCallback(
    async (overrides?: {
      cameraMode?: CameraMode;
      webcam?: string;
    }): Promise<boolean> => {
      if (!dataRoot.trim()) return false;
      setError('');
      const port = Number(proxyPort);
      const r = await api.saveSettings({
        dataRoot: dataRoot.trim(),
        sdkPath: sdkPath.trim() || undefined,
        javaPath: javaPath.trim() || undefined,
        harmonySdkPath: harmonyPath.trim() || undefined,
        gpuMode: gpuMode || undefined,
        cameraMode: overrides?.cameraMode ?? cameraMode,
        webcam: overrides?.webcam ?? webcam,
        pillEnabled,
        proxyEnabled,
        proxyPort:
          Number.isFinite(port) && port >= 1 && port <= 65535
            ? port
            : undefined,
        maxDownloadKbps: maxKbps > 0 ? maxKbps : 0,
        parallelDownloads: Number(parallel) || 2,
        androidDownloadRoute: androidRoute,
        harmonyDownloadRoute: harmonyRoute,
      });
      if (!r.ok) {
        setError(r.error);
        return false;
      }
      setSavedAt(Date.now());
      refreshEnv();
      return true;
    },
    [
      dataRoot,
      sdkPath,
      harmonyPath,
      javaPath,
      gpuMode,
      cameraMode,
      webcam,
      pillEnabled,
      proxyEnabled,
      proxyPort,
      maxKbps,
      parallel,
      androidRoute,
      harmonyRoute,
      refreshEnv,
    ],
  );

  // 自动保存：改动 600ms 后落盘
  useEffect(() => {
    if (saveRev.current === savedRev.current || !dataRoot.trim()) return;
    const rev = saveRev.current;
    const timer = setTimeout(async () => {
      if (await persistNow()) savedRev.current = rev;
    }, 600);
    return () => clearTimeout(timer);
  }, [
    dataRoot,
    sdkPath,
    harmonyPath,
    javaPath,
    gpuMode,
    cameraMode,
    webcam,
    pillEnabled,
    proxyEnabled,
    proxyPort,
    maxKbps,
    parallel,
    androidRoute,
    harmonyRoute,
    refreshEnv,
    persistNow,
  ]);

  const persistRef = useRef(persistNow);
  useEffect(() => {
    persistRef.current = persistNow;
  });
  useEffect(
    () => () => {
      // 卸载后 setError 落在已卸载树＝静默丢失：flush 失败用全局 toast 反馈
      if (saveRev.current !== savedRev.current)
        void persistRef.current().then((ok) => {
          if (!ok) toast('设置未能自动保存，请回到设置页重新保存');
        });
    },
    [],
  );

  /** 相机来源是启动期参数：先落盘，再询问是否重启运行中的 Android 虚拟机 */
  async function changeCameraSource(overrides: {
    cameraMode?: CameraMode;
    webcam?: string;
  }) {
    touch();
    if (overrides.cameraMode) setCameraMode(overrides.cameraMode);
    if (overrides.webcam) setWebcam(overrides.webcam);
    const rev = saveRev.current;
    if (!(await persistNow(overrides))) return;
    savedRev.current = rev;
    const list = await api.listEmulators();
    if (!list.ok) return;
    const running = list.data.filter((d) => d.type !== 'harmonyos');
    if (running.length === 0) return;
    if (
      !window.confirm(
        `相机来源在虚拟机启动时生效，现在重启运行中的 ${running.length} 台 Android 虚拟机？`,
      )
    )
      return;
    toast(`正在重启 ${running.length} 台虚拟机…`);
    const r = await api.restartRunningEmus();
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (r.data.length === 0) {
      toast('未发现由本应用启动的虚拟机，请手动重启后生效');
      return;
    }
    const failed = r.data.filter((x) => !x.ok);
    toast(
      failed.length
        ? `${r.data.length - failed.length} 台已重启，${failed.length} 台失败：${failed[0]!.error ?? ''}`
        : `已重启 ${r.data.length} 台虚拟机`,
    );
  }

  // 选了摄像头直通时拉取宿主摄像头列表（进入模拟器分区且切到 webcam 时）
  useEffect(() => {
    if (section !== 'emulator' || cameraMode !== 'webcam') return;
    void api.cameraWebcams().then((r) => {
      if (r.ok) setWebcams(r.data);
    });
  }, [section, cameraMode]);

  const loadStorage = useCallback(() => {
    void api.storageInfo().then((r) => {
      if (r.ok) setStorage(r.data);
    });
  }, []);

  // 进入存储分区时刷新文件位置与虚拟机计数（操作完成后也会调用）
  useEffect(() => {
    if (section === 'storage') loadStorage();
  }, [section, loadStorage]);

  async function revealStorage(p: string) {
    const r = await api.storageReveal(p);
    if (!r.ok) toast(r.error);
  }

  /** 执行存储维护操作；软件重置由主进程延迟重启，保持 busy 盖住界面即可 */
  async function runStorageOp(op: ConfirmOp) {
    setBusy(true);
    if (op === 'clearLogs') {
      const r = await api.storageClearLogs();
      setBusy(false);
      setConfirmAsk(null);
      if (!r.ok) {
        toast(r.error);
        return;
      }
      toast(`已清除 ${r.data} 个日志文件`, 'ok');
      loadStorage();
    } else if (op === 'clearAvds') {
      const r = await api.storageClearAvds();
      setBusy(false);
      setConfirmAsk(null);
      if (!r.ok) {
        toast(r.error);
        return;
      }
      toast(`已删除 ${r.data} 台虚拟机`, 'ok');
      loadStorage();
      refreshEnv();
    } else {
      // 成功时主进程延迟重启应用；失败必须恢复界面让用户重试或取消
      const r = await api.storageReset();
      setBusy(false);
      setConfirmAsk(null);
      if (!r.ok) toast(r.error);
    }
  }

  type PickField = 'dataRoot' | 'sdkPath' | 'harmonyPath' | 'javaPath';

  /** 迁移数据：选目标目录 → 前置检查 → 确认弹窗 */
  async function startMigrate() {
    const r = await api.openDirDialog('选择迁移目标目录');
    if (!r.ok || !r.data) return;
    const c = await api.checkDataRoot(r.data);
    if (!c.ok) {
      toast(c.error);
      return;
    }
    if (c.data.blocked) {
      toast('目标目录不能位于数据项目录内部（projects/devices 等），请选择其他目录');
      return;
    }
    setMigrateAsk(r.data);
  }

  /** 执行迁移：主进程断开全部设备与控制桥后随迁，完成弹重启提示 */
  async function doMigrate() {
    if (!migrateAsk) return;
    setMigrating(true);
    const r = await api.storageMigrateData(migrateAsk);
    setMigrating(false);
    setMigrateAsk(null);
    if (!r.ok) {
      toast(r.error);
      return;
    }
    setMigrateDone(true);
  }

  const FIELD_KIND: Partial<Record<PickField, EnvKind>> = {
    sdkPath: 'android',
    harmonyPath: 'harmonyos',
    javaPath: 'java',
  };

  function applyPick(field: PickField, dir: string) {
    touch();
    if (field === 'dataRoot') setDataRoot(dir);
    else if (field === 'sdkPath') setSdkPath(dir);
    else if (field === 'harmonyPath') setHarmonyPath(dir);
    else setJavaPath(dir);
  }

  async function browse(field: PickField, title: string) {
    const r = await api.openDirDialog(title);
    if (!r.ok || !r.data) return;
    if (field === 'dataRoot') {
      const c = await api.checkDataRoot(r.data);
      if (!c.ok) {
        toast(c.error);
        return;
      }
      if (c.data.blocked) {
        toast('新数据根不能位于数据项目录内部（projects/devices 等），请选择其他目录');
        return;
      }
      setRootAsk({ dir: r.data, projects: c.data.projects });
      return;
    }
    const kind = FIELD_KIND[field];
    // 环境目录：选中后先检测，目录里没有对应环境时弹“浏览其他路径 / 在此安装”
    if (kind) {
      const c = await api.envCheckDir(kind, r.data);
      if (!(c.ok && c.data.found)) {
        setInstallAsk({ kind, field, dir: r.data, title });
        return;
      }
    }
    applyPick(field, r.data);
  }

  /** 弹窗里“浏览其他路径”：关掉当前弹窗重新选 */
  function browseAgain() {
    const ask = installAsk;
    if (!ask) return;
    setInstallAsk(null);
    void browse(ask.field, ask.title);
  }

  /** HarmonyOS 命令行工具：后台抓官方签名直链后直接下载，解压落位 */
  async function startHarmonyDownload(dir?: string) {
    const d = await api.huaweiDownloadCenter(dir);
    if (!d.ok) {
      toast(d.error);
      return;
    }
    if (d.data.started) toast('正在获取官方下载地址，进度见“下载管理”', 'ok');
    else if (d.data.reason === 'window') toast('官方下载页已打开', 'ok');
    else toast('已有下载任务在进行中');
  }

  /** 弹窗里“在此安装”：环境入下载队列；HarmonyOS 走后台直链下载（需登录） */
  async function installHere() {
    const ask = installAsk;
    if (!ask) return;
    setInstalling(true);
    const r = await api.envInstall(ask.kind, ask.dir);
    setInstalling(false);
    if (!r.ok) {
      toast(r.error);
      return;
    }
    applyPick(ask.field, ask.dir);
    setInstallAsk(null);
    if (r.data.manual) await startHarmonyDownload(ask.dir);
  }

  const mark =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      touch();
      setter(v);
    };

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">设置</h1>
        <span className={`save-hint${hintOn ? ' show' : ''}`}>已保存</span>
        <div className="page-actions">
          <Segmented
            options={SECTIONS}
            value={section as Section}
            onChange={onSection}
          />
        </div>
      </div>
      <div key={section} className="sys-page">
        {section === 'storage' && (
          <>
            <div className="section">
              <div className="settings-row">
                <span className="settings-row-label">数据根目录</span>
                <div className="path-row">
                  <input
                    value={dataRoot}
                    readOnly
                    spellCheck={false}
                    title={dataRoot}
                  />
                  <button
                    className="btn"
                    onClick={() => browse('dataRoot', '选择数据根目录')}
                  >
                    浏览
                  </button>
                </div>
              </div>
              {(storage?.items ?? []).map((item) => (
                <div className="settings-row" key={item.id}>
                  <span className="settings-row-label">{item.label}</span>
                  <div className="path-row">
                    <input
                      value={item.path}
                      readOnly
                      spellCheck={false}
                      title={item.path}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <button
                      className="btn"
                      onClick={() => void revealStorage(item.path)}
                    >
                      打开位置
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="section">
              <div className="settings-row">
                <span className="settings-row-label">迁移数据</span>
                <button className="btn" onClick={() => void startMigrate()}>
                  迁移到新目录
                </button>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">清除日志</span>
                <button
                  className="btn btn-danger"
                  disabled={!storage}
                  onClick={() => setConfirmAsk('clearLogs')}
                >
                  清除日志
                </button>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">清除所有虚拟机</span>
                <button
                  className="btn btn-danger"
                  disabled={!storage}
                  onClick={() => setConfirmAsk('clearAvds')}
                >
                  全部删除
                </button>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">软件重置</span>
                <button
                  className="btn btn-danger"
                  onClick={() => setConfirmAsk('reset')}
                >
                  重置并重启
                </button>
              </div>
            </div>

            {rootAsk && (
              <Modal
                title="更改数据根目录"
                onClose={() => setRootAsk(null)}
                footer={
                  <>
                    <button className="btn" onClick={() => setRootAsk(null)}>
                      取消
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={() => {
                        const dir = rootAsk.dir;
                        setRootAsk(null);
                        applyPick('dataRoot', dir);
                      }}
                    >
                      迁移并切换
                    </button>
                  </>
                }
              >
                <p>
                  将把项目、虚拟机、应用库与测试记录全部迁移到 {rootAsk.dir}
                  ，并清空原目录。迁移同步执行，数据量大（跨盘搬迁）时应用会
                  短暂无响应，期间请勿关闭应用或操作虚拟机。
                </p>
                {rootAsk.projects.length > 0 && (
                  <p style={{ color: 'var(--danger)' }}>
                    目标目录已存在同名项目（
                    {rootAsk.projects.map((p) => p.name).join('、')}
                    ），迁移会用当前数据覆盖它们的同名文件。
                  </p>
                )}
              </Modal>
            )}

            {confirmAsk && (
              <Modal
                title={CONFIRM_META[confirmAsk].title}
                onClose={() => {
                  if (!busy) setConfirmAsk(null);
                }}
                footer={
                  <>
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => setConfirmAsk(null)}
                    >
                      取消
                    </button>
                    <button
                      className="btn btn-danger"
                      disabled={busy}
                      onClick={() => void runStorageOp(confirmAsk)}
                    >
                      {busy ? '处理中…' : CONFIRM_META[confirmAsk].confirm}
                    </button>
                  </>
                }
              >
                <p>{CONFIRM_META[confirmAsk].text}</p>
              </Modal>
            )}

            {migrateAsk && (
              <Modal
                title="迁移数据"
                onClose={() => {
                  if (!migrating) setMigrateAsk(null);
                }}
                footer={
                  <>
                    <button
                      className="btn"
                      disabled={migrating}
                      onClick={() => setMigrateAsk(null)}
                    >
                      取消
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={migrating}
                      onClick={() => void doMigrate()}
                    >
                      {migrating ? '迁移中…' : '开始迁移'}
                    </button>
                  </>
                }
              >
                <p>
                  将断开所有设备连接并停止控制桥，把项目、虚拟机、应用库、崩溃
                  记录与下载记录全部迁移到 {migrateAsk}，完成后需要重启应用。
                </p>
                <p>
                  迁移同步执行，数据量大（跨盘搬迁）时应用会短暂无响应，期间请
                  勿关闭应用。
                </p>
              </Modal>
            )}

            {migrateDone && (
              <Modal
                title="迁移完成"
                onClose={() => setMigrateDone(false)}
                footer={
                  <>
                    <button className="btn" onClick={() => setMigrateDone(false)}>
                      稍后手动重启
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={() => void api.restartApp()}
                    >
                      立即重启
                    </button>
                  </>
                }
              >
                <p>数据已迁移并切换到新目录，重启应用后生效。</p>
              </Modal>
            )}
          </>
        )}

        {section === 'sdk' && (
          <>
            <div className="section" style={{ marginBottom: 16 }}>
              <div className="settings-row">
                <span className="settings-row-label">Android SDK 路径</span>
                <div className="path-row">
                  <input
                    value={sdkPath}
                    readOnly
                    spellCheck={false}
                    title={sdkPath}
                  />
                  <button
                    className="btn"
                    onClick={() => browse('sdkPath', '选择 Android SDK 目录')}
                  >
                    浏览
                  </button>
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">HarmonyOS SDK 路径</span>
                <div className="path-row">
                  <input
                    value={harmonyPath}
                    readOnly
                    spellCheck={false}
                    title={harmonyPath}
                    placeholder="未检测到"
                  />
                  <button
                    className="btn"
                    onClick={() =>
                      browse('harmonyPath', '选择 HarmonyOS SDK 目录')
                    }
                  >
                    浏览
                  </button>
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">Java 路径</span>
                <div className="path-row">
                  <input
                    value={javaPath}
                    readOnly
                    spellCheck={false}
                    title={javaPath}
                  />
                  <button
                    className="btn"
                    onClick={() =>
                      browse('javaPath', '选择 Java bin 目录或 jbr 目录')
                    }
                  >
                    浏览
                  </button>
                </div>
              </div>
            </div>
            <div className="section">
              <div style={{ padding: '10px 14px 14px' }}>
                <SdkPackages
                  env={env}
                  onChanged={refreshEnv}
                  initialSystem={sdkSystem}
                  onPickFolder={() => void browse('harmonyPath', '选择 HarmonyOS SDK 目录')}
                  onOpenDownload={() => void startHarmonyDownload()}
                />
              </div>
            </div>
          </>
        )}

        {section === 'network' && (
          <>
            <div className="section">
              <div className="settings-row">
                <span className="settings-row-label">设备网络代理</span>
                <div className="proxy-row">
                  <label className="switch-wrap">
                    <input
                      type="checkbox"
                      checked={proxyEnabled}
                      onChange={(e) => {
                        touch();
                        setProxyEnabled(e.target.checked);
                      }}
                    />
                    启用
                  </label>
                  <span className="proxy-addr mono">http://127.0.0.1:</span>
                  <input
                    className="proxy-port"
                    value={proxyPort}
                    onChange={(e) => {
                      touch();
                      setProxyPort(e.target.value.replace(/[^\d]/g, ''));
                    }}
                    placeholder="7890"
                    inputMode="numeric"
                  />
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">最高下载速度</span>
                <div style={{ width: 180 }}>
                  <Select
                    value={String(maxKbps)}
                    options={SPEED_OPTIONS.map((o) => ({
                      value: String(o.kbps),
                      label: o.label,
                    }))}
                    onChange={(v) => mark(setMaxKbps)(Number(v))}
                  />
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">并行下载数</span>
                <div style={{ width: 180 }}>
                  <Select
                    value={parallel}
                    options={['1', '2', '3', '4'].map((n) => ({
                      value: n,
                      label: n,
                    }))}
                    onChange={(v) => mark(setParallel)(v)}
                  />
                </div>
              </div>
            </div>
            <div className="section">
              <RoutePanel
                system="android"
                title="Android 下载线路"
                value={androidRoute}
                proxyPort={proxyPort}
                onPick={mark(setAndroidRoute)}
              />
            </div>
            <div className="section">
              <RoutePanel
                system="harmonyos"
                title="HarmonyOS 下载线路"
                value={harmonyRoute}
                proxyPort={proxyPort}
                onPick={mark(setHarmonyRoute)}
              />
            </div>
          </>
        )}

        {section === 'emulator' && (
          <div className="section">
            <div className="settings-row">
              <span className="settings-row-label">图形后端</span>
              <div style={{ width: 200 }}>
                <Select
                  value={gpuMode}
                  options={[
                    { value: 'swiftshader_indirect', label: '软件渲染' },
                    { value: 'angle_indirect', label: 'ANGLE / Direct3D' },
                    { value: 'host', label: '宿主 GPU' },
                  ]}
                  onChange={(v) => mark(setGpuMode)(v)}
                />
              </div>
            </div>
            <div className="settings-row">
              <span className="settings-row-label">相机画面来源</span>
              <div style={{ width: 200 }}>
                <Select
                  value={cameraMode}
                  options={[
                    { value: 'emulated', label: '软件仿真（默认）' },
                    { value: 'screen', label: '识别 Windows 屏幕' },
                    { value: 'webcam', label: '调用 Windows 摄像头' },
                  ]}
                  onChange={(v) =>
                    void changeCameraSource({ cameraMode: v as CameraMode })
                  }
                />
              </div>
            </div>
            {cameraMode === 'webcam' && (
              <div className="settings-row">
                <span className="settings-row-label">摄像头设备</span>
                <div style={{ width: 200 }}>
                  <Select
                    value={webcam}
                    options={
                      webcams.length
                        ? webcams.map((w) => ({ value: w.id, label: w.label }))
                        : [{ value: webcam, label: webcam }]
                    }
                    onChange={(v) => void changeCameraSource({ webcam: v })}
                  />
                </div>
              </div>
            )}
            <div className="settings-row">
              <span className="settings-row-label">辅助控制中心</span>
              <label className="switch-wrap">
                <input
                  type="checkbox"
                  checked={pillEnabled}
                  onChange={(e) => {
                    touch();
                    setPillEnabled(e.target.checked);
                  }}
                />
                启用
              </label>
            </div>
          </div>
        )}

        {section === 'agent' && <AgentPanel />}

        {section === 'about' && <About env={env} />}

        {error && (
          <div className="error-line" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
      </div>

      {installAsk && (
        <Modal
          title={`未找到${ENV_LABELS[installAsk.kind]}`}
          onClose={() => setInstallAsk(null)}
          footer={
            <>
              <button className="btn" onClick={browseAgain}>
                浏览其他路径
              </button>
              <button
                className="btn btn-primary"
                disabled={installing}
                onClick={() => void installHere()}
              >
                {installing
                  ? '解析中…'
                  : installAsk.kind === 'harmonyos'
                    ? '打开官方下载页'
                    : `在此安装${ENV_LABELS[installAsk.kind]}`}
              </button>
            </>
          }
        >
          <p>该文件夹内并未找到{ENV_LABELS[installAsk.kind]}，您希望？</p>
          {installAsk.kind === 'harmonyos' ? (
            <p className="page-sub">
              华为要求登录开发者账号后才能下载命令行工具，点击“打开官方下载页”前往；
              下载完成后将压缩包解压到所选目录即可被检测到。
            </p>
          ) : (
            <p className="page-sub">
              将下载官方最新版并解压到所选目录，进度可在“下载管理”中查看。
              {installAsk.kind === 'android' &&
                '命令行工具装好后会自动续装 platform-tools 与 emulator。'}
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
