import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  groupHosImages,
  groupHosModels,
  hosDeviceFamily,
  hosDeviceLabel,
  hosDeviceOrder,
  hosFamilyOrder,
  hosImageKey,
  hosModelBrand,
  hosScreenTypeLabel,
  hosSeries,
} from './hosLabels.ts';
import type { HosImage } from './types.ts';

test('hosSeries 取大版本号', () => {
  assert.equal(hosSeries('HarmonyOS 6.0.0(20)'), 'HarmonyOS 6');
  assert.equal(hosSeries('HarmonyOS 7.0.0(26.0.0)'), 'HarmonyOS 7');
  assert.equal(hosSeries('HarmonyOS 5.0.5(17)'), 'HarmonyOS 5');
  assert.equal(hosSeries('custom'), 'custom');
});

test('hosImageKey 区分设备类型与版本', () => {
  assert.equal(hosImageKey('phone', 'HarmonyOS 6.0.0(20)'), 'hos-image:phone|HarmonyOS 6.0.0(20)');
  assert.notEqual(
    hosImageKey('phone', 'HarmonyOS 6.0.0(20)'),
    hosImageKey('tablet', 'HarmonyOS 6.0.0(20)'),
  );
});

test('hosDeviceLabel 覆盖全部产品线并保留未知类型', () => {
  assert.equal(hosDeviceLabel('phone'), '手机');
  assert.equal(hosDeviceLabel('tablet'), '平板');
  assert.equal(hosDeviceLabel('wearable'), '手表');
  assert.equal(hosDeviceLabel('2in1'), '2in1');
  assert.equal(hosDeviceLabel('unknown'), 'unknown');
});

test('hosDeviceOrder 让手机系靠前、未知类型垫底', () => {
  assert.ok(hosDeviceOrder('phone') < hosDeviceOrder('tablet'));
  assert.ok(hosDeviceOrder('tablet') < hosDeviceOrder('wearable'));
  assert.ok(hosDeviceOrder('wearable') < hosDeviceOrder('unknown'));
});

test('hosDeviceFamily 把折叠形态归入手机、2in1 折叠归入 2in1', () => {
  assert.equal(hosDeviceFamily('phone').id, 'phone');
  assert.equal(hosDeviceFamily('foldable').id, 'phone');
  assert.equal(hosDeviceFamily('triplefold').id, 'phone');
  assert.equal(hosDeviceFamily('widefold').id, 'phone');
  assert.equal(hosDeviceFamily('2in1 Foldable').id, '2in1');
  assert.equal(hosDeviceFamily('wearablekid').label, '儿童手表');
  assert.equal(hosDeviceFamily('unknown').id, 'unknown');
  assert.ok(hosFamilyOrder('phone') < hosFamilyOrder('tablet'));
});

function img(deviceType: string, osVersion: string, downloaded = false): HosImage {
  return { deviceType, osVersion, softwareVersion: '6.0.0.48', downloaded };
}

test('groupHosImages 合并共用镜像的设备形态', () => {
  const groups = groupHosImages([
    img('foldable', 'HarmonyOS 6.0.0(20)'),
    img('phone', 'HarmonyOS 6.0.0(20)', true),
    img('triplefold', 'HarmonyOS 6.0.0(20)'),
    img('widefold', 'HarmonyOS 6.0.0(20)'),
    img('2in1 Foldable', 'HarmonyOS 6.0.0(20)'),
    img('2in1', 'HarmonyOS 6.0.0(20)'),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], {
    family: 'phone',
    label: '手机',
    osVersion: 'HarmonyOS 6.0.0(20)',
    softwareVersion: '6.0.0.48',
    deviceType: 'phone',
    downloaded: true,
  });
  assert.equal(groups[1]!.deviceType, '2in1');
  assert.equal(groups[1]!.downloaded, false);
});

test('groupHosImages 按家族顺序与版本倒序排列', () => {
  const groups = groupHosImages([
    img('tablet', 'HarmonyOS 6.0.0(20)'),
    img('phone', 'HarmonyOS 6.0.0(20)'),
    img('phone', 'HarmonyOS 7.0.0(26.0.0)'),
  ]);
  assert.deepEqual(
    groups.map((g) => `${g.family}|${g.osVersion}`),
    [
      'phone|HarmonyOS 7.0.0(26.0.0)',
      'phone|HarmonyOS 6.0.0(20)',
      'tablet|HarmonyOS 6.0.0(20)',
    ],
  );
});

test('hosModelBrand 按产品线归组', () => {
  assert.equal(hosModelBrand('Mate 90 Pro'), 'Mate');
  assert.equal(hosModelBrand('Mate X7'), 'Mate');
  assert.equal(hosModelBrand('Pura 90 Pro Max'), 'Pura');
  assert.equal(hosModelBrand('Pura X Max'), 'Pura');
  assert.equal(hosModelBrand('nova 16z'), 'nova');
  assert.equal(hosModelBrand('nova flip S'), 'nova');
  assert.equal(hosModelBrand('Enjoy 90 Plus'), 'Enjoy');
  assert.equal(hosModelBrand('Pocket 2'), 'Pocket');
  assert.equal(hosModelBrand('MatePad Pro 13'), 'MatePad');
  assert.equal(hosModelBrand('MatePad 11 S'), 'MatePad');
  assert.equal(hosModelBrand('MateBook Fold'), 'MateBook');
  assert.equal(hosModelBrand('P30 Pro'), 'P');
  assert.equal(hosModelBrand('Watch 4 Pro'), 'Watch');
  assert.equal(hosModelBrand('Huawei_Car'), 'Huawei');
  assert.equal(hosModelBrand('Customize'), 'Customize');
});

test('groupHosModels 保持机型顺序并按产品线归并', () => {
  assert.deepEqual(
    groupHosModels(['Mate 90 Pro', 'Mate 90', 'Pura 90 Pro', 'Pura 90', 'Mate X7', 'MatePad Pro 13']),
    [
      { name: 'Mate', models: ['Mate 90 Pro', 'Mate 90', 'Mate X7'] },
      { name: 'Pura', models: ['Pura 90 Pro', 'Pura 90'] },
      { name: 'MatePad', models: ['MatePad Pro 13'] },
    ],
  );
  assert.deepEqual(groupHosModels([]), []);
});

test('hosScreenTypeLabel 按设备形态给出屏幕类型', () => {
  assert.equal(hosScreenTypeLabel('phone', 'Mate 90 Pro'), '直板');
  assert.equal(hosScreenTypeLabel('foldable', 'Mate X7'), '折叠屏');
  assert.equal(hosScreenTypeLabel('triplefold'), '三折叠');
  assert.equal(hosScreenTypeLabel('widefold'), '宽折叠');
  assert.equal(hosScreenTypeLabel('tablet'), '平板');
  assert.equal(hosScreenTypeLabel('2in1 Foldable'), '折叠屏');
  assert.equal(hosScreenTypeLabel('unknown'), 'unknown');
});

test('hosScreenTypeLabel 识别手机清单里的小折叠', () => {
  assert.equal(hosScreenTypeLabel('phone', 'nova flip'), '折叠屏');
  assert.equal(hosScreenTypeLabel('phone', 'nova flip S'), '折叠屏');
  assert.equal(hosScreenTypeLabel('phone', 'Pocket 2'), '折叠屏');
  assert.equal(hosScreenTypeLabel('phone', 'Pura X View'), '直板');
});
