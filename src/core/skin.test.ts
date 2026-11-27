import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findSkinDir,
  frameAngle,
  parseSkin,
  pickRecordingLayout,
  pickStillLayout,
  readSkin,
  restoreAngle,
} from './skin.ts';

const PIXEL_6 = `parts {
  device {
    display {
      width 1080
      height 2400
      x 0
      y 0
    }
  }
  portrait {
    background {
      image back.webp
    }
    foreground {
      mask mask.webp
      cutout hole
    }
  }
}
layouts {
  portrait {
    width 1209
    height 2553
    event EV_SW:0:1
    part1 {
      name portrait
      x 0
      y 0
    }
    part2 {
      name device
      x 60
      y 69
    }
  }
}`;

const PIXEL_2 = `parts {
  device {
    display { width 1080 height 1920 x 0 y 0 }
  }
  portrait {
    background { image port_back.webp }
    onion { image port_fore.webp }
  }
  landscape {
    background { image land_back.webp }
    onion { image land_fore.webp }
  }
}
layouts {
  portrait {
    width 1370
    height 2534
    part1 { name portrait x 0 y 0 }
    part2 { name device x 140 y 280 }
  }
  landscape {
    width 2596
    height 1258
    part1 { name landscape x 0 y 0 }
    part2 { name device x 338 y 68 rotation 3 }
  }
}`;

test('新式皮肤：屏幕矩形取 device 部件位置，背景与前景遮罩各自归位', () => {
  const skin = parseSkin(PIXEL_6);
  assert.deepEqual(skin.display, { width: 1080, height: 2400 });
  assert.equal(skin.layouts.length, 1);
  const [layout] = skin.layouts;
  assert.equal(layout!.name, 'portrait');
  assert.equal(layout!.width, 1209);
  assert.equal(layout!.height, 2553);
  assert.deepEqual(layout!.screen, { x: 60, y: 69, w: 1080, h: 2400 });
  assert.equal(layout!.screenRotation, 0);
  assert.deepEqual(layout!.backgrounds, [{ file: 'back.webp', x: 0, y: 0 }]);
  assert.equal(layout!.mask, 'mask.webp');
  assert.deepEqual(layout!.onions, []);
});

test('旧式皮肤：横竖两份 layout，叠加层与背景按 layout 分别取图', () => {
  const skin = parseSkin(PIXEL_2);
  assert.equal(skin.layouts.length, 1 + 1);
  const [portrait, landscape] = skin.layouts;
  assert.deepEqual(portrait!.backgrounds, [
    { file: 'port_back.webp', x: 0, y: 0 },
  ]);
  assert.deepEqual(portrait!.onions, [{ file: 'port_fore.webp', x: 0, y: 0 }]);
  assert.equal(portrait!.mask, undefined);
  assert.deepEqual(landscape!.backgrounds, [
    { file: 'land_back.webp', x: 0, y: 0 },
  ]);
  assert.equal(landscape!.screenRotation, 3);
  // 旋转部件按换算后的 1920x1080 落位，锚点取 layout 内的那个
  assert.deepEqual(landscape!.screen, { x: 338, y: 68, w: 1920, h: 1080 });
});

test('旋转部件锚点落在 layout 外时按画面原角换算', () => {
  // nexus_4 的横屏 layout：锚点 (257, 813) 若当作左上角会超出 885 的 layout 高度，
  // 实际是画面左下角——向上占 768 落到 45
  const skin = parseSkin(`parts {
  device { display { width 768 height 1280 x 0 y 0 } }
  landscape { background { image land_back.webp } }
}
layouts {
  landscape {
    width 1799
    height 885
    part1 { name landscape x 0 y 0 }
    part2 { name device x 257 y 813 rotation 3 }
  }
}`);
  assert.deepEqual(skin.layouts[0]!.screen, { x: 257, y: 45, w: 1280, h: 768 });
  // rotation 1 的锚点在画面右上角时向左展开
  const other = parseSkin(`parts {
  device { display { width 768 height 1280 x 0 y 0 } }
  landscape { background { image land_back.webp } }
}
layouts {
  landscape {
    width 1799
    height 885
    part1 { name landscape x 0 y 0 }
    part2 { name device x 1537 y 58 rotation 1 }
  }
}`);
  assert.deepEqual(other.layouts[0]!.screen, {
    x: 257,
    y: 58,
    w: 1280,
    h: 768,
  });
});

test('注释与空白不影响解析，结构缺损时报错', () => {
  const withComments = PIXEL_6.replace(
    'width 1209',
    '# layout width\n  width 1209 // px',
  );
  assert.equal(parseSkin(withComments).layouts[0]!.width, 1209);
  assert.throws(
    () => parseSkin(PIXEL_6.replace('width 1209', 'width }')),
    /缺少取值/,
  );
  assert.throws(
    () => parseSkin(PIXEL_6.replace('layouts {', 'x {')),
    /缺少 layouts/,
  );
  // layout 里没有指向 device 的部件
  assert.throws(
    () => parseSkin(PIXEL_6.replace('name device', 'name ghost')),
    /缺少 device 部件/,
  );
  assert.throws(() => parseSkin(''), /parts.device.display/);
});

