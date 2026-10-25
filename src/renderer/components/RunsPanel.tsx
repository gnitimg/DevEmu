import { useCallback, useEffect, useState } from 'react';
import { api, type Scope } from '../api.ts';
import { fmtTime } from './Modal.tsx';
import type { RunRecord } from '../../core/types.ts';

const RESULT_LABEL: Record<string, { text: string; cls: string }> = {
  ok: { text: '通过', cls: 'ok' },
  'install-failed': { text: '安装失败', cls: 'err' },
  'launch-failed': { text: '启动失败', cls: 'err' },
  manual: { text: '手动', cls: '' },
};

export function RunsPanel({ scope, refreshKey }: { scope: Scope; refreshKey: number }) {
  const [runs, setRuns] = useState<RunRecord[] | null>(null);

  const reload = useCallback(() => {
    api.listRuns(scope).then((r) => {
      if (r.ok) setRuns(r.data.slice(0, 20));
    });
  }, [scope]);

  useEffect(() => {
    reload();
  }, [reload, refreshKey]);

  return (
    <div className="section">
      <div className="section-head">
        <h2 className="section-title">测试记录</h2>
        {runs && <span className="section-count">最近 {runs.length} 条</span>}
      </div>
      {runs === null ? (
        <div className="empty">
          <span className="spinner" />
        </div>
      ) : runs.length === 0 ? (
        <div className="empty">在 APK 库点击「测试」后，结果会记录在这里</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 100 }}>时间</th>
              <th style={{ width: 130 }}>虚拟机</th>
              <th>应用</th>
              <th style={{ width: 90 }}>结果</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const label = RESULT_LABEL[r.result] ?? { text: r.result, cls: '' };
              return (
                <tr key={r.id}>
                  <td className="num">{fmtTime(r.at)}</td>
                  <td className="mono">{r.avdName}</td>
                  <td>{r.apkLabel ?? '—'}</td>
                  <td>
                    <span className={`chip ${label.cls}`}>{label.text}</span>
                  </td>
                  <td style={{ color: 'var(--text-2)' }}>{r.note ?? ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
