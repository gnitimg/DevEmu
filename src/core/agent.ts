import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Agent 控制桥：仅监听 127.0.0.1 的 HTTP 服务，把在线虚拟设备的
 * 截图 / 点按 / 滑动 / 输入 / shell / 界面树暴露给本机 AI agent（ZCode、Codex 等）。
 *
 * 传输层不关心 adb/hdc 细节，全部设备操作经 AgentOps 注入；
 * resources/agent-mcp.mjs 是它的 MCP stdio 桥，供 agent 以 MCP 工具形式调用。
 */

export const DEFAULT_AGENT_PORT = 7531;

export type DeviceType = 'android' | 'harmonyos';

export interface AgentDevice {
  serial: string;
  type: DeviceType;
  state: string;
  avdName?: string;
}

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface AgentOps {
  listDevices(): Promise<AgentDevice[]>;
  screenshot(serial: string, type: DeviceType): Promise<{ data: Buffer; mime: string }>;
  tap(serial: string, type: DeviceType, x: number, y: number): Promise<void>;
  swipe(
    serial: string,
    type: DeviceType,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
  ): Promise<void>;
  inputText(serial: string, type: DeviceType, text: string, x?: number, y?: number): Promise<void>;
  pressKey(serial: string, type: DeviceType, key: string): Promise<void>;
  shell(serial: string, type: DeviceType, command: string): Promise<ShellResult>;
  uiTree(serial: string, type: DeviceType): Promise<{ format: 'xml' | 'json'; content: string }>;
  launchEmulator(avdName: string, scope?: string): Promise<{ serial: string }>;
  stopEmulator(avdName: string, scope?: string): Promise<void>;
}

export function generateAgentToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

const SERIAL_RE = /^[\w.:@+-]{1,80}$/;
const SCOPE_RE = /^shared$|^project:[\w-]{1,64}$/;
const AVD_RE = /^[\w.-]{1,50}$/;

/** MCP 桥脚本落盘位置：<dataRoot>/agent/agent-mcp.mjs */
export function agentScriptFile(dataRoot: string): string {
  return path.join(dataRoot, 'agent', 'agent-mcp.mjs');
}

/**
 * 把打包资源里的 MCP 桥脚本复制到数据目录。
 * 打包后脚本位于 asar 内，Electron 主进程可读而外部 node 进程不可读，
 * 必须落到普通磁盘路径供 `node agent-mcp.mjs` 启动。
 */
export function ensureAgentScript(dataRoot: string, sourceDir: string): string {
  const dest = agentScriptFile(dataRoot);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(sourceDir, 'resources', 'agent-mcp.mjs'), dest);
  return dest;
}

/** 生成给 MCP 客户端的 mcpServers 配置片段 */
export function agentSnippet(dataRoot: string, port: number, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        devemu: {
          command: 'node',
          args: [agentScriptFile(dataRoot)],
          env: { DEVEMU_AGENT: `http://127.0.0.1:${port}`, DEVEMU_TOKEN: token },
        },
      },
    },
    null,
    2,
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 解析 JSON 请求体；非法直接抛错（调用方统一回 400） */
async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象');
  return parsed as Record<string, unknown>;
}

function num(o: Record<string, unknown>, key: string): number {
  const v = Number(o[key]);
  if (!Number.isFinite(v)) throw new Error(`参数 ${key} 必须是数字`);
  return v;
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`参数 ${key} 不能为空`);
  return v;
}

