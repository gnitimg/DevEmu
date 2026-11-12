import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, stream } from './exec.ts';
import { hasCrashKey, recordCrash } from './crashes.ts';
import { findHosEmulatorPid } from './hosemu.ts';
import type { CrashKind, CrashRecord } from './types.ts';

/** 应用进程名必为反向域名包名；system_server / surfaceflinger 等无点进程归 SYSTEM */
export function isSystemProcess(name: string): boolean {
  if (!name) return true;
  const base = name.split(':')[0]!;
  return !/^[A-Za-z][\w-]*(\.[\w-]+)+$/.test(base);
}

/** EventLog 字段可能含逗号（异常消息），按前 5 列固定、末 2–3 列还原消息 */
function splitEventFields(body: string): string[] {
  return body.split(',').map((s) => s.trim());
}

export interface AndroidCrashEvent {
  at: Date;
  /** 包名/进程名；系统级为 SYSTEM */
  source: string;
  kind: CrashKind;
  summary: string;
  log: string;
}

export interface ParsedCrashEvent {
  process: string;
  source: string;
  kind: CrashKind;
  summary: string;
}

/** am_crash 字段序（android-36 EventLogTags）：User, PID, Process Name, Flags,
 *  Exception, Message, File, Line, Recoverable；Message 可含逗号 */
export function parseAmCrashLine(line: string): ParsedCrashEvent | undefined {
  const m = /am_crash\s*:\s*\[(.*)\]\s*$/.exec(line);
  if (!m) return undefined;
  const f = splitEventFields(m[1]!);
  if (f.length < 6) return undefined;
  const process = f[2] || 'SYSTEM';
  const type = f[4] && f[4] !== 'null' ? f[4] : '';
  // 末尾两个都是整数时为 Line + Recoverable，否则只有 Line
  let lineIdx = f.length - 1;
  if (/^-?\d+$/.test(f[f.length - 1]!) && /^-?\d+$/.test(f[f.length - 2]!)) {
    lineIdx = f.length - 2;
  }
  const file = f[lineIdx - 1] ?? '';
  const lineNo = f[lineIdx] ?? '';
  const message = f.slice(5, Math.max(5, lineIdx - 1)).join(', ');
  const detail = [type, message].filter(Boolean).join(': ');
  const where =
    file && file !== 'null' && lineNo && lineNo !== '-1' ? ` (${file}:${lineNo})` : '';
  return {
    process,
    source: isSystemProcess(process) ? 'SYSTEM' : process.replace(/:.*$/, ''),
    kind: /SIG(?:SEGV|ABRT|BUS|ILL|FPE|TRAP)|native/i.test(detail)
      ? 'native'
      : /ANR|Input dispatching timed out/i.test(detail)
        ? 'anr'
        : 'java',
    summary: `${detail || '应用崩溃'}${where}`.slice(0, 500),
  };
}

/** am_anr 字段序（android-36 EventLogTags）：User, pid, Package Name, Flags, reason
 *  reason 可含逗号，占满剩余字段 */
export function parseAmAnrLine(line: string): ParsedCrashEvent | undefined {
  const m = /am_anr\s*:\s*\[(.*)\]\s*$/.exec(line);
  if (!m) return undefined;
  const f = splitEventFields(m[1]!);
  if (f.length < 5) return undefined;
  const pkg = f[2] || 'SYSTEM';
  const reason = f.slice(4).join(', ').trim();
  return {
    process: pkg,
    source: isSystemProcess(pkg) ? 'SYSTEM' : pkg.replace(/:.*$/, ''),
    kind: 'anr',
    summary: `应用无响应：${reason || 'ANR'}`.slice(0, 500),
  };
}

const NATIVE_SIGNAL_RE =
  /signal\s+(\d+)\s+\(([^)]+)\),\s*code\s+(-?\d+)\s+\(([^)]+)\),\s*fault addr\s+(\S+)/;

/** logcat crash 缓冲里的 native 崩溃块（system_server 等自崩时 am_crash 事件可能缺失） */
export function parseNativeSignalLine(line: string): string | undefined {
  const m = NATIVE_SIGNAL_RE.exec(line);
  if (!m) return undefined;
  return `信号 ${m[1]} (${m[2]})，code ${m[3]} (${m[4]})，fault addr ${m[5]}`;
}

// name: 后是线程名，>>> 后才是进程名（线程可能是 RenderThread 之类）
const NATIVE_PID_RE =
  /pid:\s*\d+,\s*tid:\s*\d+,\s*name:\s*[^\s]+\s+>>>\s*([^\s]+)\s*<</;

/** tombstone 头行 → 崩溃进程名（用于在后续 signal 行归属进程） */
export function parseTombstoneProcessLine(line: string): string | undefined {
  return NATIVE_PID_RE.exec(line)?.[1];
}

