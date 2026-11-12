import { useEffect, useState } from 'react';
import logoUrl from '../../../assets/icon.png';
import usageMd from '../../../assets/docs/usage.md?raw';
import termsMd from '../../../assets/docs/terms.md?raw';
import licenseMd from '../../../assets/docs/license.md?raw';
import androidSdkTermsMd from '../../../assets/docs/android-sdk-terms.md?raw';
import harmonyosSdkTermsMd from '../../../assets/docs/harmonyos-sdk-terms.md?raw';
import developerMd from '../../../assets/docs/developer.md?raw';
import changelogMd from '../../../assets/docs/changelog.md?raw';
import { api } from '../api.ts';
import { Markdown } from '../components/Markdown.tsx';
import { Modal } from '../components/Modal.tsx';
import { toast } from '../components/Toast.tsx';
import type { EnvStatus } from '../App.tsx';

const DOCS: { id: string; title: string; body: string }[] = [
  { id: 'usage', title: '使用说明', body: usageMd },
  { id: 'terms', title: '使用条款', body: termsMd },
  { id: 'license', title: '开源协议', body: licenseMd },
  { id: 'android-sdk-terms', title: 'Android Software Development Kit License Agreement', body: androidSdkTermsMd },
  { id: 'harmonyos-sdk-terms', title: '华为开发者服务协议', body: harmonyosSdkTermsMd },
  { id: 'developer', title: '开发者', body: developerMd },
];

/** changelog.md 按 `## vX.Y.Z` 标题拆分为各版本段落 */
function parseChangelog(src: string): { version: string; body: string }[] {
  const versions: { version: string; body: string }[] = [];
  let version = '';
  let lines: string[] = [];
  const flush = () => {
    const body = lines.join('\n').trim();
    if (version && body) versions.push({ version, body });
  };
  for (const line of src.split(/\r\n|\r|\n/)) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      flush();
      version = h2[1]!.trim();
      lines = [];
    } else if (version) {
      lines.push(line);
    }
  }
  flush();
  return versions;
}

const CHANGELOGS = parseChangelog(changelogMd);

/** 关于页：文档默认折叠，点击经 md 阅读器弹窗阅读；更新记录常驻右侧，每个版本一张子卡片 */
export function About({ env }: { env: EnvStatus | null }) {
  const [doc, setDoc] = useState<{ title: string; body: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [autoOn, setAutoOn] = useState(true);

  useEffect(() => {
    if (env) setAutoOn(env.settings.autoCheckUpdate !== false);
  }, [env]);

  async function checkUpdate() {
    setChecking(true);
    const r = await api.checkUpdate();
    setChecking(false);
    // 一次性反馈走右上角临时弹窗；发现新版本由主进程广播进全局更新弹窗与
    // 侧栏通知卡（本页不内联渲染更新卡片，避免与通知中心重复）
    if (!r.ok) toast(r.error);
    else if (r.data.upToDate) toast('您使用的已是最新版本', 'ok');
  }

  async function toggleAutoCheck(on: boolean) {
    if (!env) return;
    setAutoOn(on);
    const r = await api.saveSettings({ ...env.settings, autoCheckUpdate: on });
    if (!r.ok) {
      toast(r.error);
      setAutoOn(!on);
    }
  }

  return (
    <div className="about">
      <div className="about-hero">
        <img className="about-logo" src={logoUrl} alt="DevEmu" draggable={false} />
        <div className="about-name">DevEmu</div>
        <div className="about-ver mono">v{env?.version ?? ''}</div>
      </div>
      <div className="about-layout">
        <div className="about-main">
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
            <div className="settings-row">
              <span className="settings-row-label">自动检查更新</span>
              <label className="switch-wrap">
                <input
                  type="checkbox"
                  checked={autoOn}
                  disabled={!env}
                  onChange={(e) => void toggleAutoCheck(e.target.checked)}
                />
                启用
              </label>
            </div>
          </div>
        </div>
        <div className="section changelog-panel">
          <div className="section-head">
            <h2 className="section-title">更新记录</h2>
            <span className="section-count">{CHANGELOGS.length} 个版本</span>
          </div>
          {CHANGELOGS.length === 0 ? (
            <div className="about-body">暂无更新记录</div>
          ) : (
            CHANGELOGS.map((c) => (
              <button
                key={c.version}
                className="about-row"
                onClick={() => setDoc({ title: `更新记录 · ${c.version}`, body: c.body })}
              >
                <span className="mono">{c.version}</span>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 3.5 10.5 8 6 12.5" />
                </svg>
              </button>
            ))
          )}
        </div>
      </div>

      {doc && (
        <Modal title={doc.title} className="doc-modal" onClose={() => setDoc(null)}>
          <Markdown src={doc.body} />
        </Modal>
      )}
    </div>
  );
}
