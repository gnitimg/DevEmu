import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http2 from 'node:http2';
import { encodeGps, findGrpcEndpoint, connectGps } from './emuGps.ts';

test('GPS protobuf 保留完整经纬度、m/s 速度与行进方向', () => {
  const bytes = encodeGps({
    lat: 39.9,
    lon: 116.4,
    speedMps: 1.4,
    headingDeg: 90,
    altitudeM: 24,
    passiveUpdate: false,
  });
  assert.deepEqual([...bytes.subarray(0, 2)], [8, 0]);
  assert.equal(bytes[2], 17);
  assert.equal(bytes.readDoubleLE(3), 39.9);
  assert.equal(bytes.readDoubleLE(12), 116.4);
  assert.equal(bytes.readDoubleLE(21), 1.4 / 0.514444);
  assert.equal(bytes.readDoubleLE(30), 90);
  assert.equal(bytes.readDoubleLE(39), 24);
});

test('仅连接相同模拟器序号的环回控制端点，验证鉴权和 gRPC 确认', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-grpc-test-'));
  const server = http2.createServer();
  let received: Buffer | undefined;
  server.on('stream', (stream, headers) => {
    assert.equal(headers.authorization, 'Bearer test-token');
    assert.equal(
      headers[':path'],
      '/android.emulation.control.EmulatorController/setGps',
    );
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => {
      received = Buffer.concat(chunks);
      (stream as http2.ServerHttp2Stream).respond({
        ':status': 200,
        'content-type': 'application/grpc',
        'grpc-status': '0',
      });
      stream.end(Buffer.alloc(5));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  fs.writeFileSync(
    path.join(temp, 'pid_123_info.ini'),
    `port.serial=5554\ngrpc.port=${port}\ngrpc.token=test-token\n`,
  );
  const gps = await connectGps('emulator-5554', temp);
  try {
    assert.ok(gps);
    assert.equal(findGrpcEndpoint('emulator-5556', temp), null);
    await gps.set({
      lat: 1,
      lon: 2,
      speedMps: 3,
      headingDeg: 90,
      altitudeM: 4,
      passiveUpdate: false,
    });
    assert.ok(received);
    assert.equal(received.readUInt32BE(1), received.length - 5);
    assert.equal(received.readDoubleLE(35), 90);
  } finally {
    gps?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
