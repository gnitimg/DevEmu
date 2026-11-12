import { run, stream } from './exec.ts';
import type { ChildProcess } from 'node:child_process';
import { stageAsciiPath, unstage } from './staging.ts';
import type { DeviceInfo } from './types.ts';

/** 解析 adb devices -l 输出 */
export function parseDevices(stdout: string): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  let inList = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('List of devices')) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const m = line.match(/^(\S+)\s+(\S+)/);
    if (!m) continue;
    devices.push({ serial: m[1]!, state: m[2]! });
  }
  return devices;
}

export async function adbDevices(adb: string): Promise<DeviceInfo[]> {
  const res = await run(adb, ['devices', '-l'], { timeoutMs: 15_000 });
  return parseDevices(res.stdout);
}

/** 通过模拟器控制台取 AVD 名（console 输出行尾混有 \r，需逐行 trim） */
export async function avdNameOf(adb: string, serial: string): Promise<string | undefined> {
  const res = await run(adb, ['-s', serial, 'emu', 'avd', 'name'], { timeoutMs: 8_000 });
  if (res.code !== 0) return undefined;
  const name = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !/^ok$/i.test(l) && !/^ko/i.test(l));
  return name || undefined;
}

/** 常见安装失败转中文 */
export function translateInstallError(stderr: string): string {
  const s = stderr.trim();
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(s)) return '安装失败：签名与已装版本不一致，请先卸载旧版';
  if (/INSTALL_FAILED_OLDER_SDK/.test(s)) return '安装失败：APK 要求的系统版本高于当前镜像';
  if (/INSTALL_FAILED_NO_MATCHING_ABIS/.test(s)) return '安装失败：APK 架构与镜像不匹配（x86_64/ARM）';
  if (/INSTALL_FAILED_INSUFFICIENT_STORAGE/.test(s)) return '安装失败：存储空间不足';
  if (/INSTALL_PARSE_FAILED/.test(s)) return '安装失败：APK 文件损坏或格式不受支持';
  if (/device offline|offline/.test(s)) return '安装失败：设备未就绪（offline），稍等启动完成再试';
  if (/device not found|more than one device/.test(s)) return '安装失败：未选中设备';
  const last = s.split(/\r?\n/).filter(Boolean).pop();
  return last ? `安装失败：${last.slice(0, 200)}` : '安装失败';
}

export async function installApk(
  adb: string,
  serial: string,
  apkPath: string,
): Promise<{ ok: boolean; error?: string }> {
  const staged = await stageAsciiPath(apkPath);
  try {
    const res = await run(adb, ['-s', serial, 'install', '-r', '-t', staged], { timeoutMs: 180_000 });
    if (res.code !== 0 || !/Success/i.test(res.stdout)) {
      return { ok: false, error: translateInstallError(res.stderr || res.stdout) };
    }
    return { ok: true };
  } finally {
    unstage(staged, apkPath);
  }
}