/** 单次请求的路由与鉴权；token 为空时除 health 外全部拒绝 */
export async function handleAgentRequest(
  ops: AgentOps,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const route = `${method} ${url.pathname}`;

    // API 只面向本机程序；浏览器跨站调用会带 Origin 头，一律拒绝（防 CSRF 式打洞）
    if (req.headers.origin) {
      sendJson(res, 403, { error: '禁止浏览器直接访问本接口' });
      return;
    }
    if (route === 'GET /api/health') {
      sendJson(res, 200, { ok: true, name: 'devemu-agent', version: 1 });
      return;
    }
    if (!token || (req.headers.authorization ?? '') !== `Bearer ${token}`) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      sendJson(res, 401, { error: '令牌缺失或不正确' });
      return;
    }

    const m = url.pathname.match(/^\/api\/device\/([^/]+)\/(\w+)$/);
    if (m) {
      const serial = decodeURIComponent(m[1]!);
      const action = m[2]!;
      if (!SERIAL_RE.test(serial)) {
        sendJson(res, 400, { error: '非法的设备序列号' });
        return;
      }
      const devices = await ops.listDevices();
      // serial 优先精确匹配；AVD 名兜底（同名多台时拒绝，要求用 serial）
      let dev = devices.find((d) => d.serial === serial);
      if (!dev) {
        const byAvd = devices.filter((d) => d.avdName === serial);
        if (byAvd.length > 1) {
          sendJson(res, 409, { error: `存在多台名为 ${serial} 的虚拟机，请用 serial 指定` });
          return;
        }
        dev = byAvd[0];
      }
      if (!dev) {
        sendJson(res, 404, { error: `设备 ${serial} 不在线` });
        return;
      }
      await handleDeviceAction(ops, req, res, method, serial, dev.type, action);
      return;
    }

    if (url.pathname === '/api/devices') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: '方法不允许' });
        return;
      }
      sendJson(res, 200, { devices: await ops.listDevices() });
      return;
    }

    if (url.pathname === '/api/emulator/launch' || url.pathname === '/api/emulator/stop') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: '方法不允许' });
        return;
      }
      const body = await readJsonObject(req);
      const avdName = str(body, 'avdName');
      if (!AVD_RE.test(avdName)) throw new Error('非法的虚拟机名称');
      const scope = body.scope === undefined ? undefined : String(body.scope);
      if (scope !== undefined && !SCOPE_RE.test(scope)) throw new Error('非法的作用域');
      if (url.pathname.endsWith('/launch')) {
        sendJson(res, 200, await ops.launchEmulator(avdName, scope));
      } else {
        await ops.stopEmulator(avdName, scope);
        sendJson(res, 200, { ok: true });
      }
      return;
    }

    sendJson(res, 404, { error: '未知接口' });
  } catch (err) {
    const msg = errMessage(err);
    sendJson(res, msg.includes('JSON') || msg.startsWith('参数 ') || msg.includes('非法') ? 400 : 500, { error: msg });
  }
}

async function handleDeviceAction(
  ops: AgentOps,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  serial: string,
  type: DeviceType,
  action: string,
): Promise<void> {
  if (action === 'screenshot' || action === 'ui') {
    if (method !== 'GET') {
      sendJson(res, 405, { error: '方法不允许' });
      return;
    }
    if (action === 'screenshot') {
      const { data, mime } = await ops.screenshot(serial, type);
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length });
      res.end(data);
    } else {
      sendJson(res, 200, await ops.uiTree(serial, type));
    }
    return;
  }

  if (method !== 'POST') {
    sendJson(res, 405, { error: '方法不允许' });
    return;
  }
  const body = await readJsonObject(req);
  switch (action) {
    case 'tap': {
      await ops.tap(serial, type, num(body, 'x'), num(body, 'y'));
      sendJson(res, 200, { ok: true });
      return;
    }
    case 'swipe': {
      const duration = body.durationMs === undefined ? 300 : num(body, 'durationMs');
      if (duration < 0 || duration > 60_000) throw new Error('参数 durationMs 取值 0-60000');
      await ops.swipe(serial, type, num(body, 'x1'), num(body, 'y1'), num(body, 'x2'), num(body, 'y2'), duration);
      sendJson(res, 200, { ok: true });
      return;
    }
    case 'text': {
      const text = str(body, 'text');
      const x = body.x === undefined ? undefined : num(body, 'x');
      const y = body.y === undefined ? undefined : num(body, 'y');
      await ops.inputText(serial, type, text, x, y);
      sendJson(res, 200, { ok: true });
      return;
    }
    case 'key': {
      await ops.pressKey(serial, type, str(body, 'key'));
      sendJson(res, 200, { ok: true });
      return;
    }
    case 'shell': {
      sendJson(res, 200, await ops.shell(serial, type, str(body, 'command')));
      return;
    }
    default:
      sendJson(res, 404, { error: '未知接口' });
  }
}

// ---------- 桥生命周期（进程内单例） ----------

let bridge: { server: http.Server } | null = null;

export function agentBridgeRunning(): boolean {
  return bridge !== null;
}

export function agentBridgePort(): number | undefined {
  const addr = bridge ? (bridge.server.address() as AddressInfo | null) : null;
  return addr ? addr.port : undefined;
}

/** 启动桥（已在运行则先停）；返回实际监听端口 */
export async function startAgentBridge(
  ops: AgentOps,
  opts: { token: string; port?: number },
): Promise<number> {
  if (bridge) await stopAgentBridge();
  const server = http.createServer((req, res) => {
    void handleAgentRequest(ops, opts.token, req, res);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? DEFAULT_AGENT_PORT, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
  bridge = { server };
  return port;
}

export async function stopAgentBridge(): Promise<void> {
  const b = bridge;
  bridge = null;
  if (!b) return;
  await new Promise<void>((resolve) => b.server.close(() => resolve()));
}
