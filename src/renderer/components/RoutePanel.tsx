import { useEffect, useRef, useState } from 'react';
import { api, type RouteProbe } from '../api.ts';

const HOSTS: Record<'android' | 'harmonyos', string> = {
  android: 'dl.google.com',
  harmonyos: 'developer.huawei.com',
};

function fmtSpeed(bps: number): string {
  if (bps <= 0) return '—';
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
  return `${Math.round(bps / 1024)} KB/s`;
}

/** 单条线路测速结果展示 */
function metrics(r: RouteProbe | undefined): string {
  if (!r) return '';
  if (!r.ok && r.latencyMs < 0) return '不通';
  return `${r.latencyMs}ms · ${fmtSpeed(r.speedBps)} · 丢包 ${Math.round(r.loss * 100)}%`;
}

/** 双系统 SDK 下载线路组：展开自动测速，单选线路，单条可重测 */
export function RoutePanel({
  system,
  title,
  value,
  proxyPort,
  onPick,
}: {
  system: 'android' | 'harmonyos';
  title: string;
  value: 'direct' | 'proxy';
  proxyPort: string;
  onPick: (id: 'direct' | 'proxy') => void;
}) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Partial<Record<'direct' | 'proxy', RouteProbe>>>({});
  const [testing, setTesting] = useState<Partial<Record<'direct' | 'proxy', boolean>>>({});
  const probedRef = useRef(false);

  async function probeAll() {
    setTesting({ direct: true, proxy: true });
    const r = await api.probeRoutes(system);
    if (r.ok) {
      setResults(Object.fromEntries(r.data.map((x) => [x.id, x])));
    }
    setTesting({});
  }

  async function probeOne(id: 'direct' | 'proxy') {
    setTesting((t) => ({ ...t, [id]: true }));
    const r = await api.probeRoutes(system);
    if (r.ok) {
      const hit = r.data.find((x) => x.id === id);
      if (hit) setResults((cur) => ({ ...cur, [id]: hit }));
    }
    setTesting((t) => ({ ...t, [id]: false }));
  }

  // 展开时自动测速一次
  useEffect(() => {
    if (open && !probedRef.current) {
      probedRef.current = true;
      void probeAll();
    }
  }, [open]);

  const rows: { id: 'direct' | 'proxy'; name: string; addr: string }[] = [
    { id: 'direct', name: '直连', addr: HOSTS[system] },
    { id: 'proxy', name: '本地代理', addr: proxyPort ? `127.0.0.1:${proxyPort}` : '未配置端口' },
  ];

  return (
    <div className="route-panel">
      <button className="route-head" onClick={() => setOpen((v) => !v)}>
        <span className="route-title">{title}</span>
        <span className="route-current">{rows.find((r) => r.id === value)?.name}</span>
        <svg
          className={`route-chev${open ? ' open' : ''}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 3.5 10.5 8 6 12.5" />
        </svg>
      </button>
      {open && (
        <div className="route-rows">
          {rows.map((r) => (
            <div key={r.id} className="route-row">
              <button
                className={`route-radio${value === r.id ? ' on' : ''}`}
                title="选择线路"
                onClick={() => onPick(r.id)}
              />
              <div className="route-name">
                <span>{r.name}</span>
                <span className="mono route-addr">{r.addr}</span>
              </div>
              <span className={`route-metrics mono${results[r.id] && !results[r.id]!.ok && results[r.id]!.latencyMs < 0 ? ' bad' : ''}`}>
                {metrics(results[r.id])}
              </span>
              <button className="btn btn-sm" disabled={!!testing[r.id]} onClick={() => probeOne(r.id)}>
                {testing[r.id] ? '测速中' : '测速'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
