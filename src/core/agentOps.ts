import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec.ts';
import { adbDevices, avdNameOf, screenshot as adbScreenshot } from './adb.ts';
import { detectHarmony, harmonyTargets } from './harmony.ts';
import { detectSdk } from './sdk.ts';
import { loadAppSettings } from './settings.ts';
import { launchEmulator, stopEmulator, findRunning } from './emulator.ts';
import { killEmulatorProcess } from './win.ts';
import { scopeKey } from './env.ts';
import type { HarmonyInfo, SdkInfo, Scope } from './types.ts';
import type { AgentDevice, AgentOps, DeviceType, ShellResult } from './agent.ts';

/**
 * Agent 控制桥的生产 AgentOps：Android 走 adb（input/uiautomator），
 * HarmonyOS 走 hdc（uitest/snapshot_display）。设备以 serial 寻址，类型在线查询。
 */

function requireSdk(): SdkInfo {
  const sdk = detectSdk(loadAppSettings().sdkPath);
  if (!sdk) throw new Error('未检测到 Android SDK，请先在 DevEmu 设置页配置');
  return sdk;
}

function requireHarmony(): HarmonyInfo {
  const harmony = detectHarmony(loadAppSettings().harmonySdkPath);
  if (!harmony) throw new Error('未检测到 HarmonyOS SDK，请先在 DevEmu 设置页配置');
  return harmony;
}

/** HTTP 作用域参数（shared / project:<id>）转内部 Scope */
function parseScopeArg(raw?: string): Scope {
  if (!raw || raw === 'shared') return { kind: 'shared' };
  const m = raw.match(/^project:([\w-]+)$/);
  if (!m) throw new Error('非法的作用域');
  return { kind: 'project', projectId: m[1]! };
}

/** 常用按键 → Android keyevent code（接受数字直接透传） */
const ANDROID_KEYS: Record<string, string> = {
  home: '3',
  back: '4',
  menu: '82',
  enter: '66',
  delete: '67',
  tab: '61',
  escape: '111',
  volume_up: '24',
  volume_down: '25',
  power: '26',
  recents: '187',
};

/** 常用按键 → HarmonyOS uitest keyEvent 名称 */
const HARMONY_KEYS: Record<string, string> = {
  home: 'Home',
  back: 'Back',
  menu: 'Menu',
  power: 'Power',
  volume_up: 'Volume_Up',
  volume_down: 'Volume_Down',
};

async function listDevices(): Promise<AgentDevice[]> {
  const settings = loadAppSettings();
  const out: AgentDevice[] = [];
  const sdk = detectSdk(settings.sdkPath);
  if (sdk) {
    try {
      for (const d of await adbDevices(sdk.adb)) {
        if (d.state !== 'device') continue;
        out.push({
          serial: d.serial,
          type: 'android',
          state: d.state,
          avdName: d.serial.startsWith('emulator-') ? await avdNameOf(sdk.adb, d.serial) : undefined,
        });
      }
    } catch {
      // adb 不可用不影响 hdc 设备列举
    }
  }
  const harmony = detectHarmony(settings.harmonySdkPath);
  if (harmony) {
    try {
      for (const t of await harmonyTargets(harmony.hdc)) {
        if (!out.some((d) => d.serial === t)) out.push({ serial: t, type: 'harmonyos', state: 'device' });
      }
    } catch {
      // hdc 服务未起或无设备
    }
  }
  return out;
}

async function screenshot(serial: string, type: DeviceType): Promise<{ data: Buffer; mime: string }> {
  if (type === 'android') {
    return { data: await adbScreenshot(requireSdk().adb, serial), mime: 'image/png' };
  }
  // HarmonyOS：设备端截图后经 hdc file recv 取回本机
  const hdc = requireHarmony().hdc;
  const remote = '/data/local/tmp/devemu_agent_shot.jpeg';
  const local = path.join(os.tmpdir(), `devemu-shot-${Date.now()}-${Math.random().toString(36).slice(2)}.jpeg`);
  try {
    const cap = await run(hdc, ['-t', serial, 'shell', 'snapshot_display', '-f', remote], { timeoutMs: 15_000 });
    if (cap.code !== 0) throw new Error('截图失败：' + (cap.stderr || cap.stdout).trim().slice(0, 160));
    const recv = await run(hdc, ['-t', serial, 'file', 'recv', remote, local], { timeoutMs: 20_000 });
    if (recv.code !== 0 || !fs.existsSync(local)) throw new Error('截图回传失败');
    return { data: fs.readFileSync(local), mime: 'image/jpeg' };
  } finally {
    fs.rmSync(local, { force: true });
    void run(hdc, ['-t', serial, 'shell', 'rm', remote], { timeoutMs: 8000 }).catch(() => undefined);
  }
}

