import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { SdkManager } from '../components/SdkManager.tsx';
import { DownloadsModal } from '../components/DownloadsModal.tsx';
import { Segmented } from '../components/Segmented.tsx';
import type { EnvStatus } from '../App.tsx';

type Section = 'storage' | 'sdk' | 'network' | 'download' | 'emulator';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'storage', label: '存储' },
  { id: 'sdk', label: 'SDK' },
  { id: 'network', label: '网络与代理' },
  { id: 'download', label: '下载与限速' },
  { id: 'emulator', label: '模拟器' },
];

export function Settings({ env, refreshEnv }: { env: EnvStatus | null; refreshEnv: () => void }) {
  const [section, setSection] = useState<Section>('storage');
  const [dataRoot, setDataRoot] = useState('');
  const [sdkPath, setSdkPath] = useState('');
  const [javaPath, setJavaPath] = useState('');
  const [gpuMode, setGpuMode] = useState('');
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyPort, setProxyPort] = useState('7890');
  const [unlimited, setUnlimited] = useState(true);
  const [maxKbps, setMaxKbps] = useState('2048');
  const [parallel, setParallel] = useState('2');
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<
    { routes: { name: string; ok: boolean; latencyMs: number; loss: number }[]; chosen?: string } | null
  >(null);
  const [savedAt, setSavedAt] = useState(0);
  const [hintOn, setHintOn] = useState(false);
  const [error, setError] = useState('');
  const [managing, setManaging] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const dirty = useRef(false);

  useEffect(() => {
    if (env) {
      setDataRoot(env.settings.dataRoot);
      // 检测到的路径直接回填，只读展示；修改只能通过「浏览」
      setSdkPath(env.settings.sdkPath ?? env.sdk?.root ?? '');
      setJavaPath(env.settings.javaPath ?? env.java ?? '');
      setGpuMode(env.settings.gpuMode ?? 'swiftshader_indirect');
      setProxyEnabled(env.settings.proxyEnabled === true);
      setProxyPort(env.settings.proxyPort ? String(env.settings.proxyPort) : '7890');
      const kb = env.settings.maxDownloadKbps;
      setUnlimited(!kb || kb <= 0);
      setMaxKbps(kb && kb > 0 ? String(kb) : '2048');
      setParallel(env.settings.parallelDownloads ? String(env.settings.parallelDownloads) : '2');
    }
  }, [env]);

  // 「已保存」提示显示 1.8 秒后淡出
  useEffect(() => {
    if (!savedAt) return;
    setHintOn(true);
    const t = setTimeout(() => setHintOn(false), 1800);
    return () => clearTimeout(t);
  }, [savedAt]);

  // 自动保存：改动 600ms 后落盘，无需保存按钮
  useEffect(() => {
    if (!dirty.current || !dataRoot.trim()) return;
    const timer = setTimeout(async () => {
      setError('');
      const port = Number(proxyPort);
      const kb = unlimited ? 0 : Number(maxKbps);
      const r = await api.saveSettings({
        dataRoot: dataRoot.trim(),
        sdkPath: sdkPath.trim() || undefined,
        javaPath: javaPath.trim() || undefined,
        gpuMode: gpuMode || undefined,
        proxyEnabled,
        proxyPort: Number.isFinite(port) && port >= 1 && port <= 65535 ? port : undefined,
        maxDownloadKbps: Number.isFinite(kb) && kb >= 0 ? Math.round(kb) : 0,
        parallelDownloads: Number(parallel) || 2,
      });
      if (!r.ok) setError(r.error);
      else {
        setSavedAt(Date.now());
        refreshEnv();
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [dataRoot, sdkPath, javaPath, gpuMode, proxyEnabled, proxyPort, unlimited, maxKbps, parallel, refreshEnv]);

  const markDirty = (setter: (v: string) => void) => (v: string) => {
    dirty.current = true;
    setter(v);
  };

  async function browse(field: 'dataRoot' | 'sdkPath' | 'javaPath', title: string) {
    const r = await api.openDirDialog(title);
    if (r.ok && r.data) {
      dirty.current = true;
      if (field === 'dataRoot') setDataRoot(r.data);
      else if (field === 'sdkPath') setSdkPath(r.data);
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

  const [removingPkg, setRemovingPkg] = useState('');

  async function removeImage(pkg: string) {
    if (!window.confirm(`删除镜像 ${pkg}？`)) return;
    setRemovingPkg(pkg);
    setError('');
    const r = await api.sdkUninstall(pkg);
    if (!r.ok) setError(r.error);
    refreshEnv();
    setRemovingPkg('');
  }

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">设置</h1>
        <span className={`save-hint${hintOn ? ' show' : ''}`}>已保存</span>
        <div className="page-actions">
          <Segmented options={SECTIONS} value={section} onChange={setSection} />
        </div>
      </div>
      <div key={section} className="sys-page">
        <div className="settings-form">
          {section === 'storage' && (
            <>
              <div className="form-row">
                <label>数据根目录（项目、设备与记录存放位置）</label>
                <div className="path-row">
                  <input value={dataRoot} readOnly spellCheck={false} title={dataRoot} />
                  <button className="btn" onClick={() => browse('dataRoot', '选择数据根目录')}>
                    浏览
                  </button>
                </div>
                <div className="form-hint">修改后新数据写到新位置，已有项目需要自行迁移目录。</div>
              </div>
            </>
          )}

          {section === 'sdk' && (
            <>
              <div className="path-grid">
                <div className="form-row">
                  <label>Android SDK 路径</label>
                  <div className="path-row">
                    <input value={sdkPath} readOnly spellCheck={false} title={sdkPath} />
                    <button className="btn" onClick={() => browse('sdkPath', '选择 Android SDK 目录')}>
                      浏览
                    </button>
                  </div>
                </div>
                <div className="form-row">
                  <label>Java 路径</label>
                  <div className="path-row">
                    <input value={javaPath} readOnly spellCheck={false} title={javaPath} />
                    <button className="btn" onClick={() => browse('javaPath', '选择 Java bin 目录或 jbr 目录')}>
                      浏览
                    </button>
                  </div>
                </div>
              </div>
              {env && (
                <div className="form-row">
                  <label>已装镜像（{env.images.length} 个）</label>
                  <div className="sdk-list" style={{ maxHeight: 240 }}>
                    {env.images.length === 0 && <div className="empty">暂无镜像，通过下方管理 SDK 安装</div>}
                    {env.images.map((img) => (
                      <div key={img.pkg} className="img-row">
                        <div className="sdk-pkg">
                          <span className="mono">
                            Android（API {img.api}）· {img.tag} · {img.abi}
                          </span>
                        </div>
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={removingPkg !== ''}
                          onClick={() => removeImage(img.pkg)}
                        >
                          {removingPkg === img.pkg ? '删除中' : '删除'}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="sdk-manage-row">
                <button className="btn" onClick={() => setManaging(true)} disabled={!!env && !env.sdk}>
                  管理 SDK
                </button>
                <button className="btn" onClick={() => setDownloadsOpen(true)}>
                  下载管理
                </button>
                <span className="form-hint" style={{ marginTop: 0 }}>
                  安装/卸载组件；查看下载进度、速度与剩余时间
                </span>
              </div>
            </>
          )}

          {section === 'network' && (
            <>
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
            </>
          )}

          {section === 'download' && (
            <>
              <div className="form-row">
                <label>最高下载速度</label>
                <div className="proxy-row">
                  <label className="switch-wrap">
                    <input
                      type="checkbox"
                      checked={unlimited}
                      onChange={(e) => {
                        dirty.current = true;
                        setUnlimited(e.target.checked);
                      }}
                    />
                    无限制
                  </label>
                  {!unlimited && (
                    <>
                      <input
                        className="proxy-port"
                        value={maxKbps}
                        onChange={(e) => markDirty(setMaxKbps)(e.target.value.replace(/[^\d]/g, ''))}
                        inputMode="numeric"
                      />
                      <span className="proxy-addr">KB/s</span>
                    </>
                  )}
                </div>
                <div className="form-hint">
                  限制后 SDK 下载经本地整形代理按配额转发字节，对每个下载任务生效。
                </div>
              </div>
              <div className="form-row">
                <label>并行下载数</label>
                <select
                  value={parallel}
                  onChange={(e) => markDirty(setParallel)(e.target.value)}
                  style={{ width: 160 }}
                >
                  <option value="1">1（逐个下载）</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                </select>
                <div className="form-hint">超出并行数的任务排队，完成一个自动开始下一个。</div>
              </div>
            </>
          )}

          {section === 'emulator' && (
            <div className="form-row">
              <label>模拟器图形后端</label>
              <select value={gpuMode} onChange={(e) => markDirty(setGpuMode)(e.target.value)}>
                <option value="swiftshader_indirect">软件渲染（兼容性最好，推荐）</option>
                <option value="angle_indirect">ANGLE / Direct3D（较快，个别驱动会黑屏）</option>
                <option value="host">宿主 GPU（最快，需独立显卡，易崩溃）</option>
              </select>
              <div className="form-hint">窗口黑屏时切回软件渲染；修改对下次启动生效。</div>
            </div>
          )}

          {error && <div className="error-line" style={{ border: 'none', padding: '0 0 6px 1px' }}>{error}</div>}
        </div>
      </div>
      {managing && <SdkManager onClose={() => setManaging(false)} onChanged={() => refreshEnv()} />}
      {downloadsOpen && <DownloadsModal onClose={() => setDownloadsOpen(false)} />}
    </div>
  );
}
