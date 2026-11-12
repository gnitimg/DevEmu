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
  /** stdout/stderr 合计上限（字节），超限 kill 并截断 */
  maxOutputBytes?: number;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const base = {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
      stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] as Array<'pipe' | 'ignore'>,
    };

    // .bat/.cmd 须经 cmd /c 且命令行被 cmd 二次解析：空格裂参、& | ^ 引号规则、
    // 引号内 %VAR% 展开都无法安全防护（sdkmanager/avdmanager 已改直调 java，
    // 见 cmdlineTool）。这里只拒收，防止未来调用方误入注入路径
    if (/\.(bat|cmd)$/i.test(cmd)) {
      reject(new Error('不支持直接执行 .bat/.cmd：请直调其解释器（参照 cmdlineTool 直调 java）'));
      return;
    }
    const child = spawn(cmd, args.map(String), base);

    let stdout = '';
    let stderr = '';
    let outBuf = '';
    let errBuf = '';
    // agent 桥透传的命令（cat /dev/urandom、logcat -d）可把主进程内存推到 GB 级：
    // 超限即 kill 并截断，与 zip 解压的 maxOutputLength 同口径
    const outputCap = opts.maxOutputBytes ?? 32 * 1024 * 1024;
    let outputBytes = 0;
    let truncated = false;

    const pump = (chunk: Buffer, source: 'stdout' | 'stderr') => {
      outputBytes += chunk.length;
      if (outputBytes > outputCap) {
        truncated = true;
        child.kill();
        return;
      }
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
      resolve({ code: code ?? -1, stdout, stderr: truncated ? `${stderr}\n[输出超过上限，已截断中止]` : stderr });
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
  let ended = false;
  child.on('close', (code) => {
    if (ended) return;
    ended = true;
    if (buf) opts.onLine(buf);
    opts.onExit?.(code);
  });
  // spawn 失败（进程不存在/被策略拦截）只发 error 不发 close：不监听会以
  // 未捕获异常崩掉主进程；与 close 互斥防 onExit 双发
  child.on('error', () => {
    if (ended) return;
    ended = true;
    opts.onExit?.(-1);
  });
  return child;
}
