import { run, stream } from './exec.ts';
import type { ChildProcess } from 'node:child_process';
import type { DeviceInfo } from './types.ts';

/** 解析 adb devices -l 输出 */
export function parseDevices(stdout: string): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  let inList = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (/^List of devices/.test(line)) {
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

/** 通过模拟器控制台取 AVD 名 */
export async function avdNameOf(adb: string, serial: string): Promise<string | undefined> {
  const res = await run(adb, ['-s', serial, 'emu', 'avd', 'name'], { timeoutMs: 8_000 });
  if (res.code !== 0) return undefined;
  const first = res.stdout.trim().split(/\r?\n/)[0];
  return first && !first.startsWith('OK') && !first.startsWith('ko') ? first : undefined;
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
  const res = await run(adb, ['-s', serial, 'install', '-r', '-t', apkPath], { timeoutMs: 180_000 });
  if (res.code !== 0 || !/Success/i.test(res.stdout)) {
    return { ok: false, error: translateInstallError(res.stderr || res.stdout) };
  }
  return { ok: true };
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

export async function screenshot(adb: string, serial: string): Promise<Buffer> {
  const res = await run(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { timeoutMs: 30_000, binary: true });
  if (res.code !== 0 || res.stdout.length < 100) throw new Error('截图失败：设备未就绪');
  return Buffer.from(res.stdout, 'latin1');
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

/** 等待系统启动完成（用于装包前的就绪检查） */
export async function waitBooted(adb: string, serial: string, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await run(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { timeoutMs: 8_000 });
      if (res.stdout.trim() === '1') return true;
    } catch {
      // 设备还没上线，继续等
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
