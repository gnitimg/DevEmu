import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { SdkManager } from '../components/SdkManager.tsx';
import type { EnvStatus } from '../App.tsx';

export function Settings({ env, refreshEnv }: { env: EnvStatus | null; refreshEnv: () => void }) {
  const [dataRoot, setDataRoot] = useState('');
  const [sdkPath, setSdkPath] = useState('');
  const [javaPath, setJavaPath] = useState('');
  const [gpuMode, setGpuMode] = useState('');
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
    }
  }, [env]);

  // 自动保存：改动 600ms 后落盘，无需保存按钮
  useEffect(() => {
    if (!dirty.current || !dataRoot.trim()) return;
    const timer = setTimeout(async () => {
      setError('');
      const r = await api.saveSettings({
        dataRoot: dataRoot.trim(),
        sdkPath: sdkPath.trim() || undefined,
        javaPath: javaPath.trim() || undefined,
        gpuMode: gpuMode || undefined,
      });
      if (!r.ok) setError(r.error);
      else {
        setSavedAt(Date.now());
        refreshEnv();
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [dataRoot, sdkPath, javaPath, gpuMode, refreshEnv]);

  const markDirty = (setter: (v: string) => void) => (v: string) => {
    dirty.current = true;
    setter(v);
  };  async function browse(field: 'dataRoot' | 'sdkPath' | 'javaPath', title: string) {
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