async function tap(serial: string, type: DeviceType, x: number, y: number): Promise<void> {
  if (type === 'android') {
    await run(requireSdk().adb, ['-s', serial, 'shell', 'input', 'tap', String(x), String(y)], { timeoutMs: 15_000 });
    return;
  }
  const hdc = requireHarmony().hdc;
  await run(hdc, ['-t', serial, 'shell', 'uitest', 'uiInput', 'click', String(x), String(y)], { timeoutMs: 15_000 });
}

async function swipe(
  serial: string,
  type: DeviceType,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs: number,
): Promise<void> {
  if (type === 'android') {
    await run(
      requireSdk().adb,
      ['-s', serial, 'shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(Math.round(durationMs))],
      { timeoutMs: 30_000 },
    );
    return;
  }
  // uitest 的 swipe 参数是速度（px/s），由距离与时长换算并夹到合法区间
  const dist = Math.max(1, Math.hypot(x2 - x1, y2 - y1));
  const speed = Math.min(40_000, Math.max(200, Math.round((dist / Math.max(1, durationMs)) * 1000)));
  const hdc = requireHarmony().hdc;
  await run(
    hdc,
    ['-t', serial, 'shell', 'uitest', 'uiInput', 'swipe', String(x1), String(y1), String(x2), String(y2), String(speed)],
    { timeoutMs: 30_000 },
  );
}

/** adb/hdc 的 shell 参数都会在设备端再解析一次，文本须按单引号转义成单个参数 */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

async function inputText(serial: string, type: DeviceType, text: string, x?: number, y?: number): Promise<void> {
  const quoted = shellQuote(text);
  if (type === 'android') {
    await run(requireSdk().adb, ['-s', serial, 'shell', 'input', 'text', quoted], { timeoutMs: 20_000 });
    return;
  }
  // uiInput inputText 需要点位（先点中输入框），缺省落点为屏幕中部
  const hdc = requireHarmony().hdc;
  await run(
    hdc,
    ['-t', serial, 'shell', 'uitest', 'uiInput', 'inputText', String(x ?? 360), String(y ?? 640), quoted],
    { timeoutMs: 20_000 },
  );
}

async function pressKey(serial: string, type: DeviceType, key: string): Promise<void> {
  if (/^\d{1,4}$/.test(key)) {
    if (type !== 'android') throw new Error('HarmonyOS 暂只支持按键名，不支持数字键值');
    await run(requireSdk().adb, ['-s', serial, 'shell', 'input', 'keyevent', key], { timeoutMs: 15_000 });
    return;
  }
  const name = key.toLowerCase();
  if (type === 'android') {
    const code = ANDROID_KEYS[name];
    if (!code) throw new Error(`不支持的按键：${key}（支持 ${Object.keys(ANDROID_KEYS).join('/')} 或数字键值）`);
    await run(requireSdk().adb, ['-s', serial, 'shell', 'input', 'keyevent', code], { timeoutMs: 15_000 });
    return;
  }
  const ev = HARMONY_KEYS[name];
  if (!ev) throw new Error(`不支持的按键：${key}（支持 ${Object.keys(HARMONY_KEYS).join('/')}）`);
  const hdc = requireHarmony().hdc;
  await run(hdc, ['-t', serial, 'shell', 'uitest', 'uiInput', 'keyEvent', ev], { timeoutMs: 15_000 });
}

async function shell(serial: string, type: DeviceType, command: string): Promise<ShellResult> {
  const res =
    type === 'android'
      ? await run(requireSdk().adb, ['-s', serial, 'shell', command], { timeoutMs: 120_000 })
      : await run(requireHarmony().hdc, ['-t', serial, 'shell', command], { timeoutMs: 120_000 });
  return { code: res.code, stdout: res.stdout, stderr: res.stderr };
}

async function uiTree(serial: string, type: DeviceType): Promise<{ format: 'xml' | 'json'; content: string }> {
  if (type === 'android') {
    const adb = requireSdk().adb;
    const remote = '/sdcard/devemu_ui.xml';
    const dump = await run(adb, ['-s', serial, 'shell', 'uiautomator', 'dump', remote], { timeoutMs: 30_000 });
    if (dump.code !== 0 || /ERROR/i.test(dump.stdout)) {
      throw new Error('界面树获取失败：' + (dump.stdout || dump.stderr).trim().slice(0, 160));
    }
    try {
      const cat = await run(adb, ['-s', serial, 'shell', 'cat', remote], { timeoutMs: 15_000 });
      return { format: 'xml', content: cat.stdout };
    } finally {
      void run(adb, ['-s', serial, 'shell', 'rm', remote], { timeoutMs: 8000 }).catch(() => undefined);
    }
  }
  const hdc = requireHarmony().hdc;
  const remote = '/data/local/tmp/devemu_ui.json';
  const local = path.join(os.tmpdir(), `devemu-ui-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const dump = await run(hdc, ['-t', serial, 'shell', 'uitest', 'dumpLayout', '-p', remote], { timeoutMs: 30_000 });
    if (dump.code !== 0) throw new Error('界面树获取失败：' + (dump.stderr || dump.stdout).trim().slice(0, 160));
    const recv = await run(hdc, ['-t', serial, 'file', 'recv', remote, local], { timeoutMs: 20_000 });
    if (recv.code !== 0 || !fs.existsSync(local)) throw new Error('界面树回传失败');
    return { format: 'json', content: fs.readFileSync(local, 'utf8') };
  } finally {
    fs.rmSync(local, { force: true });
    void run(hdc, ['-t', serial, 'shell', 'rm', remote], { timeoutMs: 8000 }).catch(() => undefined);
  }
}

async function launchEmulatorOp(avdName: string, scope?: string): Promise<{ serial: string }> {
  const settings = loadAppSettings();
  const sdk = requireSdk();
  const entry = await launchEmulator(sdk, settings.dataRoot, parseScopeArg(scope), avdName, {
    gpu: settings.gpuMode ?? (process.platform === 'win32' ? 'swiftshader_indirect' : undefined),
    httpProxy: settings.proxyEnabled && settings.proxyPort ? `http://127.0.0.1:${settings.proxyPort}` : undefined,
  });
  return { serial: entry.serial };
}

