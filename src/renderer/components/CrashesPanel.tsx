import { useCallback, useEffect, useState } from 'react';
import { api, onCrashRecorded, type CrashRecord, type Scope } from '../api.ts';
import { Modal, fmtDateTime } from './Modal.tsx';

const KIND_LABEL: Record<CrashRecord['kind'], string> = {
  java: '应用崩溃',
  native: 'Native 崩溃',
  anr: '应用无响应',
  other: '异常',
};

const LIMIT = 50;

export function CrashesPanel({
  scope,
  os,
  device,
}: {
  scope: Scope;
  os: CrashRecord['os'];
  /** 设备详情页只展示该虚拟机；不传则为整个作用域 */
  device?: string;
}) {
  const [records, setRecords] = useState<CrashRecord[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<CrashRecord | null>(null);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);

  const match = useCallback(
    (r: CrashRecord) =>
      r.os === os && (device === undefined || r.device === device),
    [os, device],
  );

  const reload = useCallback(() => {
    api.listCrashes(scope).then((r) => {
      if (r.ok) {
        setRecords(r.data.filter(match).slice(0, LIMIT));
        setError('');
      } else setError(r.error);
    });
  }, [scope, match]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(
    () =>
      onCrashRecorded((record) => {
        if (!match(record)) return;
        setRecords((cur) =>
          cur
            ? [record, ...cur.filter((r) => r.id !== record.id)].slice(0, LIMIT)
            : cur,
        );
      }),
    [match],
  );

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    api.readCrash(scope, open.id).then((r) => {
      if (!alive) return;
      setText(r.ok ? r.data : r.error);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [open, scope]);

  const sourceOf = (r: CrashRecord) =>
    r.source === 'SYSTEM' ? 'SYSTEM' : r.sourceLabel ?? r.source;

  return (
    <div className="section">
      <div className="section-head">
        <h2 className="section-title">崩溃记录</h2>
        {records && <span className="section-count">最近 {records.length} 条</span>}
      </div>
      {error && <div className="error-line">{error}</div>}
      {records === null && !error && (
        <div className="empty">
          <span className="spinner" />
        </div>
      )}
      {records !== null && records.length === 0 && <div className="empty">暂无崩溃记录</div>}
      {records !== null && records.length > 0 && (
        <div className="crash-scroll">
          <table className="tbl crash-tbl">
            <thead>
              <tr>
                <th style={{ width: 150 }}>时间</th>
                <th style={{ width: 150 }}>机器名称</th>
                <th style={{ width: 130 }}>故障源</th>
                <th>报错内容</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr
                  key={r.id}
                  className="crash-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => setOpen(r)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setOpen(r);
                    }
                  }}
                >
                  <td className="num">{fmtDateTime(r.at)}</td>
                  <td className="mono ellipsis" title={r.device}>
                    {r.device}
                  </td>
                  <td className="ellipsis" title={r.sourceLabel ? r.source : undefined}>
                    {sourceOf(r)}
                  </td>
                  <td className="cell-ellipsis" title={r.summary}>
                    {r.summary}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <Modal
          title={`${KIND_LABEL[open.kind]} · ${open.device}`}
          className="crash-modal"
          onClose={() => setOpen(null)}
        >
          <div className="crash-meta">
            <span className="num">{fmtDateTime(open.at)}</span>
            <span>{sourceOf(open)}</span>
            {open.sourceLabel && <span className="mono">{open.source}</span>}
          </div>
          <pre className="log-box">{loading ? '读取中…' : text || open.summary}</pre>
        </Modal>
      )}
    </div>
  );
}
