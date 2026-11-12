import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec.ts';
import { psArgs } from './win.ts';
import type { HosAvd, HosImage } from './types.ts';

export type { HosAvd, HosImage };

export interface CreateHosAvdOptions {
  name: string;
  deviceType: string;
  osVersion: string;
  /** 屏幕规格机型（Emulator.exe -screenProfile），即界面上的设备型号 */
  screenProfile?: string;
  memoryGb?: number;
  /** -storage，即 /data 数据分区容量 */
  storageGb?: number;
  /** -create 没有核数参数，创建后写入实例 config.ini 的 hw.cpu.ncore */
  cpuCores?: number;
}

/** 命令行工具包里 Emulator.exe 的位置；也兼容直接放在 sdkRoot 下的旧布局 */
export function findHosEmulator(sdkRoot?: string): string | undefined {
  const cands: string[] = [];
  if (sdkRoot) {
    cands.push(
      path.join(sdkRoot, 'command-line-tools', 'emulator', 'Emulator.exe'),
      path.join(sdkRoot, 'emulator', 'Emulator.exe'),
    );
  } else {
    const local = process.env.LOCALAPPDATA;
    if (local) {
      cands.push(
        path.join(local, 'Huawei', 'Sdk', 'command-line-tools', 'emulator', 'Emulator.exe'),
        path.join(local, 'Huawei', 'Sdk', 'emulator', 'Emulator.exe'),
      );
    }
  }
  for (const c of cands) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // 不存在：下一个
    }
  }
  return undefined;
}

/** 命令输出可能混有下载进度等提示行，取第一段 JSON */
function extractJson(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start === -1) throw new Error('模拟器返回内容无法解析');
  const open = text[start];
  const end = text.lastIndexOf(open === '[' ? ']' : '}');
  if (end <= start) throw new Error('模拟器返回内容无法解析');
  return JSON.parse(text.slice(start, end + 1));
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function parseHosList(text: string): HosAvd[] {
  if (/^\s*\[Empty\]\s*$/.test(text)) return [];
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: HosAvd[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const name = str(o.name);
    if (!name) continue;
    const width = str(o['hw.lcd.single.width']);
    const height = str(o['hw.lcd.single.height']);
    out.push({
      name,
      deviceType: str(o.deviceType) ?? '',
      osVersion: str(o['os.osVersion']) ?? '',
      apiVersion: str(o['os.apiVersion']),
      softwareVersion: str(o['os.softwareVersion']),
      productModel: str(o.productModel),
      deviceModel: str(o.deviceModel),
      ramMb: num(o['hw.ramSize']),
      storageMb: num(o['hw.dataPartitionSize']),
      cpuCores: num(o['hw.cpu.ncore']),
      instancePath: str(o.instancePath),
      resolution: width && height ? `${width}×${height}` : undefined,
      running: o.isRunning === true || o.isRunning === 'true',
    });
  }
  return out;
}

export function parseHosImages(text: string): HosImage[] {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: HosImage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const deviceType = str(o.deviceType);
    const osVersion = str(o.osVersion);
    const softwareVersion = str(o.SoftWareVersion);
    if (!deviceType || !osVersion || !softwareVersion) continue;
    out.push({
      deviceType,
      osVersion,
      softwareVersion,
      releaseType: str(o.releaseType),
      downloaded: o.downloaded === true || o.downloaded === 'true',
    });
  }
  return out;
}

export function buildCreateArgs(o: CreateHosAvdOptions): string[] {
  const args = ['-create', o.name, '-deviceType', o.deviceType, '-osVersion', o.osVersion];
  if (o.screenProfile) args.push('-screenProfile', o.screenProfile);
  if (o.memoryGb) args.push('-memory', String(o.memoryGb));
  if (o.storageGb) args.push('-storage', String(o.storageGb));
  return args;
}

/** -screenProfileList 每行形如 "Phone  - Mate 90 Pro" 或 "  - Pura 90"，机型取横线后的名字 */
export function parseHosScreenProfiles(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const dash = line.indexOf('-');
    if (dash < 0) continue;
    const name = line.slice(dash + 1).trim();
    if (name) names.push(name);
  }
  return [...new Set(names)];
}

