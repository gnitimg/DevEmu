import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { EnvStatus } from '../App.tsx';

export function Settings({ env, refreshEnv }: { env: EnvStatus | null; refreshEnv: () => void }) {
  const [dataRoot, setDataRoot] = useState('');
  const [sdkPath, setSdkPath] = useState('');
  const [javaPath, setJavaPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (env) {
      setDataRoot(env.settings.dataRoot);
      setSdkPath(env.settings.sdkPath ?? '');
      setJavaPath(env.settings.javaPath ?? '');
    }
  }, [env]);

  async function save() {
    setBusy(true);
    setError('');
    setSaved(false);
    const r = await api.saveSettings({ dataRoot: dataRoot.trim(), sdkPath: sdkPath.trim() || undefined, javaPath: javaPath.trim() || undefined });
    if (!r.ok) setError(r.error);
    else {
      setSaved(true);
      refreshEnv();
    }
    setBusy(false);
  }

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">设置</h1>
      </div>
      <div className="settings-form">
        <div className="form-row">
          <label>数据根目录（项目、设备与记录存放位置）</label>
          <input value={dataRoot} onChange={(e) => setDataRoot(e.target.value)} spellCheck={false} />
          <div className="form-hint">修改后新数据写到新位置，已有项目需要自行迁移目录。</div>
        </div>
        <div className="form-row">
          <label>Android SDK 路径（留空则自动检测）</label>
          <input value={sdkPath} onChange={(e) => setSdkPath(e.target.value)} placeholder="%LOCALAPPDATA%\Android\Sdk" spellCheck={false} />
        </div>
        <div className="form-row">
          <label>Java 路径（留空则自动检测）</label>
          <input value={javaPath} onChange={(e) => setJavaPath(e.target.value)} placeholder="java.exe 或 jbr 完整路径" spellCheck={false} />
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={save} disabled={busy || !dataRoot.trim()}>
            {busy ? '保存中' : '保存'}
          </button>
          {saved && <span style={{ color: 'var(--ok)', fontSize: 12 }}>已保存</span>}
        </div>
        {error && <div className="error-line" style={{ marginTop: 12 }}>{error}</div>}
        {env && (
          <div style={{ marginTop: 28 }}>
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
      </div>
    </div>
  );
}
