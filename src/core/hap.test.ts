import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { importHap, parseHapManifest } from './hap.ts';
import { readZipFile, zipEntryNames } from './zip.ts';

/** 构造最小 zip（stored 或 deflate） */
function buildZip(entries: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const comp = e.deflate ? zlib.deflateRawSync(e.data) : e.data;
    const crc = 0; // 读取器不校验 CRC
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0);
    l.writeUInt16LE(20, 4); // version
    l.writeUInt16LE(0, 6); // flags
    l.writeUInt16LE(e.deflate ? 8 : 0, 8);
    l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(comp.length, 18);
    l.writeUInt32LE(e.data.length, 22);
    l.writeUInt16LE(nameBuf.length, 26);
    l.writeUInt16LE(0, 28);
    local.push(l, nameBuf, comp);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(e.deflate ? 8 : 0, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt16LE(0, 30);
    c.writeUInt16LE(0, 32);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, eocd]);
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-hap-'));
}

test('zip 读取 stored 与 deflate 条目', () => {
  const buf = buildZip([
    { name: 'module.json', data: Buffer.from('{"a":1}') },
    { name: 'pack.info', data: Buffer.from('hello zip'), deflate: true },
  ]);
  assert.deepEqual(zipEntryNames(buf), ['module.json', 'pack.info']);
  assert.equal(readZipFile(buf, 'module.json')!.toString(), '{"a":1}');
  assert.equal(readZipFile(buf, 'pack.info')!.toString(), 'hello zip');
  assert.equal(readZipFile(buf, 'nope.bin'), null);
});

test('zip 非法输入报错', () => {
  assert.throws(() => zipEntryNames(Buffer.from('not a zip')), /zip/);
});

test('parseHapManifest 解析 stage 模型 module.json', () => {
  const manifest = {
    app: { bundleName: 'com.example.hello', versionCode: 10000, versionName: '1.0.0', label: '$string:app_name' },
    module: {
      name: 'entry',
      abilities: [
        { name: 'OtherAbility', skills: [{ actions: [] }] },
        { name: 'EntryAbility', skills: [{ actions: ['action.system.home'] }] },
      ],
    },
  };
  const buf = buildZip([{ name: 'module.json', data: Buffer.from(JSON.stringify(manifest)), deflate: true }]);
  const info = parseHapManifest(buf);
  assert.equal(info.bundleName, 'com.example.hello');
  assert.equal(info.versionName, '1.0.0');
  assert.equal(info.module, 'entry');
  assert.equal(info.ability, 'EntryAbility');
});

test('parseHapManifest 解析 FA 模型 config.json', () => {
  const manifest = {
    app: {
      bundleName: 'com.example.fa',
      version: { name: '2.1.0', code: 21 },
    },
  };
  const buf = buildZip([{ name: 'config.json', data: Buffer.from(JSON.stringify(manifest)) }]);
  const info = parseHapManifest(buf);
  assert.equal(info.bundleName, 'com.example.fa');
  assert.equal(info.versionName, '2.1.0');
});

test('importHap 落盘并写元数据', async () => {
  const dir = tmpDir();
  const manifest = { app: { bundleName: 'com.demo.x', versionName: '0.0.1' }, module: { name: 'entry' } };
  const src = path.join(dir, 'myapp.hap');
  fs.writeFileSync(src, buildZip([{ name: 'module.json', data: Buffer.from(JSON.stringify(manifest)) }]));

  const meta = await importHap(path.join(dir, 'apps'), src);
  assert.equal(meta.kind, 'hap');
  assert.equal(meta.packageName, 'com.demo.x');
  assert.equal(meta.versionName, '0.0.1');
  assert.equal(meta.label, 'myapp');
  assert.ok(fs.existsSync(path.join(dir, 'apps', `${meta.id}.hap`)));
  assert.ok(fs.existsSync(path.join(dir, 'apps', `${meta.id}.meta.json`)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('importHap 拒绝非 hap 后缀', async () => {
  const dir = tmpDir();
  const src = path.join(dir, 'a.apk');
  fs.writeFileSync(src, Buffer.from('x'));
  await assert.rejects(() => importHap(path.join(dir, 'apps'), src), /\.hap/);
  fs.rmSync(dir, { recursive: true, force: true });
});