/** 协议接受状态落在 .emu_config（DevEco/CLI 共用），逐目录检查两份协议 */
export function licenseAcceptedIn(dirs: string[]): boolean {
  for (const dir of dirs) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, '.emu_config'), 'utf8');
    } catch {
      continue;
    }
    const map: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([^:]+):\s*(.*)$/);
      if (m) map[m[1]!.trim()] = m[2]!.trim().toLowerCase();
    }
    if (
      map.HarmonyOS_Software_Service_Agreement === 'agree' &&
      map.HarmonyOS_SDK_Agreement === 'agree'
    )
      return true;
  }
  return false;
}

function licenseRoots(): string[] {
  return [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Huawei') : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Huawei') : '',
    path.join(os.homedir(), '.Huawei'),
  ].filter(Boolean);
}

/** -version 输出形如 "HarmonyOS Emulator :26.0.0.402"，协议目录按主次版本命名 */
export function parseHosEmulatorVersion(text: string): string | undefined {
  const m = /Emulator\s*:\s*(\d+)\.(\d+)/i.exec(text);
  return m ? `${m[1]}.${m[2]}` : undefined;
}

/**
 * 各版本协议的接受状态相互独立（Emulator26.0 与 Emulator6.1 各有 .emu_config），
 * 只认当前 Emulator.exe 主次版本对应的目录；未同意时 -create 会静默退出码 0 而不建虚拟机。
 */
export async function hosLicenseNeeded(emu: string): Promise<boolean> {
  const r = await run(emu, ['-version'], { timeoutMs: 20_000 });
  const ver = parseHosEmulatorVersion(`${r.stdout}\n${r.stderr}`);
  if (!ver) return true;
  return !licenseAcceptedIn(licenseRoots().map((root) => path.join(root, `Emulator${ver}`)));
}

function errText(stdout: string, stderr: string, code: number): string {
  const msg = (stderr.trim() || stdout.trim()).split(/\r?\n/).slice(-6).join('\n');
  return msg || `模拟器命令失败（退出码 ${code}）`;
}

/** 药丸窗口 id：实例名可含空格/中文，base64url 后只保留安全字符，
 *  可安全嵌入 PowerShell 字符串与窗口标题 */
export function hosPillSerial(name: string): string {
  return `hos-${Buffer.from(name, 'utf8').toString('base64url')}`;
}

