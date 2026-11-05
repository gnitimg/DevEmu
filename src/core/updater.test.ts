import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions,
  parseChecksums,
  parseVersion,
  pickSetupAsset,
  pickChecksumsAsset,
  setupAssetName,
  targetFromUrl,
  type ReleaseAsset,
} from './updater.ts';

test('版本号解析与比较', () => {
  assert.deepEqual(parseVersion('v0.2.10'), [0, 2, 10]);
  assert.deepEqual(parseVersion('1.0.0'), [1, 0, 0]);
  assert.equal(parseVersion('abc'), null);

  // 字符串判等的老问题：0.2.10 大于 0.2.9
  assert.equal(compareVersions('v0.2.10', '0.2.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.9.0', '1.0.0'), -1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  // 预发布版本低于同号正式版
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
});

test('按固定资产名匹配安装包与校验文件', () => {
  const assets: ReleaseAsset[] = [
    {
      name: 'DevEmu-Setup-1.0.0.exe',
      url: 'https://objects.example/1',
      size: 1,
    },
    { name: 'checksums.txt', url: 'https://objects.example/2', size: 1 },
    { name: 'source.zip', url: 'https://objects.example/3', size: 1 },
  ];
  assert.equal(pickSetupAsset(assets, '1.0.0')?.name, 'DevEmu-Setup-1.0.0.exe');
  assert.equal(pickChecksumsAsset(assets)?.name, 'checksums.txt');
  assert.equal(
    pickSetupAsset(
      assets.filter((a) => !a.name.includes('Setup')),
      '1.0.0',
    ),
    null,
  );
  // 命名漂移时回退到任意 Setup 包
  assert.equal(
    pickSetupAsset(
      [{ name: 'DevEmuSetup.exe', url: 'https://objects.example/4', size: 1 }],
      '1.0.0',
    )?.name,
    'DevEmuSetup.exe',
  );
  assert.equal(setupAssetName('1.0.0'), 'DevEmu-Setup-1.0.0.exe');
});

test('sha256sum 文本解析', () => {
  const map = parseChecksums(
    `${'a1'.repeat(32)}  DevEmu-Setup-1.0.0.exe\n${'b2'.repeat(32)} *checksums.txt\r\nshort line\n`,
  );
  assert.equal(map.get('devemu-setup-1.0.0.exe'), 'a1'.repeat(32));
  assert.equal(map.get('checksums.txt'), 'b2'.repeat(32));
  assert.equal(map.size, 2);
});

test('下载地址转目标', () => {
  assert.deepEqual(targetFromUrl('https://objects.example/a/b.exe?sig=x'), {
    host: 'objects.example',
    path: '/a/b.exe?sig=x',
  });
  assert.equal(targetFromUrl('http://insecure.example/a'), null);
  assert.equal(targetFromUrl('not-a-url'), null);
});
