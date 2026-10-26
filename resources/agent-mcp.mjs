#!/usr/bin/env node
/**
 * DevEmu Agent MCP 桥（零依赖，Node >= 18）。
 *
 * 经 stdio 与 MCP 客户端（ZCode / Codex CLI 等）按行交换 JSON-RPC，
 * 把工具调用转发到 DevEmu 的本机控制桥 HTTP 服务。
 *
 * 环境变量：
 *   DEVEMU_AGENT — 控制桥地址，默认 http://127.0.0.1:7531
 *   DEVEMU_TOKEN — 访问令牌（DevEmu 设置 → Agent 接入 中查看），必填
 */
import process from 'node:process';

const BASE = (process.env.DEVEMU_AGENT ?? 'http://127.0.0.1:7531').replace(/\/+$/, '');
const TOKEN = process.env.DEVEMU_TOKEN ?? '';
const SERVER_INFO = { name: 'devemu', version: '0.1.0' };

const JSON_SCHEMA = { type: 'object', properties: {}, additionalProperties: true };

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error(`无法连接 DevEmu 控制桥（${BASE}）：请确认 DevEmu 正在运行且已启用 Agent 接入`);
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch {
      // 非 JSON 错误体：保留状态码
    }
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') ?? '';
  if (ct.startsWith('image/')) {
    return { image: Buffer.from(await res.arrayBuffer()).toString('base64'), mime: ct.split(';')[0] };
  }
  return res.json();
}

/** 未指定 device 时：恰好一台在线则直接用，多台报错列出可选 */
async function pickDevice(ref) {
  const { devices = [] } = await api('GET', '/api/devices');
  const online = devices.filter((d) => d.state === 'device');
  if (ref) {
    const d = online.find((x) => x.serial === ref || x.avdName === ref);
    if (!d) {
      throw new Error(`设备 ${ref} 不在线。在线设备：${online.map((x) => x.serial).join(', ') || '无'}`);
    }
    return d;
  }
  if (online.length === 1) return online[0];
  throw new Error(
    `本机有多台在线设备，请用 device 参数指定：` +
      online.map((x) => `${x.serial}(${x.avdName ?? x.type})`).join(', '),
  );
}

async function deviceCall(args, action, body) {
  const dev = await pickDevice(args.device);
  return api('POST', `/api/device/${encodeURIComponent(dev.serial)}/${action}`, body ?? {});
}

