import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DEFAULT_AGENT_PORT,
  agentSnippet,
  agentScriptFile,
  ensureAgentScript,
  generateAgentToken,
  startAgentBridge,
  stopAgentBridge,
  type AgentOps,
} from './agent.ts';

const TOKEN = 'test-token';

const calls: string[] = [];

const stub: AgentOps = {
  async listDevices() {
    calls.push('listDevices');
    return [
      { serial: 'emulator-5554', type: 'android', state: 'device', avdName: 'Pixel_Test' },
      { serial: '127.0.0.1:5555', type: 'harmonyos', state: 'device' },
    ];
  },
  async screenshot(serial, type) {
    calls.push(`screenshot:${serial}:${type}`);
    return { data: Buffer.from('PNGDATA'), mime: 'image/png' };
  },
  async tap(serial, type, x, y) {
    calls.push(`tap:${serial}:${type}:${x}:${y}`);
  },
  async swipe(serial, type, x1, y1, x2, y2, durationMs) {
    calls.push(`swipe:${serial}:${type}:${x1}:${y1}:${x2}:${y2}:${durationMs}`);
  },
  async inputText(serial, type, text) {
    calls.push(`text:${serial}:${type}:${text}`);
  },
  async pressKey(serial, type, key) {
    calls.push(`key:${serial}:${type}:${key}`);
  },
  async shell(serial, type, command) {
    calls.push(`shell:${serial}:${type}:${command}`);
    return { code: 0, stdout: 'hello\n', stderr: '' };
  },
  async uiTree(serial, type) {
    calls.push(`ui:${serial}:${type}`);
    return { format: 'xml', content: '<hierarchy/>' };
  },
  async launchEmulator(avdName, scope) {
    calls.push(`launch:${avdName}:${scope ?? ''}`);
    return { serial: 'emulator-5600' };
  },
  async stopEmulator(avdName, scope) {
    calls.push(`stop:${avdName}:${scope ?? ''}`);
  },
};

let base = '';

function auth(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

before(async () => {
  const port = await startAgentBridge(stub, { token: TOKEN, port: 0 });
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await stopAgentBridge();
});

test('token 生成：URL 安全且不重复', () => {
  const a = generateAgentToken();
  const b = generateAgentToken();
  assert.equal(a.length, 32);
  assert.match(a, /^[\w-]+$/);
  assert.notEqual(a, b);
});

test('snippet 包含端口、令牌与脚本路径', () => {
  const s = agentSnippet('D:\\data', 7600, 'tok');
  assert.match(s, /http:\/\/127\.0\.0\.1:7600/);
  assert.match(s, /DEVEMU_TOKEN[^]*tok/);
  assert.match(s, /agent-mcp\.mjs/);
  assert.equal(DEFAULT_AGENT_PORT > 1024, true);
});

test('ensureAgentScript 复制桥脚本到数据目录', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-agent-src-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-agent-root-'));
  fs.mkdirSync(path.join(src, 'resources'));
  fs.writeFileSync(path.join(src, 'resources', 'agent-mcp.mjs'), '// bridge');
  const dest = ensureAgentScript(root, src);
  assert.equal(dest, agentScriptFile(root));
  assert.equal(fs.readFileSync(dest, 'utf8'), '// bridge');
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('health 无需令牌', async () => {
  const res = await fetch(base + '/api/health');
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.name, 'devemu-agent');
});

test('缺令牌 / 错令牌返回 401', async () => {
  assert.equal((await fetch(base + '/api/devices')).status, 401);
  const wrong = await fetch(base + '/api/devices', { headers: { authorization: 'Bearer nope' } });
  assert.equal(wrong.status, 401);
});

test('带 Origin 的请求被拒绝（防浏览器跨站）', async () => {
  const res = await auth('GET', '/api/devices', undefined, { origin: 'http://evil.example' });
  assert.equal(res.status, 403);
});

test('设备列表与截图', async () => {
  const res = await auth('GET', '/api/devices');
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.devices.length, 2);
  assert.equal(j.devices[0].avdName, 'Pixel_Test');

  const shot = await auth('GET', '/api/device/emulator-5554/screenshot');
  assert.equal(shot.status, 200);
  assert.match(shot.headers.get('content-type') ?? '', /^image\/png/);
  assert.equal(Buffer.from(await shot.arrayBuffer()).toString(), 'PNGDATA');
  assert.ok(calls.includes('screenshot:emulator-5554:android'));
});

test('点按参数解析与非法参数', async () => {
  const okRes = await auth('POST', '/api/device/Pixel_Test/tap', { x: 120, y: 640 });
  assert.equal(okRes.status, 200);
  assert.ok(calls.includes('tap:Pixel_Test:android:120:640'), calls.join(','));

  const bad = await auth('POST', '/api/device/Pixel_Test/tap', { x: 'abc', y: 1 });
  assert.equal(bad.status, 400);
});

test('滑动默认时长 / 文本 / 按键 / shell', async () => {
  assert.equal((await auth('POST', '/api/device/emulator-5554/swipe', { x1: 1, y1: 2, x2: 3, y2: 4 })).status, 200);
  assert.ok(calls.includes('swipe:emulator-5554:android:1:2:3:4:300'), calls.join(','));

  assert.equal((await auth('POST', '/api/device/emulator-5554/text', { text: "it's ok" })).status, 200);
  assert.ok(calls.includes("text:emulator-5554:android:it's ok"));

  assert.equal((await auth('POST', '/api/device/127.0.0.1:5555/key', { key: 'back' })).status, 200);
  assert.ok(calls.includes('key:127.0.0.1:5555:harmonyos:back'));

  const shellRes = await auth('POST', '/api/device/emulator-5554/shell', { command: 'getprop ro.build.version.release' });
  assert.equal(shellRes.status, 200);
  assert.deepEqual(await shellRes.json(), { code: 0, stdout: 'hello\n', stderr: '' });
});

test('ui 树 / 不在线设备 / 未知接口 / 405', async () => {
  const ui = await auth('GET', '/api/device/emulator-5554/ui');
  assert.equal((await ui.json()).format, 'xml');

  assert.equal((await auth('GET', '/api/device/nope/screenshot')).status, 404);

  assert.equal((await auth('GET', '/api/unknown')).status, 404);

  const wrongMethod = await auth('DELETE', '/api/devices');
  assert.equal(wrongMethod.status, 405);
});

test('虚拟机启停：作用域校验', async () => {
  const launch = await auth('POST', '/api/emulator/launch', { avdName: 'Pixel_Test' });
  assert.equal(launch.status, 200);
  assert.deepEqual(await launch.json(), { serial: 'emulator-5600' });
  assert.ok(calls.includes('launch:Pixel_Test:'), calls.join(','));

  const scoped = await auth('POST', '/api/emulator/stop', { avdName: 'Pixel_Test', scope: 'project:demo-1' });
  assert.equal(scoped.status, 200);
  assert.ok(calls.includes('stop:Pixel_Test:project:demo-1'));

  assert.equal((await auth('POST', '/api/emulator/launch', { avdName: 'x', scope: '../etc' })).status, 400);
  assert.equal((await auth('POST', '/api/emulator/launch', { avdName: 'bad name!' })).status, 400);
});
