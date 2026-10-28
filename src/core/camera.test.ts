import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraArgs, parseWebcamList, screenFeedPath } from './camera.ts';

test('cameraArgs emulated/缺省不加参数', () => {
  assert.deepEqual(cameraArgs(undefined, 'C:\\x\\screen.jpg'), []);
  assert.deepEqual(cameraArgs('emulated', 'C:\\x\\screen.jpg'), []);
});

test('cameraArgs webcam 直通指定摄像头', () => {
  assert.deepEqual(cameraArgs('webcam', 'C:\\x\\screen.jpg'), [
    '-camera-front',
    'webcam0',
    '-camera-back',
    'webcam0',
  ]);
  assert.deepEqual(cameraArgs('webcam', 'C:\\x\\screen.jpg', 'webcam1'), [
    '-camera-front',
    'webcam1',
    '-camera-back',
    'webcam1',
  ]);
});

test('cameraArgs screen 指向画面文件', () => {
  const args = cameraArgs('screen', 'C:\\data\\camera\\screen.jpg');
  assert.deepEqual(args, [
    '-camera-front',
    'imagefile:C:\\data\\camera\\screen.jpg',
    '-camera-back',
    'imagefile:C:\\data\\camera\\screen.jpg',
  ]);
});

test('parseWebcamList 解析摄像头标签与 id', () => {
  const stdout = [
    'List of web cameras connected to the computer:',
    " Camera 'Integrated Camera' can be specified by label as 'webcam0' or by id as '\\\\?\\usb#vid_5986' and will use pixel format 'NV12'",
    " Camera 'OBS Virtual Camera' can be specified by label as 'webcam1' or by id as '\\\\?\\sw#device' and will use pixel format 'YUY2'",
  ].join('\r\n');
  assert.deepEqual(parseWebcamList(stdout), [
    { id: 'webcam0', label: 'Integrated Camera' },
    { id: 'webcam1', label: 'OBS Virtual Camera' },
  ]);
});

test('parseWebcamList 空输出', () => {
  assert.deepEqual(
    parseWebcamList('List of web cameras connected to the computer:\r\n'),
    [],
  );
});

test('screenFeedPath 位于数据根 camera 目录', () => {
  assert.equal(screenFeedPath('C:\\DevEmu'), 'C:\\DevEmu\\camera\\screen.jpg');
});