const TOOLS = [
  {
    name: 'device_list',
    description: '列出 DevEmu 中在线的虚拟设备（Android 模拟器与 HarmonyOS 设备）',
    inputSchema: JSON_SCHEMA,
  },
  {
    name: 'device_screenshot',
    description: '截取设备当前屏幕，返回图片（用于观察界面）',
    inputSchema: {
      type: 'object',
      properties: { device: { type: 'string', description: 'serial 或 AVD 名；仅一台设备在线时可省略' } },
    },
  },
  {
    name: 'device_tap',
    description: '点击屏幕坐标 (x, y)',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        device: { type: 'string' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'device_swipe',
    description: '从 (x1, y1) 滑动到 (x2, y2)，可选时长 durationMs（默认 300）',
    inputSchema: {
      type: 'object',
      properties: {
        x1: { type: 'number' },
        y1: { type: 'number' },
        x2: { type: 'number' },
        y2: { type: 'number' },
        durationMs: { type: 'number' },
        device: { type: 'string' },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
    },
  },
  {
    name: 'device_text',
    description:
      '向当前焦点输入框输入文本（建议先 device_tap 点中输入框）。Android 暂不支持中文等非 ASCII 字符',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        x: { type: 'number', description: '仅 HarmonyOS：输入点位 x（缺省 360）' },
        y: { type: 'number', description: '仅 HarmonyOS：输入点位 y（缺省 640）' },
        device: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'device_key',
    description: '按系统按键：home / back / enter / delete / menu / volume_up / volume_down / power / recents（Android 另可传数字键值）',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, device: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'device_shell',
    description: '在设备上执行 shell 命令（如 pm list packages、dumpsys window），返回 code/stdout/stderr',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' }, device: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'device_ui',
    description: '读取当前界面控件树（Android 为 uiautomator XML，HarmonyOS 为 uitest JSON），用于定位可点击控件的坐标',
    inputSchema: {
      type: 'object',
      properties: { device: { type: 'string' } },
    },
  },
  {
    name: 'emulator_launch',
    description: '启动一个 Android 虚拟机并等待其就绪（scope 形如 shared 或 project:<id>，缺省 shared）',
    inputSchema: {
      type: 'object',
      properties: {
        avdName: { type: 'string' },
        scope: { type: 'string' },
      },
      required: ['avdName'],
    },
  },
  {
    name: 'emulator_stop',
    description: '关闭一个 Android 虚拟机',
    inputSchema: {
      type: 'object',
      properties: {
        avdName: { type: 'string' },
        scope: { type: 'string' },
      },
      required: ['avdName'],
    },
  },
];

async function callTool(name, args) {
  const a = args ?? {};
  const blocks = [];
  const addText = (text) => blocks.push({ type: 'text', text: String(text) });

  switch (name) {
    case 'device_list': {
      const { devices = [] } = await api('GET', '/api/devices');
      if (devices.length === 0) {
        addText('当前没有在线设备。请先在 DevEmu 中启动虚拟机。');
        break;
      }
      addText(
        devices
          .map((d) => `${d.serial}  ${d.type}  ${d.state}${d.avdName ? `  avd=${d.avdName}` : ''}`)
          .join('\n'),
      );
      break;
    }
    case 'device_screenshot': {
      const r = await api('GET', `/api/device/${encodeURIComponent((await pickDevice(a.device)).serial)}/screenshot`);
      blocks.push({ type: 'image', data: r.image, mimeType: r.mime });
      break;
    }
    case 'device_tap': {
      await deviceCall(a, 'tap', { x: a.x, y: a.y });
      addText(`已点击 (${a.x}, ${a.y})`);
      break;
    }
    case 'device_swipe': {
      await deviceCall(a, 'swipe', {
        x1: a.x1,
        y1: a.y1,
        x2: a.x2,
        y2: a.y2,
        ...(a.durationMs === undefined ? {} : { durationMs: a.durationMs }),
      });
      addText(`已滑动 (${a.x1}, ${a.y1}) → (${a.x2}, ${a.y2})`);
      break;
    }
    case 'device_text': {
      await deviceCall(a, 'text', {
        text: a.text,
        ...(a.x === undefined ? {} : { x: a.x }),
        ...(a.y === undefined ? {} : { y: a.y }),
      });
      addText('已输入文本');
      break;
    }
    case 'device_key': {
      await deviceCall(a, 'key', { key: a.key });
      addText(`已按键 ${a.key}`);
      break;
    }
    case 'device_shell': {
      const r = await deviceCall(a, 'shell', { command: a.command });
      const parts = [`exit=${r.code}`];
      if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
      if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
      addText(parts.join('\n'));
      break;
    }
    case 'device_ui': {
      const dev = await pickDevice(a.device);
      const r = await api('GET', `/api/device/${encodeURIComponent(dev.serial)}/ui`);
      addText(`界面控件树（${r.format}）：\n${r.content}`);
      break;
    }
    case 'emulator_launch': {
      const r = await api('POST', '/api/emulator/launch', { avdName: a.avdName, ...(a.scope ? { scope: a.scope } : {}) });
      addText(`虚拟机 ${a.avdName} 已启动，serial=${r.serial}。首次启动需等待系统就绪，可用 device_shell 查询 getprop sys.boot_completed`);
      break;
    }
    case 'emulator_stop': {
      await api('POST', '/api/emulator/stop', { avdName: a.avdName, ...(a.scope ? { scope: a.scope } : {}) });
      addText(`虚拟机 ${a.avdName} 已关闭`);
      break;
    }
    default:
      throw new Error(`未知工具：${name}`);
  }
  return { content: blocks };
}

// ---------- stdio JSON-RPC（按行分帧） ----------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function onMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // 非法行忽略
  }
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return;
  const isRequest = 'id' in msg;
  try {
    let result;
    switch (msg.method) {
      case 'initialize':
        result = {
          protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        };
        break;
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call': {
        const name = msg.params?.name;
        if (typeof name !== 'string') throw new Error('缺少工具名');
        result = await callTool(name, msg.params?.arguments);
        break;
      }
      default:
        if (isRequest) {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `方法不存在：${msg.method}` } });
        }
        return; // 通知（initialized 等）不回包
    }
    if (isRequest) send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (err) {
    if (isRequest) {
      // MCP 规范：工具执行失败以 isError 结果返回，客户端才能把消息带给模型
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] },
      });
    }
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) void onMessage(line);
  }
});
process.stdin.resume();