/** 药丸 serial 还原实例名；非 HarmonyOS serial 返回 undefined */
export function hosPillName(serial: string): string | undefined {
  if (!serial.startsWith('hos-')) return undefined;
  try {
    const name = Buffer.from(serial.slice(4), 'base64url').toString('utf8');
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** 从 `Emulator.exe -start "<name>"` 命令行取出实例名 */
export function parseEmulatorStartName(commandLine: string): string | undefined {
  const m = /-start\s+(?:"([^"]*)"|(\S+))/.exec(commandLine);
  const name = (m?.[1] ?? m?.[2])?.trim();
  return name || undefined;
}

/**
 * 运行中的 HarmonyOS 模拟器主进程 pid：`-start` 拉起的 Emulator.exe 自身持有 Qt 设备窗口，
 * 实例名不进入命令行匹配（可能含引号/空格），只在 Node 侧比对解析结果。
 */
export async function findHosEmulatorPid(name: string): Promise<number | undefined> {
  const r = await run(
    'powershell.exe',
    psArgs(
      "$ErrorActionPreference='SilentlyContinue'\nGet-CimInstance Win32_Process -Filter \"Name='Emulator.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ),
    { timeoutMs: 20_000 },
  ).catch(() => undefined);
  if (!r || r.code !== 0) return undefined;
  const text = r.stdout.trim();
  if (!text) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  for (const item of Array.isArray(raw) ? raw : [raw]) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const pid =
      typeof o.ProcessId === 'number'
        ? o.ProcessId
        : parseInt(String(o.ProcessId ?? ''), 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const cmd = typeof o.CommandLine === 'string' ? o.CommandLine : '';
    if (parseEmulatorStartName(cmd) === name) return pid;
  }
  return undefined;
}

/** 场景模拟命令（电源/音量/旋转/截图/手势）：退出码 0 不代表成功，失败行也要识别 */
export async function runHosScenario(
  emu: string,
  name: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ ok: boolean; error?: string; stdout: string }> {
  const r = await run(emu, ['-instance', name, ...args], { timeoutMs });
  const text = `${r.stdout}\n${r.stderr}`;
  const ok = r.code === 0 && !/Scenario simulation failed/i.test(text);
  return {
    ok,
    error: ok ? undefined : errText(r.stdout, r.stderr, r.code),
    stdout: r.stdout,
  };
}

export async function listHosAvds(emu: string): Promise<HosAvd[]> {
  const r = await run(emu, ['-list', '-details'], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(errText(r.stdout, r.stderr, r.code));
  return parseHosList(r.stdout);
}

/** 联网拉取官方镜像清单（含未下载项），慢时由调用方超时 */
export async function listHosImages(emu: string): Promise<HosImage[]> {
  const r = await run(emu, ['-imageList'], { timeoutMs: 180_000 });
  if (r.code !== 0) throw new Error(errText(r.stdout, r.stderr, r.code));
  return parseHosImages(r.stdout);
}

/**
 * -screenProfileList 读的是云端缓存清单，可能包含 Emulator.exe 尚未内嵌的机型（如 Mate 90 系列）；
 * 这类机型 -create 会以退出码 0 静默失败，只有内嵌机型表（可执行文件里 NUL 分隔的字符串）才建得出来。
 */
export function pickCreatableProfiles(exe: Buffer, names: string[]): string[] {
  const kept = names.filter((n) => exe.includes(`\0${n}\0`));
  // 内嵌表格式变了就全部保留，宁可让创建时报错也不能把机型列表清空
  return kept.length ? kept : names;
}

interface ProfileScan {
  key: string;
  hits: Map<string, boolean>;
}

const profileScans = new Map<string, ProfileScan>();

async function creatableProfiles(emu: string, names: string[]): Promise<string[]> {
  if (!names.length) return names;
  let scan = profileScans.get(emu);
  try {
    const st = await fs.promises.stat(emu);
    const key = `${st.size}:${st.mtimeMs}`;
    if (!scan || scan.key !== key) {
      scan = { key, hits: new Map() };
      profileScans.set(emu, scan);
    }
  } catch {
    return names;
  }
  const pending = names.filter((n) => !scan!.hits.has(n));
  if (pending.length) {
    let exe: Buffer;
    try {
      exe = await fs.promises.readFile(emu);
    } catch {
      return names;
    }
    for (const n of pending) scan!.hits.set(n, exe.includes(`\0${n}\0`));
  }
  const kept = names.filter((n) => scan!.hits.get(n));
  return kept.length ? kept : names;
}

/** 某设备类型支持的屏幕规格机型；三折叠等类型没有机型清单，返回空数组 */
export async function listHosScreenProfiles(emu: string, deviceType: string): Promise<string[]> {
  const r = await run(emu, ['-screenProfileList', '-deviceType', deviceType], {
    timeoutMs: 60_000,
  });
  if (r.code !== 0) throw new Error(errText(r.stdout, r.stderr, r.code));
  return creatableProfiles(emu, parseHosScreenProfiles(r.stdout));
}

/**
 * -start 会拉起独立模拟器进程；前 5 秒保留输出，便于把"协议未接受"之类的
 * 秒退错误抛回界面，之后丢弃输出并 unref，避免主进程被长期占用。
 */
export function startHosAvd(
  emu: string,
  name: string,
  onEarlyError: (message: string) => void,
): void {
  const child = spawn(emu, ['-start', name], {
    cwd: path.dirname(emu),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  const startedAt = Date.now();
  let out = '';
  const onData = (b: Buffer) => {
    if (out.length < 8192) out += b.toString();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('error', (e) => onEarlyError(e.message));
  child.on('exit', (code) => {
    // 启动后很久再退出通常是被 -stop 关闭，不能当启动失败提示
    if (code && code !== 0 && Date.now() - startedAt < 15_000) onEarlyError(errText('', out, code));
  });
  setTimeout(() => {
    child.stdout?.removeListener('data', onData);
    child.stderr?.removeListener('data', onData);
    child.stdout?.resume();
    child.stderr?.resume();
    child.unref();
  }, 5_000).unref();
}

export async function stopHosAvd(emu: string, name: string): Promise<void> {
  const r = await run(emu, ['-stop', name], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(errText(r.stdout, r.stderr, r.code));
}

export async function deleteHosAvd(emu: string, name: string): Promise<void> {
  const r = await run(emu, ['-delete', name, '-force'], { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(errText(r.stdout, r.stderr, r.code));
}

/** 改写实例 config.ini 的键（缺失时补写），其余行原样保留 */
async function patchHosConfig(configIni: string, values: Record<string, string>): Promise<void> {
  let text = await fs.promises.readFile(configIni, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`, 'm');
    const line = `${key}=${value}`;
    text = re.test(text)
      ? text.replace(re, line)
      : `${text}${text.endsWith('\n') ? '' : os.EOL}${line}${os.EOL}`;
  }
  await fs.promises.writeFile(configIni, text, 'utf8');
}

/** -create 不认 CPU 核数，只能创建后改写实例 config.ini */
export async function patchHosCpuCores(configIni: string, cores: number): Promise<void> {
  await patchHosConfig(configIni, { 'hw.cpu.ncore': String(cores) });
}

/** 修改已创建实例的内存/核数；硬盘容量由镜像分区决定，不在可写范围 */
export async function patchHosHardware(
  configIni: string,
  o: { ramMb?: number; cpuCores?: number },
): Promise<void> {
  const values: Record<string, string> = {};
  if (o.ramMb !== undefined) values['hw.ramSize'] = String(o.ramMb);
  if (o.cpuCores !== undefined) values['hw.cpu.ncore'] = String(o.cpuCores);
  if (Object.keys(values).length) await patchHosConfig(configIni, values);
}

/**
 * 实例目录名与 config.ini 的 name 必须一致：只改其一会让 -list 完全看不到实例。
 * 重命名要同时搬目录、改写主配置与同级的 <名字>.ini。
 */
export async function renameHosAvd(instancePath: string, newName: string): Promise<string> {
  const oldDir = path.resolve(instancePath);
  const newDir = path.join(path.dirname(oldDir), newName);
  const oldSide = `${oldDir}.ini`;
  const newSide = `${newDir}.ini`;
  const toPosix = (p: string) => p.replace(/\\/g, '/');
  let side: string | null = null;
  try {
    side = await fs.promises.readFile(oldSide, 'utf8');
  } catch {
    // 没有伴随 ini 的实例也能被 -list 扫到
  }
  // 回滚要能把 config.ini 写回原文：patchHosConfig 是 read-modify-write，
  // 失败时文件可能已写入新 name/instancePath，目录搬回去后仍对 -list 不可见
  let configIniText: string | undefined;
  try {
    configIniText = await fs.promises.readFile(path.join(oldDir, 'config.ini'), 'utf8');
  } catch {
    // 实例没有 config.ini：无从写回，保持原 catch 语义
  }
  await fs.promises.rename(oldDir, newDir);
  try {
    await patchHosConfig(path.join(newDir, 'config.ini'), {
      name: newName,
      instancePath: toPosix(newDir),
    });
    if (side !== null) {
      await fs.promises.writeFile(
        newSide,
        side.replace(/^path=.*$/m, `path=${toPosix(newDir)}`),
        'utf8',
      );
      await fs.promises.unlink(oldSide);
    }
  } catch (e) {
    await fs.promises.rm(newSide, { force: true }).catch(() => undefined);
    if (configIniText !== undefined) {
      await fs.promises
        .writeFile(path.join(newDir, 'config.ini'), configIniText, 'utf8')
        .catch(() => undefined);
    }
    await fs.promises.rename(newDir, oldDir).catch(() => undefined);
    throw e;
  }
  return newDir;
}

export async function createHosAvd(emu: string, o: CreateHosAvdOptions): Promise<void> {
  const r = await run(emu, buildCreateArgs(o), { timeoutMs: 300_000 });
  if (r.code !== 0) throw new Error(errText(r.stdout, r.stderr, r.code));
  // 协议未接受或机型/镜像不可用时命令仍以 0 退出，列表核对是唯一可靠的失败信号
  const avds = await listHosAvds(emu);
  const created = avds.find((a) => a.name === o.name);
  if (!created)
    throw new Error(`创建失败：模拟器未生成 ${o.name}，所选机型或系统版本不可用`);
  if (o.cpuCores) {
    if (!created.instancePath) throw new Error(`无法定位 ${o.name} 的实例目录，CPU 核数未写入`);
    await patchHosCpuCores(path.join(created.instancePath, 'config.ini'), o.cpuCores);
  }
}

export async function acceptHosLicense(emu: string): Promise<void> {
  const r = await run(emu, ['-license', 'accept'], { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(errText(r.stdout, r.stderr, r.code));
}

export function buildUninstallArgs(deviceType: string, osVersion: string): string[] {
  return ['-uninstall', '-deviceType', deviceType, '-osVersion', osVersion, '-force'];
}

export async function uninstallHosImage(
  emu: string,
  deviceType: string,
  osVersion: string,
): Promise<void> {
  const r = await run(emu, buildUninstallArgs(deviceType, osVersion), { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(errText(r.stdout, r.stderr, r.code));
}

export function buildInstallArgs(deviceType: string, osVersion: string): string[] {
  // -force 跳过交互确认；缺省时 -install 可能只打印提示就以 0 退出，实际不下载
  return ['-install', '-deviceType', deviceType, '-osVersion', osVersion, '-force'];
}

/** -install 退出码 0 不代表镜像落盘，只有 -imageList 的 downloaded 才是可信信号 */
export function isImageDownloaded(
  images: HosImage[],
  deviceType: string,
  osVersion: string,
): boolean {
  return images.some((i) => i.deviceType === deviceType && i.osVersion === osVersion && i.downloaded);
}

/** 镜像下载由 Emulator.exe 自己完成，只能从输出里抓百分比 */
export function installHosImage(
  emu: string,
  deviceType: string,
  osVersion: string,
  onProgress: (percent: number | null) => void,
  onDone: (error?: string) => void,
): ChildProcess {
  const child = spawn(emu, buildInstallArgs(deviceType, osVersion), {
    cwd: path.dirname(emu),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  // 进度行以 \r 结尾且会被 chunk 切断："45.7%" 跨块会被拆成两个假百分比
  let lineBuf = '';
  const handle = (b: Buffer) => {
    const text = b.toString();
    if (out.length < 8192) out += text;
    const lines = (lineBuf + text).split(/\r\n|\r|\n/);
    lineBuf = lines.pop() ?? '';
    if (lineBuf.length > 4096) lineBuf = '';
    for (const line of lines) {
      for (const m of line.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
        const pct = Math.max(0, Math.min(100, Math.round(parseFloat(m[1]!))));
        onProgress(pct);
      }
    }
  };
  child.stdout?.on('data', handle);
  child.stderr?.on('data', handle);
  let finished = false;
  const finish = (error?: string) => {
    if (finished) return;
    finished = true;
    onDone(error);
  };
  child.on('error', (e) => finish(e.message));
  child.on('exit', (code) => {
    if (finished) return;
    if (code && code !== 0) {
      finish(errText('', out, code));
      return;
    }
    void (async () => {
      try {
        const images = await listHosImages(emu);
        if (!isImageDownloaded(images, deviceType, osVersion)) {
          const tail = out.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' ');
          finish(
            `镜像未下载：${tail || '模拟器未返回下载结果，请检查网络线路或系统地区设置后重试'}`,
          );
          return;
        }
      } catch {
        // 清单查询失败（离线/超时）不能判成下载失败
      }
      finish();
    })();
  });
  return child;
}
