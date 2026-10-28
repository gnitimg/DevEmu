import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecorOverlays, parseDevices, parseWmSize, portalProbeApplied, stripToPng, translateInstallError } from './adb.ts';

const DEVICES_OUTPUT = `List of devices attached
emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1
emulator-5556          offline transport_id:2
9A231FFAZ000EQ         unauthorized transport_id:3

`;

test('parseDevices 解析状态', () => {
  const devices = parseDevices(DEVICES_OUTPUT);
  assert.equal(devices.length, 3);
  assert.deepEqual(devices[0], { serial: 'emulator-5554', state: 'device' });
  assert.equal(devices[1]!.state, 'offline');
  assert.equal(devices[2]!.state, 'unauthorized');
});

test('parseDevices 空输出', () => {
  assert.deepEqual(parseDevices('List of devices attached\n\n'), []);
  assert.deepEqual(parseDevices('adb server is out of date'), []);
});

test('parseDecorOverlays 解析已启用的机型外观 overlay', () => {
  const out = [
    '[x] com.google.android.overlay.pixelconfigcommon',
    '[ ] com.android.internal.emulation.pixel_8_pro',
    '[x] com.android.internal.emulation.pixel_9_pro',
    '[x] com.android.systemui.emulation.pixel_9_pro',
    '[x] com.android.internal.display.cutout.emulation.corner',
    '[] com.android.internal.emulation.pixel_3',
  ].join('\r\n');
  assert.deepEqual(parseDecorOverlays(out), [
    'com.android.internal.emulation.pixel_9_pro',
    'com.android.systemui.emulation.pixel_9_pro',
  ]);
  assert.deepEqual(parseDecorOverlays(''), []);
});

test('parseWmSize 解析物理分辨率', () => {
  assert.deepEqual(parseWmSize('Physical size: 1008x2244\r\nOverride size: 504x1122'), { w: 1008, h: 2244 });
  assert.deepEqual(parseWmSize('Physical size: 1080x2400'), { w: 1080, h: 2400 });
  assert.equal(parseWmSize(''), undefined);
  assert.equal(parseWmSize('error: no devices found'), undefined);
});

test('translateInstallError 常见错误转中文', () => {
  assert.match(translateInstallError('INSTALL_FAILED_UPDATE_INCOMPATIBLE'), /签名/);
  assert.match(translateInstallError('INSTALL_FAILED_OLDER_SDK'), /系统版本/);
  assert.match(translateInstallError('INSTALL_FAILED_NO_MATCHING_ABIS'), /架构/);
  assert.match(translateInstallError('adb: failed to install x.apk: device offline'), /未就绪/);
  assert.match(translateInstallError('something unexpected'), /安装失败/);
});

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('stripToPng 剥离 screencap 混入 stdout 的警告前缀', () => {
  const png = Buffer.concat([PNG_SIG, Buffer.from('fake-image-body')]);
  const polluted = Buffer.concat([
    Buffer.from('[Warning] Multiple displays were found, but no display id was specified!\r\n', 'utf8'),
    png,
  ]);
  assert.ok(stripToPng(polluted).equals(png));
  assert.ok(stripToPng(png).equals(png));
});

test('stripToPng 无 PNG 数据时抛错', () => {
  assert.throws(() => stripToPng(Buffer.from('stdout without image data')), /PNG/);
});

test('portalProbeApplied 判断探测源是否已生效', () => {
  assert.ok(portalProbeApplied('https://connect.rom.miui.com/generate_204'));
  assert.ok(!portalProbeApplied('null'));
  assert.ok(!portalProbeApplied(''));
  assert.ok(!portalProbeApplied(undefined));
  assert.ok(!portalProbeApplied('https://www.google.com/generate_204'));
});