export async function launchApp(
  adb: string,
  serial: string,
  pkg: string,
  activity?: string,
): Promise<{ ok: boolean; error?: string }> {
  const args = activity
    ? ['-s', serial, 'shell', 'am', 'start', '-W', '-n', `${pkg}/${activity.startsWith('.') ? pkg + activity : activity}`]
    : ['-s', serial, 'shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'];
  const res = await run(adb, args, { timeoutMs: 30_000 });
  if (res.code !== 0 || /Error|error|Exception/.test(res.stdout + res.stderr)) {
    if (/No activities found|monkey aborted/.test(res.stdout + res.stderr) && activity) {
      // 指定 activity 失败时退回 monkey
      return launchApp(adb, serial, pkg);
    }
    return { ok: false, error: '启动失败：' + ((res.stderr || res.stdout).trim().split(/\r?\n/).pop() ?? '') };
  }
  return { ok: true };
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 部分系统镜像的 screencap 会先往 stdout 打警告行再输出图片数据，须剥到 PNG 签名 */
export function stripToPng(data: Buffer): Buffer {
  const off = data.indexOf(PNG_SIG);
  if (off < 0) throw new Error('截图失败：输出中不含 PNG 数据');
  return off === 0 ? data : data.subarray(off);
}

export async function screenshot(adb: string, serial: string): Promise<Buffer> {
  const res = await run(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { timeoutMs: 30_000, binary: true });
  if (res.code !== 0 || res.stdout.length < 100) throw new Error('截图失败：设备未就绪');
  return stripToPng(Buffer.from(res.stdout, 'latin1'));
}

export interface LogcatHandle {
  child: ChildProcess;
  lines: string[];
  stop(): void;
}

/** 持续抓取 logcat（保留最近 maxLines 行） */
export function logcatTail(adb: string, serial: string, maxLines = 500): LogcatHandle {
  const lines: string[] = [];
  const child = stream(adb, ['-s', serial, 'logcat', '-v', 'time'], {
    onLine: (line) => {
      lines.push(line);
      if (lines.length > maxLines * 2) lines.splice(0, lines.length - maxLines);
    },
  });
  return {
    child,
    lines,
    stop() {
      child.kill();
    },
  };
}

export async function clearData(adb: string, serial: string, pkg: string): Promise<boolean> {
  const res = await run(adb, ['-s', serial, 'shell', 'pm', 'clear', pkg], { timeoutMs: 20_000 });
  return /Success/.test(res.stdout);
}

export async function uninstall(adb: string, serial: string, pkg: string): Promise<boolean> {
  const res = await run(adb, ['-s', serial, 'uninstall', pkg], { timeoutMs: 30_000 });
  return /Success/.test(res.stdout);
}

export function parseDecorOverlays(stdout: string, deviceName: string): string[] {
  const packages = new Set([
    `com.android.internal.emulation.${deviceName}`,
    `com.android.systemui.emulation.${deviceName}`,
  ]);
  return stdout
    .split(/\r?\n/)
    .map((l) => l.match(/^\[ \]\s+(\S+)$/)?.[1])
    .filter((p): p is string => !!p && packages.has(p));
}

export async function restoreDeviceDecorations(adb: string, serial: string, deviceName: string): Promise<void> {
  if (!deviceName) return;
  const res = await run(adb, ['-s', serial, 'shell', 'cmd', 'overlay', 'list'], { timeoutMs: 15_000 });
  if (res.code !== 0) return;
  for (const pkg of parseDecorOverlays(res.stdout, deviceName)) {
    await run(adb, ['-s', serial, 'shell', 'cmd', 'overlay', 'enable', '--user', '0', pkg], {
      timeoutMs: 15_000,
    });
  }
}

/** 系统设置里的「设备名称」读 Settings.Global.DEVICE_NAME（缺省为 Build.MODEL）；
 *  与蓝牙名称一起改，模拟设备在各处显示同一名称 */
export async function setGuestDeviceName(adb: string, serial: string, name: string): Promise<void> {
  if (!name) return;
  await run(adb, ['-s', serial, 'shell', 'settings', 'put', 'global', 'device_name', name], {
    timeoutMs: 15_000,
  }).catch(() => undefined);
  await run(adb, ['-s', serial, 'shell', 'settings', 'put', 'secure', 'bluetooth_name', name], {
    timeoutMs: 15_000,
  }).catch(() => undefined);
}

/** 联网验证探测源。AOSP 默认 HTTPS 探测指向 www.google.com/generate_204，直连超时导致
 *  系统始终不给网络打 VALIDATED 标志——多邻国等应用按该标志判定离线，即使自身服务器
 *  可达（开本机代理后探测走代理才通过）。换成国内可达的 204 端点后不再依赖代理。 */
export const PORTAL_PROBE_HTTPS = 'https://connect.rom.miui.com/generate_204';

const PORTAL_PROBES: Array<[key: string, url: string]> = [
  ['captive_portal_http_url', 'http://connect.rom.miui.com/generate_204'],
  ['captive_portal_https_url', PORTAL_PROBE_HTTPS],
  ['captive_portal_fallback_url', 'http://connect.rom.miui.com/generate_204'],
  ['captive_portal_other_fallback_url', 'http://wifi.vivo.com.cn/generate_204'],
];

/** settings 持久化在 /data，重启与快照恢复都保留；已生效则无需重写 */
export function portalProbeApplied(httpsUrl: string | undefined): boolean {
  return httpsUrl === PORTAL_PROBE_HTTPS;
}

/** 覆盖联网验证探测源。返回本次是否修改了设置；重新验证由 preferCellularNetwork 触发。 */
export async function applyPortalProbes(adb: string, serial: string): Promise<boolean> {
  const cur = await run(
    adb,
    ['-s', serial, 'shell', 'settings', 'get', 'global', 'captive_portal_https_url'],
    { timeoutMs: 15_000 },
  ).catch(() => undefined);
  if (portalProbeApplied(cur?.stdout.trim())) return false;
  for (const [key, url] of PORTAL_PROBES) {
    await run(adb, ['-s', serial, 'shell', 'settings', 'put', 'global', key, url], {
      timeoutMs: 15_000,
    }).catch(() => undefined);
  }
  return true;
}

/** dumpsys connectivity 里是否有已连接的蜂窝网络（MOBILE[LTE]/MOBILE[NR] 等） */
export function mobileConnected(connectivity: string): boolean {
  return /ni\{MOBILE\[[A-Z0-9]+\] CONNECTED/.test(connectivity);
}

/** cmd wifi status 是否显示 Wi-Fi 已关闭 */
export function wifiDisabled(status: string): boolean {
  return /wifi is disabled/i.test(status);
}

/** 把默认网络切到蜂窝。模拟器虚拟 Wi-Fi 的 DNS 转发在部分宿主机上失联
 *  （guest 侧 10.0.2.3 无应答），蜂窝链路（eth0/slirp）正常；系统又总是
 *  优先 Wi-Fi，只能显式关掉它。没有蜂窝网络时保持 Wi-Fi，避免断掉唯一链路。
 *  forceRevalidate 用于探测源刚更新、而 Wi-Fi 本就关着的情况。 */
export async function preferCellularNetwork(
  adb: string,
  serial: string,
  forceRevalidate = false,
): Promise<boolean> {
  const conn = await run(adb, ['-s', serial, 'shell', 'dumpsys', 'connectivity'], {
    timeoutMs: 20_000,
  }).catch(() => undefined);
  if (!conn || !mobileConnected(conn.stdout)) return false;
  const wifi = await run(adb, ['-s', serial, 'shell', 'cmd', 'wifi', 'status'], {
    timeoutMs: 10_000,
  }).catch(() => undefined);
  const wasOff = wifi ? wifiDisabled(wifi.stdout) : false;
  if (wasOff && !forceRevalidate) return false;
  if (!wasOff) {
    await run(adb, ['-s', serial, 'shell', 'svc', 'wifi', 'disable'], {
      timeoutMs: 10_000,
    }).catch(() => undefined);
    // 等默认网络从 Wi-Fi 切走再翻数据，否则验证的还是 Wi-Fi
    await new Promise((r) => setTimeout(r, 1500));
  }
  // 蜂窝网络在 Wi-Fi 在线时就已建立，不会按新探测源重验，翻一次数据强制重验
  await run(adb, ['-s', serial, 'shell', 'svc', 'data', 'disable'], {
    timeoutMs: 10_000,
  }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1000));
  await run(adb, ['-s', serial, 'shell', 'svc', 'data', 'enable'], {
    timeoutMs: 10_000,
  }).catch(() => undefined);
  return true;
}

/** 解析 `wm size` 输出（Physical size: WxH），覆盖尺寸不作为形态依据 */
export function parseWmSize(stdout: string): { w: number; h: number } | undefined {
  const m = stdout.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!m) return undefined;
  const w = parseInt(m[1]!, 10);
  const h = parseInt(m[2]!, 10);
  if (!w || !h) return undefined;
  return { w, h };
}

