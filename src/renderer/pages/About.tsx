import { useState } from 'react';
import logoUrl from '../../../assets/icon.png';
import usageMd from '../../../assets/docs/usage.md?raw';
import termsMd from '../../../assets/docs/terms.md?raw';
import licenseMd from '../../../assets/docs/license.md?raw';
import developerMd from '../../../assets/docs/developer.md?raw';
import changelogMd from '../../../assets/docs/changelog.md?raw';
import { api } from '../api.ts';
import { Markdown } from '../components/Markdown.tsx';
import type { EnvStatus } from '../App.tsx';

const DOCS: { id: string; title: string; body: string }[] = [
  { id: 'usage', title: '使用说明', body: usageMd },
  { id: 'terms', title: '使用条款', body: termsMd },
  { id: 'license', title: '开源协议', body: licenseMd },
  { id: 'developer', title: '开发者', body: developerMd },
];

/** 关于页：文档默认折叠，点击经 md 阅读器弹窗阅读 */
export function About({ env }: { env: EnvStatus | null }) {
  const [doc, setDoc] = useState<{ title: string; body: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<{ upToDate: boolean; latest: string; current: string; url: string } | null>(null);
  const [updateError, setUpdateError] = useState('');

  async function checkUpdate() {
    setChecking(true);
    setUpdateError('');
    setUpdate(null);
    const r = await api.checkUpdate();
    setChecking(false);
    if (r.ok) setUpdate(r.data);
    else setUpdateError(r.error);
  }

  return (
    <div className="about">
      <div className="about-hero">
        <img className="about-logo" src={logoUrl} alt="DevEmu" draggable={false} />
        <div className="about-name">DevEmu</div>
        <div className="about-ver mono">v{env?.version ?? ''}</div>
        <button className="btn about-changelog" onClick={() => setDoc({ title: '更新记录', body: changelogMd })}>
          更新记录
        </button>
      </div>
      <div className="section">
        {DOCS.map((d) => (
          <button key={d.id} className="about-row" onClick={() => setDoc(d)}>
            <span>{d.title}</span>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 3.5 10.5 8 6 12.5" />
            </svg>
          </button>
        ))}
      </div>
      <div className="section">
        <div className="section-head">
          <h2 className="section-title">检查更新</h2>
          <div className="section-actions">
            <button className="btn" onClick={checkUpdate} disabled={checking}>
              {checking ? '检查中' : '检查更新'}
            </button>
          </div>
        </div>
        {update && (
          <div className="about-body">
            {update.upToDate ? (
              <p>已是最新版本（v{update.current}）</p>
            ) : (
              <p>
                发现新版本 <span className="mono">v{update.latest}</span>（当前 v{update.current}）
                <button
                  className="link-btn"
                  style={{ marginLeft: 10 }}
                  onClick={() => void api.openUrl(update.url)}
                >
                  打开下载页
                </button>
              </p>
            )}
          </div>
        )}
        {updateError && <div className="error-line">{updateError}</div>}
      </div>

      {doc && (
        <div className="overlay" onClick={() => setDoc(null)}>
          <div className="modal doc-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2 className="modal-title">{doc.title}</h2>
              <button className="modal-close" onClick={() => setDoc(null)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <Markdown src={doc.body} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
