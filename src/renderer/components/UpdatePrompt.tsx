import { useEffect, useState, type ReactNode } from 'react';
import { api, onUpdateAvailable, onUpdateDownloaded, onUpdateError } from '../api.ts';
import { toast } from './Toast.tsx';
import { Markdown } from './Markdown.tsx';
import { Modal } from './Modal.tsx';

type Phase = 'hidden' | 'available' | 'downloaded' | 'restarting';

const TITLES: Record<Exclude<Phase, 'hidden'>, (v: string) => string> = {
  available: (v) => `发现新版本 v${v}`,
  downloaded: (v) => `v${v} 已就绪`,
  restarting: (v) => `正在安装 v${v}`,
};

/** 全局更新弹窗：发现新版本提示与安装就绪提示。下载过程不再由本弹窗展示——
 *  进度在下载管理 + 侧栏通知卡已有完整呈现，点“下载并安装”后立即收起避免重复 */
export function UpdatePrompt() {
  const [phase, setPhase] = useState<Phase>('hidden');
  const [info, setInfo] = useState<{
    latest: string;
    current: string;
    notes: string;
  } | null>(null);

  useEffect(() => {
    const un1 = onUpdateAvailable((p) => {
      setInfo({ latest: p.latest, current: p.current, notes: p.notes });
      setPhase('available');
    });
    const un2 = onUpdateDownloaded((p) => {
      // 渲染层中途重载（dev HMR）会丢 info：payload 里带版本号兜底恢复
      setInfo((cur) => cur ?? { latest: p.version, current: '', notes: '' });
      setPhase((cur) => (cur === 'restarting' ? cur : 'downloaded'));
    });
    const un3 = onUpdateError((p) => {
      toast(p.message);
      setPhase((cur) => (cur === 'restarting' ? cur : 'hidden'));
    });
    return () => {
      un1();
      un2();
      un3();
    };
  }, []);

  // 下载中关掉弹窗只收起界面，下载在主进程继续，完成后 update:downloaded 会再弹
  if (phase === 'hidden' || !info) return null;

  async function download() {
    setPhase('hidden');
    await api.updateDownload();
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
      {phase === 'downloaded' && <p>安装包已下载并通过完整性校验，重启后将安装新版本。</p>}
      {phase === 'restarting' && <p>正在退出应用并启动安装程序…</p>}
    </Modal>
  );
}