/** 崩溃后抓取完整日志；ANR 无 crash 缓冲时退回主日志尾部 */
async function captureCrashLog(adb: string, serial: string): Promise<string> {
  await new Promise((r) => setTimeout(r, 1200));
  const crash = await run(
    adb,
    ['-s', serial, 'logcat', '-b', 'crash', '-d', '-v', 'threadtime', '-t', '600'],
    { timeoutMs: 20_000 },
  ).catch(() => undefined);
  if (crash?.stdout.trim()) return crash.stdout;
  const main = await run(
    adb,
    ['-s', serial, 'logcat', '-d', '-v', 'threadtime', '-t', '400'],
    { timeoutMs: 20_000 },
  ).catch(() => undefined);
  return main?.stdout ?? '';
}

/**
 * 持续监听 Android 崩溃（events + crash 缓冲）。
 * 从模拟器进程启动时就开始，能覆盖开机阶段的系统崩溃；缓冲随重启清空，不会重放旧崩溃。
 */
export function watchAndroidCrashes(
  adb: string,
  serial: string,
  onCrash: (event: AndroidCrashEvent) => void,
  opts: { skipHistory?: boolean } = {},
): { stop(): void } {
  let child: ChildProcess | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let nativeProcess: string | null = null;
  // 接管已运行的模拟器时缓冲里还留着旧崩溃：记录会带着"现在"的时间重放，
  // 从设备当前时间起读；首次启动的实例缓冲本就被开机清空，无需过滤
  let since: string | null = opts.skipHistory ? null : '';
  // am_crash 与 crash 缓冲会描述同一次崩溃：按进程短窗口去重，避免一条崩溃记两遍
  const lastEmit = new Map<string, number>();

  const emit = (event: ParsedCrashEvent) => {
    const now = Date.now();
    if (now - (lastEmit.get(event.process) ?? 0) < 15_000) return;
    lastEmit.set(event.process, now);
    void captureCrashLog(adb, serial)
      .then((log) => {
        if (stopped) return;
        onCrash({
          at: new Date(now),
          source: event.source,
          kind: event.kind,
          summary: event.summary,
          log,
        });
      })
      .catch(() => undefined);
  };

  const onLine = (line: string) => {
    if (line.includes('*** *** *** ***')) {
      nativeProcess = null;
      return;
    }
    const crash = parseAmCrashLine(line);
    if (crash) {
      emit(crash);
      return;
    }
    const anr = parseAmAnrLine(line);
    if (anr) {
      emit(anr);
      return;
    }
    const native = parseTombstoneProcessLine(line);
    if (native) {
      nativeProcess = native;
      return;
    }
    const signal = parseNativeSignalLine(line);
    if (signal && nativeProcess) {
      const process = nativeProcess;
      nativeProcess = null;
      emit({
        process,
        source: isSystemProcess(process) ? 'SYSTEM' : process.replace(/:.*$/, ''),
        kind: 'native',
        summary: signal,
      });
    }
  };

  const start = async () => {
    if (stopped) return;
    if (since === null) {
      // -T 只认 "MM-DD HH:MM:SS.mmm"（logcat 拒绝 ISO 格式）；取不到设备时间
      // 就下轮再试，不能退回整段重放
      const res = await run(
        adb,
        ['-s', serial, 'shell', 'date "+%m-%d %H:%M:%S.000"'],
        { timeoutMs: 10_000 },
      ).catch(() => undefined);
      const time = res?.code === 0 ? res.stdout.trim() : '';
      if (!/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(time)) {
        if (!stopped) retry = setTimeout(() => void start(), 3000);
        return;
      }
      since = time;
    }
    if (stopped) return;
    // adb 会把 -T 里的空格原样带进 logcat 参数：带时间的调用必须整体成一个
    // 远端命令串（时间已限定为数字/符号，单引号包裹无注入面）
    const args =
      since === ''
        ? ['-s', serial, 'logcat', '-b', 'events', '-b', 'crash', '-v', 'threadtime']
        : ['-s', serial, 'shell', `logcat -T '${since}' -b events -b crash -v threadtime`];
    const proc = stream(
      adb,
      args,
      {
        onLine,
        onExit: () => {
          if (child === proc) child = null;
          if (!stopped) retry = setTimeout(() => void start(), 3000);
        },
      },
    );
    child = proc;
  };

  void start();
  return {
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      retry = null;
      child?.kill();
      child = null;
    },
  };
}

function parseDeviceTime(value: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(value);
  if (!m) return undefined;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    m[7] ? Number(m[7].padEnd(3, '0')) : 0,
  );
}

function parseFileTime(fileName: string): Date | undefined {
  const m = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})/.exec(fileName);
  if (!m) return undefined;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    Number(m[7]),
  );
}

export interface ParsedHosCrash {
  at: Date;
  source: string;
  kind: CrashKind;
  summary: string;
}

