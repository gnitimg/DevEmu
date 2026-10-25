import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { SdkManager } from '../components/SdkManager.tsx';
import type { EnvStatus } from '../App.tsx';

export function Settings({ env, refreshEnv }: { env: EnvStatus | null; refreshEnv: () => void }) {
  const [dataRoot, setDataRoot] = useState('');
  const [sdkPath, setSdkPath] = useState('');
  const [javaPath, setJavaPath] = useState('');
  const [gpuMode, setGpuMode] = useState('');
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyPort, setProxyPort] = useState('7890');
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<
    { routes: { name: string; ok: boolean; latencyMs: number; loss: number }[]; chosen?: string } | null
  >(null);
  const [savedAt, setSavedAt] = useState(0);
  const [hintOn, setHintOn] = useState(false);
  const [error, setError] = useState('');
  const [managing, setManaging] = useState(false);
  const dirty = useRef(false);

  // 「已保存」提示显示 1.8 秒后淡出
  useEffect(() => {
    if (!savedAt) return;
    setHintOn(true);
    const t = setTimeout(() => setHintOn(false), 1800);
    return () => clearTimeout(t);
  }, [savedAt]);

  useEffect(() => {
    if (env) {
      setDataRoot(env.settings.dataRoot);
      setSdkPath(env.settings.sdkPath ?? '');
      setJavaPath(env.settings.javaPath ?? '');
      setGpuMode(env.settings.gpuMode ?? 'swiftshader_indirect');
      setProxyEnabled(env.settings.proxyEnabled === true);
      setProxyPort(env.settings.proxyPort ? String(env.settings.proxyPort) : '7890');
    }
  }, [env]);

  // 自动保存：改动 600ms 后落盘，无需保存按钮
  useEffect(() => {
    if (!dirty.current || !dataRoot.trim()) return;
    const timer = setTimeout(async () => {
      setError('');
      const port = Number(proxyPort);
      const r = await api.saveSettings({
        dataRoot: dataRoot.trim(),
        sdkPath: sdkPath.trim() || undefined,
        javaPath: javaPath.trim() || undefined,
        gpuMode: gpuMode || undefined,
        proxyEnabled,
        proxyPort: Number.isFinite(port) && port >= 1 && port <= 65535 ? port : undefined,
      });
      if (!r.ok) setError(r.error);
      else {
        setSavedAt(Date.now());
        refreshEnv();
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [dataRoot, sdkPath, javaPath, gpuMode, proxyEnabled, proxyPort, refreshEnv]);

  const markDirty = (setter: (v: string) => void) => (v: string) => {
    dirty.current = true;
    setter(v);
  };

  async function probe() {
    setProbing(true);
    setProbeResult(null);
    const r = await api.probeRoutes();
    if (r.ok) setProbeResult(r.data);
    else setError(r.error);
    setProbing(false);
  }  async function browse(field: 'dataRoot' | 'sdkPath' | 'javaPath', title: string) {
    const r = await api.openDirDialog(title);
    if (r.ok && r.data) {
      dirty.current = true;
      if (field === 'dataRoot') setDataRoot(r.data);
      else if (field === 'sdkPath') setSdkPath(r.data);
      else setJavaPath(r.data);
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">设置</h1>
        <span className={`save-hint${hintOn ? ' show' : ''}`}>已保存</span>
      </div>
      <div className="settings-form">
        <div className="form-row">
          <label>数据根目录（项目、设备与记录存放位置）</label>
          <div className="path-row">
            <input value={dataRoot} onChange={(e) => markDirty(setDataRoot)(e.target.value)} spellCheck={false} />
            <button className="btn" onClick={() => browse('dataRoot', '选择数据根目录')}>
              浏览
            </button>
          </div>
          <div className="form-hint">修改后新数据写到新位置，已有项目需要自行迁移目录。</div>
        </div>
        <div className="form-row">
          <label>Android SDK 路径（留空则自动检测）</label>
          <div className="path-row">
            <input value={sdkPath} onChange={(e) => markDirty(setSdkPath)(e.target.value)} spellCheck={false} />
            <button className="btn" onClick={() => browse('sdkPath', '选择 Android SDK 目录')}>
              浏览
            </button>
          </div>
        </div>
        <div className="form-row">
          <label>Java 路径（留空则自动检测）</label>
          <div className="path-row">
            <input value={javaPath} onChange={(e) => markDirty(setJavaPath)(e.target.value)} spellCheck={false} />
            <button className="btn" onClick={() => browse('javaPath', '选择 Java bin 目录或 jbr 目录')}>
              浏览
            </button>
          </div>
        </div>
        {error && <div className="error-line" style={{ border: 'none', padding: '0 0 6px 1px' }}>{error}</div>}
        <div className="form-row" style={{ marginTop: 6 }}>
          <label>模拟器图形后端</label>
          <select value={gpuMode} onChange={(e) => markDirty(setGpuMode)(e.target.value)}>
            <option value="swiftshader_indirect">软件渲染（兼容性最好，推荐）</option>
            <option value="angle_indirect">ANGLE / Direct3D（较快，个别驱动会黑屏）</option>
            <option value="host">宿主 GPU（最快，需独立显卡，易崩溃）</option>
          </select>
          <div className="form-hint">窗口黑屏时切回软件渲染；修改对下次启动生效。</div>
        </div>
        <div className="form-row">
          <label>设备网络代理</label>
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
              onChange={(e) => markDirty(setProxyPort)(e.target.value.replace(/[^\d]/g, ''))}
              placeholder="7890"
              inputMode="numeric"
            />
          </div>
          <div className="form-hint">启用后启动的虚拟机网络走本机代理，对应用内联网生效。</div>
        </div>
        <div className="form-row">
          <label>SDK 下载线路</label>
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
          <div className="form-hint">测速 Google SDK 仓库的直连与代理线路，自动选延迟低、丢包低的用于 SDK 下载。</div>
        </div>
        {env && (
          <div style={{ marginTop: 20 }}>
            <div className="status-line">
              <span className="k">SDK</span>
              {env.sdk ? (
                <span style={{ color: 'var(--ok)' }}>已检测到 · {env.sdk.root}</span>
              ) : (
                <span style={{ color: 'var(--danger)' }}>未检测到</span>
              )}
            </div>
            <div className="status-line">
              <span className="k">Java</span>
              <span style={{ color: env.java ? 'var(--ok)' : 'var(--danger)' }}>{env.java ?? '未检测到'}</span>
            </div>
            <div className="status-line">
              <span className="k">已装镜像</span>
              <span>{env.images.length} 个</span>
            </div>
          </div>
        )}
        <div className="sdk-manage-row">
          <button className="btn" onClick={() => setManaging(true)} disabled={!!env && !env.sdk}>
            管理 SDK
          </button>
          <span className="form-hint" style={{ marginTop: 0 }}>
            安装、卸载平台工具与系统镜像等组件
          </span>
        </div>
      </div>
      {managing && (
        <SdkManager
          onClose={() => setManaging(false)}
          onChanged={() => {
            refreshEnv();
          }}
        />
      )}
    </div>
  );
}
