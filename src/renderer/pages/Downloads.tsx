import { useEffect, useState } from 'react';
import { api, onDownloadsChanged, type DownloadItem } from '../api.ts';
import { fmtTime } from '../components/Modal.tsx';

type Snap = { active: DownloadItem[]; finished: DownloadItem[] };

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}

function fmtSpeed(bps: number): string {
  if (bps >= 1024 ** 2) return (bps / 1024 ** 2).toFixed(1) + ' MB/s';
  if (bps >= 1024) return Math.round(bps / 1024) + ' KB/s';
  return bps + ' B/s';
}

function fmtEta(sec: number): string {
  if (sec <= 0) return '计算中…';
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  return `${Math.floor(sec / 3600)} 时 ${Math.floor((sec % 3600) / 60)} 分`;
}

export function Downloads() {
  const [snap, setSnap] = useState<Snap>({ active: [], finished: [] });
  const [cancelling, setCancelling] = useState('');

  useEffect(() => {
    api.downloadsList().then((r) => {
      if (r.ok) setSnap(r.data);
    });
    const off = onDownloadsChanged((s) => setSnap(s));
    // 订阅之外每秒兜底拉取，防错过广播（主进程重启等）
    const timer = setInterval(() => {
      api.downloadsList().then((r) => {
        if (r.ok) setSnap(r.data);
      });
    }, 1000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, []);

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">下载管理</h1>
      </div>

      <div className="section">
        <div className="section-head">
          <h2 className="section-title">下载中</h2>
          {snap.active.length > 0 && <span className="section-count">{snap.active.length}</span>}
        </div>
        <div style={{ padding: '6px 14px 12px' }}>
          {snap.active.length === 0 && <div className="empty" style={{ padding: '16px 0' }}>当前没有下载任务</div>}
          {snap.active.map((d) => (
            <div key={d.pkg + d.startedAt} className="dl-item">
              <div className="dl-head">
                <span className="dl-name mono">{d.pkg}</span>
                {d.state === 'queued' && <span className="chip">排队中</span>}
                <button
                  className="btn btn-sm btn-danger"
                  disabled={cancelling !== ''}
                  onClick={async () => {
                    setCancelling(d.pkg);
                    await api.downloadsCancel(d.pkg);
                    setCancelling('');
                  }}
                >
                  {cancelling === d.pkg ? '取消中' : '取消'}
                </button>
              </div>
              <div className="dl-bar">
                <div className="dl-fill" style={{ width: `${d.percent}%` }} />
                <span className="dl-speed">
                  {d.state === 'queued' ? '等待并行槽位' : d.speedBps > 0 ? fmtSpeed(d.speedBps) : '连接中…'}
                </span>
              </div>
              <div className="dl-meta">
                <span>{d.total > 0 ? `${fmtBytes(d.downloaded)} / ${fmtBytes(d.total)}` : `${d.percent}%`}</span>
                <span>
                  {d.state === 'queued' ? '—' : `剩余 ${d.total > 0 && d.speedBps > 0 ? fmtEta(d.etaSec) : '计算中…'}`}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h2 className="section-title">已下载</h2>
          {snap.finished.length > 0 && <span className="section-count">{snap.finished.length}</span>}
        </div>
        <div style={{ padding: '6px 14px 12px' }}>
          {snap.finished.length === 0 && <div className="empty" style={{ padding: '16px 0' }}>暂无记录</div>}
          {snap.finished.map((d) => (
            <div key={d.pkg + d.startedAt} className="dl-item dl-done">
              <div className="dl-head">
                <span className="dl-name mono">{d.pkg}</span>
                <span className={`chip ${d.state === 'done' ? 'ok' : d.state === 'failed' ? 'err' : ''}`}>
                  {d.state === 'done' ? '完成' : d.state === 'failed' ? `失败${d.error ? ` · ${d.error}` : ''}` : '已取消'}
                </span>
              </div>
              <div className="dl-meta">
                <span>{d.total > 0 ? fmtBytes(d.total) : ''}</span>
                <span>{fmtTime(new Date(d.finishedAt ?? d.startedAt).toISOString())}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
