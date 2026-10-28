import http2 from 'node:http2';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GpsFix {
  lat: number;
  lon: number;
  speedMps: number;
  headingDeg: number;
  altitudeM: number;
  passiveUpdate: boolean;
}

export interface GpsController {
  set(fix: GpsFix): Promise<void>;
  close(): void;
}

export function encodeGps(fix: GpsFix): Buffer {
  // Emulator 37 的 setGps 直接将 speed 传给以节为单位的 gpsSendLoc。
  const fields = [
    [2, fix.lat],
    [3, fix.lon],
    [4, fix.speedMps / 0.514444],
    [5, fix.headingDeg],
    [6, fix.altitudeM],
  ];
  const parts = [Buffer.from([8, Number(fix.passiveUpdate)])];
  for (const [field, value] of fields) {
    const bytes = Buffer.alloc(9);
    bytes[0] = field! * 8 + 1;
    bytes.writeDoubleLE(value!, 1);
    parts.push(bytes);
  }
  parts.push(Buffer.from([56, 10]));
  return Buffer.concat(parts);
}

export function findGrpcEndpoint(
  serial: string,
  directory = path.join(
    process.env.LOCALAPPDATA ?? os.tmpdir(),
    'Temp',
    'avd',
    'running',
  ),
): { port: number; token: string } | null {
  const consolePort = Number(serial.match(/^emulator-(\d{1,5})$/)?.[1]);
  if (!consolePort || !fs.existsSync(directory)) return null;
  for (const file of fs.readdirSync(directory)) {
    if (!/^pid_\d+(?:_info)?\.ini$/.test(file)) continue;
    try {
      const entries = Object.fromEntries(
        fs
          .readFileSync(path.join(directory, file), 'utf8')
          .split(/\r?\n/)
          .flatMap((line) => {
            const m = line.match(/^([^=]+)=(.*)$/);
            return m ? [[m[1]!.trim(), m[2]!.trim()]] : [];
          }),
      );
      if (
        Number(entries['port.serial']) !== consolePort &&
        Number(entries['port.adb']) !== consolePort + 1
      )
        continue;
      const port = Number(entries['grpc.port']);
      const token = entries['grpc.token'];
      if (
        Number.isInteger(port) &&
        port > 0 &&
        port <= 65535 &&
        token &&
        !/[\r\n]/.test(token)
      )
        return { port, token };
    } catch {
      /* 发现文件在模拟器退出时可能被删除。 */
    }
  }
  return null;
}

export async function connectGps(
  serial: string,
  directory?: string,
): Promise<GpsController | null> {
  const endpoint = findGrpcEndpoint(serial, directory);
  if (!endpoint) return null;
  const client = http2.connect(`http://127.0.0.1:${endpoint.port}`);
  client.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error('GPS 控制接口连接超时'));
    }, 1500);
    client.once('connect', () => {
      clearTimeout(timeout);
      resolve();
    });
    client.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
  return {
    set(fix: GpsFix): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (client.destroyed || client.closed) {
          reject(new Error('GPS 控制接口已断开'));
          return;
        }
        const request = client.request({
          ':method': 'POST',
          ':path': '/android.emulation.control.EmulatorController/setGps',
          'content-type': 'application/grpc',
          te: 'trailers',
          authorization: `Bearer ${endpoint.token}`,
        });
        let status = '',
          message = '',
          httpStatus = 0;
        const timer = setTimeout(() => {
          request.close();
          reject(new Error('GPS 注入超时'));
        }, 1500);
        request.on('response', (headers) => {
          httpStatus = Number(headers[':status']);
          if (headers['grpc-status'] !== undefined)
            status = String(headers['grpc-status']);
          if (headers['grpc-message'])
            message = String(headers['grpc-message']);
        });
        request.on('trailers', (headers) => {
          status = String(headers['grpc-status']);
          message = String(headers['grpc-message'] ?? '');
        });
        request.on('data', () => undefined);
        request.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        request.once('end', () => {
          clearTimeout(timer);
          if (httpStatus === 200 && status === '0') resolve();
          else
            reject(
              new Error(
                `GPS 控制接口拒绝注入（${status || httpStatus}）${message}`,
              ),
            );
        });
        const payload = encodeGps(fix);
        const header = Buffer.alloc(5);
        header.writeUInt32BE(payload.length, 1);
        request.end(Buffer.concat([header, payload]));
      });
    },
    close: () => client.destroy(),
  };
}
