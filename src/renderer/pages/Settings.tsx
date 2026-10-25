import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { SdkPackages } from '../components/SdkPackages.tsx';
import { Segmented } from '../components/Segmented.tsx';
import { About } from './About.tsx';
import type { EnvStatus } from '../App.tsx';

export type Section = 'storage' | 'sdk' | 'network' | 'download' | 'emulator' | 'about';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'storage', label: '存储' },
  { id: 'sdk', label: 'SDK' },
  { id: 'network', label: '网络与代理' },
  { id: 'download', label: '下载与限速' },
  { id: 'emulator', label: '模拟器' },
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
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<
    { routes: { name: string; ok: boolean; latencyMs: number; loss: number }[]; chosen?: string } | null
  >(null);
  const [savedAt, setSavedAt] = useState(0);
  const [hintOn, setHintOn] = useState(false);
  const [error, setError] = useState('');
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
      });
      if (!r.ok) setError(r.error);
      else {
        setSavedAt(Date.now());
        refreshEnv();
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [dataRoot, sdkPath, harmonyPath, javaPath, gpuMode, proxyEnabled, proxyPort, maxKbps, parallel, refreshEnv]);

  async function browse(field: 'dataRoot' | 'sdkPath' | 'harmonyPath' | 'javaPath', title: string) {
    const r = await api.openDirDialog(title);
    if (r.ok && r.data) {
      dirty.current = true;
      if (field === 'dataRoot') setDataRoot(r.data);
      else if (field === 'sdkPath') setSdkPath(r.data);
      else if (field === 'harmonyPath') setHarmonyPath(r.data);
      else setJavaPath(r.data);
    }
  }

  async function probe() {
    setProbing(true);
    setProbeResult(null);
    const r = await api.probeRoutes();
    if (r.ok) setProbeResult(r.data);
    else setError(r.error);
    setProbing(false);
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
            <div className="settings-row">
              <span className="settings-row-label">SDK 下载线路</span>
              <div className="proxy-row">
                <button className="btn" onClick={probe} disabled={probing}>
                  {probing ? '测速中…' : '自动测速选择'}
                </button>
                {probeResult && (
                  <span className="probe-result">
                    {probeResult.routes.map((r) => (
                      <span key={r.name} className={probeResult.chosen === (r.name === '代理' ? 'proxy' : 'direct') ? 'probe-on' : ''}>
                        {r.name} {r.latencyMs >= 0 ? `${r.latencyMs}ms · 丢包 ${Math.round(r.loss * 100)}%` : '不通'}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {section === 'download' && (
          <div className="section">
            <div className="settings-row">
              <span className="settings-row-label">最高下载速度</span>
              <select value={String(maxKbps)} onChange={(e) => mark(setMaxKbps)(Number(e.target.value))} style={{ width: 180 }}>
                {SPEED_OPTIONS.map((o) => (
                  <option key={o.kbps} value={o.kbps}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="settings-row">
              <span className="settings-row-label">并行下载数</span>
              <select value={parallel} onChange={(e) => mark(setParallel)(e.target.value)} style={{ width: 180 }}>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
              </select>
            </div>
          </div>
        )}

        {section === 'emulator' && (
          <div className="section">
            <div className="settings-row">
              <span className="settings-row-label">图形后端</span>
              <select value={gpuMode} onChange={(e) => mark(setGpuMode)(e.target.value)} style={{ width: 200 }}>
                <option value="swiftshader_indirect">软件渲染</option>
                <option value="angle_indirect">ANGLE / Direct3D</option>
                <option value="host">宿主 GPU</option>
              </select>
            </div>
          </div>
        )}

        {section === 'about' && <About />}

        {error && <div className="error-line" style={{ marginTop: 12 }}>{error}</div>}
      </div>
    </div>
  );
}
