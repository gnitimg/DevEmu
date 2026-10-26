import { useEffect, useRef, useState } from 'react';
import { api, ENV_LABELS, type EnvKind } from '../api.ts';
import { Modal } from '../components/Modal.tsx';
import { toast } from '../components/Toast.tsx';
import { SdkPackages } from '../components/SdkPackages.tsx';
import { Segmented } from '../components/Segmented.tsx';
import { RoutePanel } from '../components/RoutePanel.tsx';
import { Select } from '../components/Select.tsx';
import { AgentPanel } from '../components/AgentPanel.tsx';
import { About } from './About.tsx';
import type { EnvStatus } from '../App.tsx';

export type Section = 'storage' | 'sdk' | 'network' | 'download' | 'emulator' | 'agent' | 'about';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'storage', label: '存储' },
  { id: 'sdk', label: 'SDK' },
  { id: 'network', label: '网络与代理' },
  { id: 'download', label: '下载与限速' },
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

export function Settings({
  env,
  refreshEnv,
  section,
  onSection,
}: {
  env: EnvStatus | null;
  refreshEnv: () => void;
  section: string;
  onSection: (s: Section) => void;
}) {
  const [dataRoot, setDataRoot] = useState('');
  const [sdkPath, setSdkPath] = useState('');
  const [harmonyPath, setHarmonyPath] = useState('');
  const [javaPath, setJavaPath] = useState('');
  const [gpuMode, setGpuMode] = useState('');
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyPort, setProxyPort] = useState('7890');
  const [maxKbps, setMaxKbps] = useState(0);
  const [parallel, setParallel] = useState('2');
  const [androidRoute, setAndroidRoute] = useState<'direct' | 'proxy'>('direct');
  const [harmonyRoute, setHarmonyRoute] = useState<'direct' | 'proxy'>('direct');
  const [savedAt, setSavedAt] = useState(0);
  const [hintOn, setHintOn] = useState(false);
  const [error, setError] = useState('');
  // 浏览目录未找到环境时的“在此安装”弹窗
  const [installAsk, setInstallAsk] = useState<{ kind: EnvKind; field: 'sdkPath' | 'harmonyPath' | 'javaPath'; dir: string; title: string } | null>(null);
  const [installing, setInstalling] = useState(false);
  const dirty = useRef(false);
  // 只在首次拿到 env 时回填一次；之后一律以用户输入为准，
  // 避免保存后的 env 刷新把正在编辑的值跳回旧值
  const syncedOnce = useRef(false);

  useEffect(() => {
    if (env && !syncedOnce.current) {
      syncedOnce.current = true;
      setDataRoot(env.settings.dataRoot);
      setSdkPath(env.settings.sdkPath ?? env.sdk?.root ?? '');
      setHarmonyPath(env.settings.harmonySdkPath ?? env.harmony?.sdkRoot ?? '');
      setJavaPath(env.settings.javaPath ?? env.java ?? '');
      setGpuMode(env.settings.gpuMode ?? 'swiftshader_indirect');
      setProxyEnabled(env.settings.proxyEnabled === true);
      setProxyPort(env.settings.proxyPort ? String(env.settings.proxyPort) : '7890');
      setMaxKbps(env.settings.maxDownloadKbps && env.settings.maxDownloadKbps > 0 ? env.settings.maxDownloadKbps : 0);
      setParallel(env.settings.parallelDownloads ? String(env.settings.parallelDownloads) : '2');
      setAndroidRoute(env.settings.androidDownloadRoute === 'proxy' ? 'proxy' : 'direct');
      setHarmonyRoute(env.settings.harmonyDownloadRoute === 'proxy' ? 'proxy' : 'direct');
    }
  }, [env]);

  useEffect(() => {
    if (!savedAt) return;
    setHintOn(true);
    const t = setTimeout(() => setHintOn(false), 1800);
    return () => clearTimeout(t);
  }, [savedAt]);

  // 自动保存：改动 600ms 后落盘
  useEffect(() => {
    if (!dirty.current || !dataRoot.trim()) return;
    const timer = setTimeout(async () => {
      setError('');
      const port = Number(proxyPort);
      const r = await api.saveSettings({
        dataRoot: dataRoot.trim(),
        sdkPath: sdkPath.trim() || undefined,
        javaPath: javaPath.trim() || undefined,
        harmonySdkPath: harmonyPath.trim() || undefined,
        gpuMode: gpuMode || undefined,
        proxyEnabled,
        proxyPort: Number.isFinite(port) && port >= 1 && port <= 65535 ? port : undefined,
        maxDownloadKbps: maxKbps > 0 ? maxKbps : 0,
        parallelDownloads: Number(parallel) || 2,
        androidDownloadRoute: androidRoute,
        harmonyDownloadRoute: harmonyRoute,
      });
      if (!r.ok) setError(r.error);
      else {
        setSavedAt(Date.now());
        refreshEnv();
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [dataRoot, sdkPath, harmonyPath, javaPath, gpuMode, proxyEnabled, proxyPort, maxKbps, parallel, androidRoute, harmonyRoute, refreshEnv]);

  type PickField = 'dataRoot' | 'sdkPath' | 'harmonyPath' | 'javaPath';
  const FIELD_KIND: Partial<Record<PickField, EnvKind>> = { sdkPath: 'android', harmonyPath: 'harmonyos', javaPath: 'java' };

  function applyPick(field: PickField, dir: string) {
    dirty.current = true;
    if (field === 'dataRoot') setDataRoot(dir);
    else if (field === 'sdkPath') setSdkPath(dir);
    else if (field === 'harmonyPath') setHarmonyPath(dir);
    else setJavaPath(dir);
  }

  async function browse(field: PickField, title: string) {
    const r = await api.openDirDialog(title);
    if (!r.ok || !r.data) return;
    const kind = FIELD_KIND[field];
    // 环境目录：选中后先检测，目录里没有对应环境时弹“浏览其他路径 / 在此安装”
    if (kind && field !== 'dataRoot') {
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

  /** 弹窗里“在此安装”：环境入下载队列；HarmonyOS 转官方下载页（需登录） */
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
    if (r.data.manual && r.data.url) {
      void api.openUrl(r.data.url);
      toast('已打开官方下载页（需登录华为账号），下载完成后解压到所选目录', 'ok');
    } else {
      toast('已加入下载队列，可在“下载管理”查看进度', 'ok');
    }
  }

  const mark = <T,>(setter: (v: T) => void) => (v: T) => {
    dirty.current = true;
    setter(v);
  };

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">设置</h1>
        <span className={`save-hint${hintOn ? ' show' : ''}`}>已保存</span>
        <div className="page-actions">
          <Segmented options={SECTIONS} value={section as Section} onChange={onSection} />
        </div>
      </div>
      <div key={section} className="sys-page">
        {section === 'storage' && (
          <div className="section">
            <div className="settings-row">
              <span className="settings-row-label">数据根目录</span>
              <div className="path-row">
                <input value={dataRoot} readOnly spellCheck={false} title={dataRoot} />
                <button className="btn" onClick={() => browse('dataRoot', '选择数据根目录')}>
                  浏览
                </button>
              </div>
            </div>
          </div>
        )}

        {section === 'sdk' && (
          <>
            <div className="section" style={{ marginBottom: 16 }}>
              <div className="settings-row">
                <span className="settings-row-label">Android SDK 路径</span>
                <div className="path-row">
                  <input value={sdkPath} readOnly spellCheck={false} title={sdkPath} />
                  <button className="btn" onClick={() => browse('sdkPath', '选择 Android SDK 目录')}>
                    浏览
                  </button>
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">HarmonyOS SDK 路径</span>
                <div className="path-row">
                  <input value={harmonyPath} readOnly spellCheck={false} title={harmonyPath} placeholder="未检测到" />
                  <button className="btn" onClick={() => browse('harmonyPath', '选择 HarmonyOS SDK 目录')}>
                    浏览
                  </button>
                </div>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">Java 路径</span>
                <div className="path-row">
                  <input value={javaPath} readOnly spellCheck={false} title={javaPath} />
                  <button className="btn" onClick={() => browse('javaPath', '选择 Java bin 目录或 jbr 目录')}>
                    浏览
                  </button>
                </div>
              </div>
            </div>
            <div className="section">
              <div style={{ padding: '10px 14px 14px' }}>
                <SdkPackages env={env} onChanged={refreshEnv} />
              </div>
            </div>
          </>
        )}

        {section === 'network' && (
          <div className="section">
            <div className="settings-row">
              <span className="settings-row-label">设备网络代理</span>
              <div className="proxy-row">
                <label className="switch-wrap">
                  <input
                    type="checkbox"
                    checked={proxyEnabled}
                    onChange={(e) => {
                      dirty.current = true;
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
                    dirty.current = true;
                    setProxyPort(e.target.value.replace(/[^\d]/g, ''));
                  }}
                  placeholder="7890"
                  inputMode="numeric"
                />
              </div>
            </div>
            <RoutePanel
              system="android"
              title="Android 下载线路"
              value={androidRoute}
              proxyPort={proxyPort}
              onPick={mark(setAndroidRoute)}
            />
            <RoutePanel
              system="harmonyos"
              title="HarmonyOS 下载线路"
              value={harmonyRoute}
              proxyPort={proxyPort}
              onPick={mark(setHarmonyRoute)}
            />
          </div>
        )}

        {section === 'download' && (
          <div className="section">
            <div className="settings-row">
              <span className="settings-row-label">最高下载速度</span>
              <div style={{ width: 180 }}>
                <Select
                  value={String(maxKbps)}
                  options={SPEED_OPTIONS.map((o) => ({ value: String(o.kbps), label: o.label }))}
                  onChange={(v) => mark(setMaxKbps)(Number(v))}
                />
              </div>
            </div>
            <div className="settings-row">
              <span className="settings-row-label">并行下载数</span>
              <div style={{ width: 180 }}>
                <Select
                  value={parallel}
                  options={['1', '2', '3', '4'].map((n) => ({ value: n, label: n }))}
                  onChange={(v) => mark(setParallel)(v)}
                />
              </div>
            </div>
          </div>
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
          </div>
        )}

        {section === 'agent' && <AgentPanel />}

        {section === 'about' && <About env={env} />}

        {error && <div className="error-line" style={{ marginTop: 12 }}>{error}</div>}
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
              <button className="btn btn-primary" disabled={installing} onClick={() => void installHere()}>
                {installing ? '解析中…' : installAsk.kind === 'harmonyos' ? '打开官方下载页' : `在此安装${ENV_LABELS[installAsk.kind]}`}
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
              {installAsk.kind === 'android' && '命令行工具装好后会自动续装 platform-tools 与 emulator。'}
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