async function stopEmulatorOp(avdName: string, scope?: string): Promise<void> {
  const sdk = requireSdk();
  const sc = parseScopeArg(scope);
  const entry = findRunning(scopeKey(sc), avdName);
  if (entry) {
    await stopEmulator(sdk, entry);
    return;
  }
  // 控制桥在应用重启后会丢失运行注册表：按 adb 兜底关闭
  const devices = await adbDevices(sdk.adb);
  let found = false;
  for (const d of devices) {
    if (!d.serial.startsWith('emulator-') || d.state !== 'device') continue;
    if ((await avdNameOf(sdk.adb, d.serial)) === avdName) {
      found = true;
      await run(sdk.adb, ['-s', d.serial, 'emu', 'kill'], { timeoutMs: 8000 }).catch(() => undefined);
    }
  }
  if (!found) throw new Error('该虚拟机未在运行');
  await new Promise((r) => setTimeout(r, 3000));
  await killEmulatorProcess(avdName).catch(() => undefined);
}

export function createAgentOps(): AgentOps {
  return {
    listDevices,
    screenshot,
    tap,
    swipe,
    inputText,
    pressKey,
    shell,
    uiTree,
    launchEmulator: launchEmulatorOp,
    stopEmulator: stopEmulatorOp,
  };
}