/** faultlogger 日志头字段 + 文件名里的时间；c++/js 崩溃、应用冻结构建同一条记录 */
export function parseHosFaultlog(text: string, fileName: string, now = new Date()): ParsedHosCrash {
  const prefix = /^([a-z]+)-/.exec(fileName)?.[1] ?? '';
  const kind: CrashKind =
    prefix === 'cppcrash' ? 'native' : prefix === 'jscrash' ? 'java' : prefix === 'appfreeze' ? 'anr' : 'other';
  const field = (name: string): string => {
    const m = new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(text);
    return m?.[1]?.trim() ?? '';
  };
  const process = field('Process name') || field('Module name');
  const reason = field('Reason');
  return {
    at: parseDeviceTime(field('Timestamp')) ?? parseFileTime(fileName) ?? now,
    source: isSystemProcess(process) ? 'SYSTEM' : process,
    kind,
    summary: (reason || (kind === 'anr' ? '应用无响应' : '应用崩溃')).slice(0, 500),
  };
}

const FAULTLOG_RE = /^([a-z]+)-.*-(\d{17})\.log$/;

async function listHdcTargets(hdc: string): Promise<string[]> {
  const res = await run(hdc, ['list', 'targets'], { timeoutMs: 20_000 });
  return res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^(\d{1,3}\.){3}\d{1,3}:\d+$/.test(l));
}

/** 实例进程的 127.0.0.1 监听端口 → hdc target（多实例并存时不能取"唯一设备"） */
async function findHosHdcTarget(hdc: string, pid: number): Promise<string | undefined> {
  const net = await run('netstat.exe', ['-ano'], { timeoutMs: 20_000 }).catch(() => undefined);
  if (!net) return undefined;
  const ports = new Set<number>();
  for (const line of net.stdout.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (m && Number(m[2]) === pid) ports.add(Number(m[1]));
  }
  if (ports.size === 0) return undefined;
  const targets = await listHdcTargets(hdc);
  return targets.find((t) => ports.has(Number(t.slice(t.lastIndexOf(':') + 1))));
}

async function listFaultlog(hdc: string, target: string): Promise<string[]> {
  const res = await run(
    hdc,
    ['-t', target, 'shell', 'ls', '/data/log/faultlog/faultlogger'],
    { timeoutMs: 20_000 },
  );
  return res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => FAULTLOG_RE.test(l))
    .sort((a, b) => {
      const ta = FAULTLOG_RE.exec(a)?.[2] ?? '';
      const tb = FAULTLOG_RE.exec(b)?.[2] ?? '';
      return ta.localeCompare(tb);
    });
}

async function recvFaultlog(hdc: string, target: string, file: string): Promise<string | undefined> {
  const dir = path.join(os.tmpdir(), 'devemu-hoscrash');
  const local = path.join(dir, file);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const res = await run(
      hdc,
      ['-t', target, 'file', 'recv', `/data/log/faultlog/faultlogger/${file}`, local],
      { timeoutMs: 60_000 },
    );
    if (res.code !== 0) return undefined;
    return await fs.promises.readFile(local, 'utf8');
  } catch {
    return undefined;
  } finally {
    await fs.promises.rm(local, { force: true }).catch(() => undefined);
  }
}

export interface HosCrashWatchOptions {
  hdc: string;
  /** HarmonyOS 实例名，也是记录里的设备名称 */
  name: string;
  crashesDir: string;
  labelOf?: (source: string) => string | undefined;
  onRecord: (record: CrashRecord) => void;
}

/**
 * 轮询 faultlogger：新文件按文件名去重入库，历史文件在首次启动时也会补齐。
 * 崩溃时间取日志自带 Timestamp，历史记录不会全部变成"现在"。
 */
export function startHosCrashWatch(opts: HosCrashWatchOptions): () => void {
  let stopped = false;
  let busy = false;
  let target: string | undefined;
  const seen = new Set<string>();

  const poll = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      if (!target) {
        const pid = await findHosEmulatorPid(opts.name);
        if (!pid) return;
        target = await findHosHdcTarget(opts.hdc, pid);
      }
      if (!target) return;
      const files = await listFaultlog(opts.hdc, target);
      for (const file of files.slice(-100)) {
        if (stopped) return;
        if (seen.has(file)) continue;
        if (hasCrashKey(opts.crashesDir, file)) {
          seen.add(file);
          continue;
        }
        const text = await recvFaultlog(opts.hdc, target, file);
        if (text === undefined) continue;
        const parsed = parseHosFaultlog(text, file);
        const record = recordCrash(
          opts.crashesDir,
          {
            os: 'hos',
            at: parsed.at.toISOString(),
            device: opts.name,
            source: parsed.source,
            sourceLabel: parsed.source === 'SYSTEM' ? undefined : opts.labelOf?.(parsed.source),
            kind: parsed.kind,
            summary: parsed.summary,
            key: file,
          },
          text,
        );
        seen.add(file);
        opts.onRecord(record);
      }
    } catch {
      // hdc 未就绪/设备已关：下轮重新解析目标
      target = undefined;
    } finally {
      busy = false;
    }
  };

  void poll();
  const timer = setInterval(() => void poll(), 20_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