test('restoreAngle：朝向 3 的帧逆时针 90° 回到原生画面（真机实测），另两侧对称', () => {
  // 朝向 3：横屏帧逆时针转 90° 与 screencap 逐像素吻合
  assert.equal(restoreAngle(3), -90);
  assert.equal(restoreAngle(1), 90);
  assert.equal(restoreAngle(2), 180);
  assert.equal(restoreAngle(0), 0);
});

test('frameAngle：帧朝向与目标位朝向一致时不转，否则补差值', () => {
  // 截图是原生画面（0），贴进竖屏 layout（0）
  assert.equal(frameAngle(0, 0), 0);
  // 原生截图贴进旧式皮肤的横屏 layout（3）：要转成横屏姿态
  assert.equal(frameAngle(0, 3), 90);
  // 横屏帧（3）贴进只有竖屏 layout 的皮肤：先还原成竖屏，整幅再由画布转
  assert.equal(frameAngle(3, 0), -90);
  assert.equal(frameAngle(3, 3), 0);
});

test('截图取屏幕不旋转且尺寸吻合的 layout', () => {
  const pixel2 = parseSkin(PIXEL_2);
  assert.equal(pickStillLayout(pixel2, 1080, 1920)?.name, 'portrait');
  // 旧式皮肤的横屏 layout 屏幕部件带旋转：截图是 guest 原生画面，仍贴竖屏 layout
  assert.equal(pickStillLayout(pixel2, 1080, 1920)?.screenRotation, 0);
});

test('只有横屏 layout 的皮肤（平板）截图直接使用', () => {
  const tablet = parseSkin(`parts {
  device { display { width 2560 height 1600 x 0 y 0 } }
  portrait { background { image back.webp } foreground { mask mask.webp } }
}
layouts {
  landscape {
    width 2798
    height 1837
    part1 { name portrait x 0 y 0 }
    part2 { name device x 119 y 117 }
  }
}`);
  const still = pickStillLayout(tablet, 2560, 1600);
  assert.equal(still?.name, 'landscape');
  assert.deepEqual(still?.screen, { x: 119, y: 117, w: 2560, h: 1600 });
  assert.equal(pickStillLayout(tablet, 2560, 1600)?.screenRotation, 0);
});

test('录屏：有同朝向 layout 时直接用，否则以竖屏 layout 配整幅旋转', () => {
  const pixel6 = parseSkin(PIXEL_6);
  assert.deepEqual(pickRecordingLayout(pixel6, 0), {
    layout: pixel6.layouts[0],
    canvasRotation: 0,
  });

  const pixel2 = parseSkin(PIXEL_2);
  // 旧式皮肤自带横屏 layout：设备转到 3 时画面直接贴进去，整幅不再旋转
  const landscape = pickRecordingLayout(pixel2, 3);
  assert.equal(landscape?.layout.name, 'landscape');
  assert.equal(landscape?.canvasRotation, 0);
  // 设备在 1（另一侧横屏）时 layout 画的是 3 的姿态：整幅补转 180
  assert.equal(pickRecordingLayout(pixel2, 1)?.canvasRotation, -180);
});

test('录屏整幅旋转角：竖屏皮肤在横屏设备上，整幅顺时针转 90° 让画面与窗口一致', () => {
  const pixel6 = parseSkin(PIXEL_6);
  // 设备转到 3：帧需逆时针 90° 还原，整幅画面再顺时针 90° 抵消——帧原样落进横画布
  assert.equal(pickRecordingLayout(pixel6, 3)?.canvasRotation, 90);
  assert.equal(pickRecordingLayout(pixel6, 1)?.canvasRotation, -90);
  assert.equal(pickRecordingLayout(pixel6, 2)?.canvasRotation, -180);
});

test('readSkin 读真实皮肤目录，缺 layout 文件返回 undefined', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-skin-'));
  assert.equal(readSkin(dir), undefined);
  fs.writeFileSync(path.join(dir, 'layout'), PIXEL_6);
  assert.equal(readSkin(dir)?.layouts[0]!.screen.w, 1080);
  fs.writeFileSync(path.join(dir, 'layout'), 'not a layout {');
  assert.equal(readSkin(dir), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findSkinDir 依次试 skin.path 与按机型名在 SDK skins 下查找', () => {
  const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'devemu-sdk-'));
  const make = (name: string) => {
    const dir = path.join(sdk, 'skins', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'layout'), PIXEL_6);
    return dir;
  };
  const pixel = make('pixel_6');
  const old = path.join(sdk, 'old-skin');
  assert.equal(
    findSkinDir(sdk, { 'skin.path': old, 'skin.name': 'pixel_6' }),
    pixel,
  );
  assert.equal(findSkinDir(sdk, { 'hw.device.name': 'pixel_6' }), pixel);
  assert.equal(findSkinDir(sdk, { 'hw.device.name': '..' }), undefined);
  assert.equal(
    findSkinDir(sdk, { 'skin.path': old, 'skin.name': 'nope' }),
    undefined,
  );
  // 有目录但没有 layout 文件不算皮肤
  fs.mkdirSync(path.join(sdk, 'skins', 'bare'));
  assert.equal(findSkinDir(sdk, { 'skin.name': 'bare' }), undefined);
  fs.rmSync(sdk, { recursive: true, force: true });
});
