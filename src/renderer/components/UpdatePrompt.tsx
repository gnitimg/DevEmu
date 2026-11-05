import { useEffect, useState, type ReactNode } from 'react';
import {
  api,
  onUpdateAvailable,
  onUpdateDownloaded,
  onUpdateError,
  onUpdateProgress,
  type UpdateProgressPayload,
} from '../api.ts';
import { toast } from './Toast.tsx';
import { Markdown } from './Markdown.tsx';
import { Modal, fmtSize } from './Modal.tsx';

type Phase =
  | 'hidden'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'restarting';

const TITLES: Record<Exclude<Phase, 'hidden'>, (v: string) => string> = {
  available: (v) => `发现新版本 v${v}`,
  downloading: (v) => `正在下载 v${v}`,
  downloaded: (v) => `v${v} 已就绪`,
  restarting: (v) => `正在安装 v${v}`,
};

/** 全局更新弹窗：自动检查发现新版本、下载进度与就绪态都从这里展示，挂 App 顶层常驻监听 */
export function UpdatePrompt() {
  const [phase, setPhase] = useState<Phase>('hidden');
  const [info, setInfo] = useState<{
    latest: string;
    current: string;
    notes: string;
  } | null>(null);
  const [progress, setProgress] = useState<UpdateProgressPayload>({
    received: 0,
    total: 0,
  });

  useEffect(() => {
    const un1 = onUpdateAvailable((p) => {
      setInfo({ latest: p.latest, current: p.current, notes: p.notes });
      setPhase('available');
    });
    const un2 = onUpdateProgress((p) => {
      setProgress(p);
      // 完成与安装中的状态不被迟到进度帧拉回
      setPhase((cur) =>
        cur === 'downloaded' || cur === 'restarting' ? cur : 'downloading',
      );
    });
    const un3 = onUpdateDownloaded(() => setPhase('downloaded'));
    const un4 = onUpdateError((p) => {
      toast(p.message);
      setPhase((cur) => (cur === 'restarting' ? cur : 'hidden'));
    });
    return () => {
      un1();
      un2();
      un3();
      un4();
    };
  }, []);

  // 下载中关掉弹窗只收起界面，下载在主进程继续，完成后 update:downloaded 会再弹
  if (phase === 'hidden' || !info) return null;

  const pct =
    progress.total > 0
      ? Math.min(100, Math.round((progress.received / progress.total) * 100))
      : 0;

  async function download() {
    setPhase('downloading');
    setProgress({ received: 0, total: 0 });
    const r = await api.updateDownload();
    if (!r.ok) {
      toast(r.error);
      setPhase('hidden');
    }
  }

  async function cancel() {
    await api.updateCancel();
    setPhase('hidden');
  }

  async function install() {
    setPhase('restarting');
    const r = await api.updateInstall();
    if (!r.ok) {
      toast(r.error);
      setPhase('downloaded');
    }
  }

  const footers: Partial<Record<Exclude<Phase, 'hidden'>, ReactNode>> = {
    available: (
      <>
        <button className="btn" onClick={() => setPhase('hidden')}>
          以后再说
        </button>
        <button className="btn btn-primary" onClick={() => void download()}>
          下载并安装
        </button>
      </>
    ),
    downloading: (
      <button className="btn" onClick={() => void cancel()}>
        取消下载
      </button>
    ),
    downloaded: (
      <>
        <button className="btn" onClick={() => setPhase('hidden')}>
          稍后
        </button>
        <button className="btn btn-primary" onClick={() => void install()}>
          立即安装并重启
        </button>
      </>
    ),
  };

  return (
    <Modal
      title={TITLES[phase](info.latest)}
      onClose={() => setPhase(phase === 'restarting' ? 'restarting' : 'hidden')}
      footer={footers[phase]}
    >
      {phase === 'available' && (
        <>
          <p>
            当前版本 v{info.current}，可以更新到 v{info.latest}。
          </p>
          {info.notes && <Markdown src={info.notes} />}
        </>
      )}
      {phase === 'downloading' && (
        <div className="update-progress">
          <div className="update-bar">
            <div className="update-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="update-progress-text">
            {progress.total > 0
              ? `${fmtSize(progress.received)} / ${fmtSize(progress.total)}（${pct}%）`
              : '正在连接…'}
          </div>
        </div>
      )}
      {phase === 'downloaded' && (
        <p>安装包已下载并通过完整性校验，重启后将安装新版本。</p>
      )}
      {phase === 'restarting' && <p>正在退出应用并启动安装程序…</p>}
    </Modal>
  );
}