/** 查询 guest 物理分辨率 */
export async function wmSize(adb: string, serial: string): Promise<{ w: number; h: number } | undefined> {
  const res = await run(adb, ['-s', serial, 'shell', 'wm', 'size'], { timeoutMs: 15_000 }).catch(() => undefined);
  return res ? parseWmSize(res.stdout) : undefined;
}

/** 等待系统启动完成且包管理服务就绪（boot_completed 置 1 后 package 服务可能仍未发布）。
 *  前期 2 秒一探，30 秒后放缓到 4 秒：冷启动可达数分钟，启动链路与自动补装
 *  两个并发等待循环共用本函数，高频轮询会持续 spawn adb。 */
export async function waitBooted(adb: string, serial: string, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let booted = false;
  while (Date.now() < deadline) {
    try {
      if (!booted) {
        const res = await run(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { timeoutMs: 8_000 });
        if (res.stdout.trim() === '1') booted = true;
      }
      if (booted) {
        const pm = await run(adb, ['-s', serial, 'shell', 'pm', 'path', 'android'], { timeoutMs: 8_000 });
        if (pm.code === 0 && /package:/.test(pm.stdout)) return true;
      }
    } catch {
      // 设备还没上线，继续等
    }
    await new Promise((r) => setTimeout(r, Date.now() - startedAt < 30_000 ? 2000 : 4000));
  }
  return false;
}
