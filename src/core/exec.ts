import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  onLine?: (line: string, source: 'stdout' | 'stderr') => void;
  timeoutMs?: number;
  /** 以 latin1 收集 stdout，二进制内容（如截图）不被 UTF-8 解码破坏 */
  binary?: boolean;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const base = {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
      stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] as Array<'pipe' | 'ignore'>,
    };

    // Windows 下 .bat/.cmd 需经 cmd /c 启动；整条命令拼成单个字符串并以 verbatim 传递，
    // 避免 Node 自动加引号与 cmd 的引号剥离规则互相干扰
    let child: ChildProcess;
    if (/\.(bat|cmd)$/i.test(cmd)) {
      const cmdline = `"${cmd}" ${args.map(String).join(' ')}`.trim();
      child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', cmdline], {
        ...base,
        windowsVerbatimArguments: true,
      });
    } else {
      child = spawn(cmd, args.map(String), base);
    }

    let stdout = '';
    let stderr = '';
    let outBuf = '';
    let errBuf = '';

    const pump = (chunk: Buffer, source: 'stdout' | 'stderr') => {
      const text = chunk.toString(opts.binary && source === 'stdout' ? 'latin1' : 'utf8');
      if (source === 'stdout') stdout += text;
      else stderr += text;
      if (!opts.onLine) return;
      let buf = source === 'stdout' ? (outBuf += text) : (errBuf += text);
      const lines = buf.split(/\r?\n/);
      const keep = lines.pop() ?? '';
      if (source === 'stdout') outBuf = keep;
      else errBuf = keep;
      for (const line of lines) opts.onLine(line, source);
    };

    child.stdout?.on('data', (c: Buffer) => pump(c, 'stdout'));
    child.stderr?.on('data', (c: Buffer) => pump(c, 'stderr'));

    if (opts.stdin && child.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill();
        }, opts.timeoutMs)
      : null;

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (opts.onLine) {
        if (outBuf) opts.onLine(outBuf, 'stdout');
        if (errBuf) opts.onLine(errBuf, 'stderr');
      }
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** 持续读取输出的进程（logcat 等），返回停止函数 */
export function stream(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string>; input?: boolean; onLine: (line: string) => void; onExit?: (code: number | null) => void },
): ChildProcess {
  const child = spawn(cmd, args.map(String), {
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    windowsHide: true,
    stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  const pump = (text: string) => {
    buf += text;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) opts.onLine(line);
  };
  child.stdout?.on('data', (c: Buffer) => pump(c.toString('utf8')));
  child.stderr?.on('data', (c: Buffer) => pump(c.toString('utf8')));
  child.on('close', (code) => {
    if (buf) opts.onLine(buf);
    opts.onExit?.(code);
  });
  return child;
}
