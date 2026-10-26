import { useEffect, useState } from 'react';
import { api, type AgentStatus } from '../api.ts';
import { toast } from './Toast.tsx';

/** 设置页 → Agent 接入：本机 AI agent（ZCode / Codex 等）经 MCP 控制虚拟设备的开关与接入配置 */
export function AgentPanel() {
  const [st, setSt] = useState<AgentStatus | null>(null);
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.agentStatus().then((r) => {
      if (!r.ok) return;
      setSt(r.data);
      setPort(String(r.data.port));
    });
  }, []);

  async function apply(enabled: boolean, portValue: string) {
    setBusy(true);
    const r = await api.agentApply(enabled, Number(portValue) || undefined);
    setBusy(false);
    if (!r.ok) {
      toast(r.error);
      return;
    }
    setSt(r.data);
    if (r.data.startError) toast(`控制桥启动失败：${r.data.startError}`);
    else toast(enabled ? 'Agent 控制桥已启动' : 'Agent 控制桥已停止', 'ok');
  }

  async function regenerate() {
    setBusy(true);
    const r = await api.agentRegenerateToken();
    setBusy(false);
    if (!r.ok) {
      toast(r.error);
      return;
    }
    setSt(r.data);
    toast('已换发令牌', 'ok');
  }

  function copySnippet() {
    if (!st) return;
    void navigator.clipboard.writeText(st.snippet);
    toast('接入配置已复制', 'ok');
  }

  if (!st) return <div className="section" />;

  return (
    <>
      <div className="section">
        <div className="settings-row">
          <span className="settings-row-label">Agent 控制桥</span>
          <div className="proxy-row">
            <label className="switch-wrap">
              <input
                type="checkbox"
                checked={st.enabled}
                disabled={busy}
                onChange={(e) => void apply(e.target.checked, port)}
              />
              启用
            </label>
            <span className={`chip ${st.running ? 'ok' : st.enabled ? 'warn' : 'idle'}`}>
              {st.running ? `运行中 · 127.0.0.1:${st.port}` : st.enabled ? '未运行' : '未启用'}
            </span>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-row-label">监听端口</span>
          <div className="path-row">
            <input
              className="proxy-port"
              value={port}
              disabled={busy}
              inputMode="numeric"
              onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
              onBlur={() => {
                if (st.enabled && port && Number(port) !== st.port) void apply(true, port);
              }}
            />
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-row-label">访问令牌</span>
          <div className="path-row">
            <input value={st.token} readOnly spellCheck={false} className="mono" title={st.token} />
            <button className="btn" disabled={busy} onClick={() => void regenerate()}>
              重新生成
            </button>
          </div>
        </div>
        {st.startError && <div className="error-line">启动失败：{st.startError}</div>}
      </div>

      <div className="section">
        <div style={{ padding: '12px 14px 14px' }}>
          <p className="page-sub" style={{ marginTop: 0 }}>
            启用后，本机 AI 编程助手（ZCode、Codex CLI 等支持 MCP 的工具）即可直接操作在线虚拟设备：
            截图、点击、滑动、输入文字、执行 shell、读取界面控件树，用于自动化测试与问题排查。
          </p>
          <p className="page-sub" style={{ marginBottom: 10 }}>
            在客户端配置文件中加入以下 <code className="mono">mcpServers</code> 片段（需要本机已安装 Node.js）：
          </p>
          <pre className="code-block">
            {st.snippet}
            <button className="code-copy" onClick={copySnippet}>
              复制
            </button>
          </pre>
          <p className="page-sub" style={{ marginBottom: 0 }}>
            安全说明：服务仅监听本机 127.0.0.1，所有请求需携带令牌；令牌等同设备控制权，请勿外泄。
          </p>
        </div>
      </div>
    </>
  );
}
