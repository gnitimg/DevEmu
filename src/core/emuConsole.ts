import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Android 模拟器控制台客户端：直连 127.0.0.1:<console 端口> 的持久 TCP 连接。
 * geo fix / sensor 等物理级注入需要高频下发（传感器波形 ~20Hz），
 * 经 adb emu 每条命令拉起一个进程的开销不可接受，故常驻一条连接按序发送。
 * 认证 token 与模拟器 GUI 共用 ~/.emulator_console_auth_token。
 */

export function consolePortOf(serial: string): number | null {
  const m = serial.match(/^emulator-(\d{1,5})$/);
  if (!m) return null;
  const port = parseInt(m[1]!, 10);
  return Number.isFinite(port) && port > 0 ? port : null;
}

export function consoleTokenFile(): string {
  return path.join(os.homedir(), '.emulator_console_auth_token');
}

/** 读取控制台认证 token；文件缺失/为空返回 null（旧版模拟器可能不设认证） */
export function readConsoleToken(): string | null {
  try {
    const t = fs.readFileSync(consoleTokenFile(), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

export interface EmuConsole {
  /** 执行一条命令；KO: 开头的应答转为异常，其余返回 OK 之前的所有输出行 */
  send(command: string): Promise<string>;
  close(): void;
}

interface Pending {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  lines: string[];
  timer: NodeJS.Timeout;
}

export async function connectConsole(
  serial: string,
  timeoutMs = 8000,
): Promise<EmuConsole> {
  const port = consolePortOf(serial);
  if (!port)
    throw new Error('物理级定位仅支持 Android 模拟器（emulator-* 串号）');
  const token = readConsoleToken();

  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.setNoDelay(true);
  let buf = '';
  let pending: Pending | null = null;
  // 阶段：等 banner 末尾的 OK → 发 auth 等 OK → 正常命令收发
  let stage: 'banner' | 'auth' | 'ready' = 'banner';

  const failPending = (err: Error): void => {
    const p = pending;
    pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  };

  const rejectAll = (err: Error): void => {
    failPending(err);
    socket.destroy();
  };

  const onData = (chunk: Buffer): void => {
    buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line) continue;
      if (stage === 'banner') {
        if (/^OK$/i.test(line)) {
          stage = 'auth';
          socket.write(`auth ${token ?? ''}\n`);
        }
        continue;
      }
      if (stage === 'auth') {
        // 旧版控制台不认 auth：KO 不含 invalid token 时视为免认证直通
        if (/^OK$/i.test(line)) {
          stage = 'ready';
        } else if (
          /^KO:/i.test(line) &&
          !/invalid token|authentication/i.test(line)
        ) {
          stage = 'ready';
        } else if (/^KO:/i.test(line)) {
          rejectAll(new Error('控制台认证失败：token 不正确'));
          return;
        }
        continue;
      }
      if (!pending) continue;
      if (/^KO:/i.test(line)) {
        failPending(new Error(line.slice(3).trim() || '控制台命令被拒绝'));
      } else if (/^OK$/i.test(line)) {
        const p = pending;
        pending = null;
        clearTimeout(p.timer);
        p.resolve(p.lines.join('\n'));
      } else {
        pending.lines.push(line);
      }
    }
  };

  await new Promise<void>((resolve, reject) => {
    const onFail = (err: Error): void => {
      socket.removeListener('connect', onConnect);
      socket.destroy();
      reject(err);
    };
    const onConnect = (): void => {
      socket.removeListener('error', onFail);
      resolve();
    };
    socket.once('error', onFail);
    socket.once('connect', onConnect);
    socket.setTimeout(timeoutMs, () =>
      onFail(new Error('连接模拟器控制台超时')),
    );
  });
  socket.setTimeout(0);
  socket.on('data', onData);
  socket.on('error', (err) =>
    rejectAll(new Error(`控制台连接异常：${err.message}`)),
  );
  socket.on('close', () => rejectAll(new Error('控制台连接已断开')));

  // 等 banner+auth 完成：认证命令由 onData 在收到 banner OK 后自动发送
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const check = (): void => {
      if (stage === 'ready') resolve();
      else if (socket.destroyed)
        reject(new Error('模拟器控制台握手失败：连接已断开'));
      else if (Date.now() - started > timeoutMs)
        reject(new Error('模拟器控制台握手超时'));
      else setTimeout(check, 25);
    };
    check();
  }).catch((err: unknown) => { socket.destroy(); throw err; });

  // 多个定时器（geo 1Hz / 传感器 20Hz）并发调用 send：用 promise 链串行化，
  // 保证同一时刻控制台上只有一条未应答命令
  let chain: Promise<unknown> = Promise.resolve();

  return {
    send(command: string): Promise<string> {
      if (socket.destroyed)
        return Promise.reject(new Error('控制台连接已断开'));
      const exec = (): Promise<string> =>
        new Promise<string>((resolve, reject) => {
          if (socket.destroyed) { reject(new Error('控制台连接已断开')); return; }
          const p: Pending = {
            resolve,
            reject,
            lines: [],
            timer: setTimeout(
              () => rejectAll(new Error(`控制台命令超时：${command}`)),
              timeoutMs,
            ),
          };
          pending = p;
          socket.write(`${command}\n`);
        });
      const result = chain.then(exec, exec);
      chain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    close(): void {
      rejectAll(new Error('控制台连接已关闭'));
    },
  };
}
