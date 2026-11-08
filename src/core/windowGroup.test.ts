import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './exec.ts';
import { hosPillSerial } from './hosemu.ts';
import { buildHosWindowGuardScript, buildWindowGuardScript } from './windowGroup.ts';

test('守卫保留 Qt 设备皮肤的透明轮廓，不二次裁剪屏幕', () => {
  const script = buildWindowGuardScript('test', 'emulator-5554');
  assert.doesNotMatch(script, /CreateRoundRectRgn|SetWindowRgn|EnsureRegion/);
  assert.match(script, /~0x00040000/);
  assert.match(script, /~0x00010000/);
});

test('右键拖动的钩子回调不阻塞输入：移动交给独立线程执行', () => {
  const script = buildWindowGuardScript('test', 'emulator-5554');
  const hookBody = script.match(/static IntPtr OnMouse\([^]*?\n    \}/)?.[0];
  assert.ok(hookBody, '钩子回调必须存在');
  // 全局低级鼠标钩子同步等 qemu 的 UI 线程会拖住整机输入：回调里不得做跨进程移动或输出
  assert.doesNotMatch(hookBody, /SetWindowPos|Console\.WriteLine|Layer\.Sync/);
  assert.match(script, /GetCursorPos\(out p\)/);
  // 按下事件被钩子吞掉后系统按键态不会变为按下，依赖 GetAsyncKeyState() 会让拖动立即中止
  assert.doesNotMatch(script, /GetAsyncKeyState\s*\(/);
  assert.match(script, /static void MoverLoop\(\)/);
  // 跨进程等待只允许发生在移动线程；异步投递会堆积过期位置
  assert.match(script, /const uint moveFlags=0x15/);
  assert.doesNotMatch(script, /SWP_ASYNCWINDOWPOS|0x4015/);
  assert.match(script, /MsgWaitForMultipleObjects/);
  // 拖动期间守卫主循环不再做 Z 序修复/钳制
  assert.match(script, /if \(dragging\) return;/);
});

test('HarmonyOS 守卫按 pid 定位窗口，实例名不进入脚本', () => {
  const serial = hosPillSerial('Pura 90 测试');
  const script = buildHosWindowGuardScript(4321, serial);
  // 实例名可含空格/中文/引号：守卫只接收 pid 与 base64url 标识
  assert.doesNotMatch(script, /Pura 90/);
  assert.match(script, /\$qemuId=4321/);
  assert.match(script, /\[DevEmuGroup\.Native\]::Watch\(\[uint32\]\$qemuId\)/);
  assert.match(script, /static void MoverLoop\(\)/);
  // Qt 模拟器自己定尺寸；守卫再钳制会与 Qt 互相改回，表现为窗口持续抽搐
  assert.match(script, /::Init\(\[uint32\]\$ownerId, '[^']+', \$false\)/);
  assert.throws(() => buildHosWindowGuardScript(0, serial), /非法窗口组/);
  assert.throws(() => buildHosWindowGuardScript(4321, "a'; exit 0; #"), /非法窗口组/);
});

test('Android 守卫保留 75% 尺寸钳制', () => {
  const script = buildWindowGuardScript('test', 'emulator-5554');
  assert.match(script, /::Init\(\[uint32\]\$ownerId, '[^']+', \$true\)/);
});

test(
  '原生搬窗由位置变化事件即时跟随，不靠 25ms Tick 采样',
  () => {
    const script = buildWindowGuardScript('test', 'emulator-5554');
    assert.match(script, /public static void Watch\(uint qpid\)/);
    assert.match(
      script,
      /SetWinEventHook\(0x800B, 0x800B, IntPtr\.Zero, locationCallback, qpid, 0, 0x0002\)/,
    );
    // qemu 进程确定后才能按 pid 装钩子
    assert.match(script, /\[DevEmuGroup\.Native\]::Watch\(\[uint32\]\$qemuId\)/);
    const body = script.match(/locationCallback=delegate\([^]*?\n      \};/)?.[0];
    assert.ok(body, '位置事件回调必须存在');
    // 拖动期间由移动线程同步三窗，事件回调再对齐会与之抢窗口
    assert.match(body, /!dragging/);
    assert.match(body, /Align\(\)/);
  },
);

test(
  '守卫把超出工作区 75% 的设备窗口按当前比例钳回',
  {
    skip: process.platform !== 'win32',
    timeout: 30_000,
  },
  async () => {
    const native = buildWindowGuardScript('test', 'emulator-5554').match(
      /Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/,
    )?.[1];
    assert.ok(native);
    // 纯函数测试覆盖不了接线：Tick 周期里必须真的调用钳制
    assert.match(native, /EnsureClamped\(\);/);
    const result = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${native}
'@
@(
  @{name='fit-to-monitor'; w=484; h=1080; ww=1920; wh=1020},
  @{name='within-bounds'; w=343; h=765; ww=1920; wh=1020},
  @{name='width-bound'; w=2000; h=889; ww=1920; wh=1020},
  @{name='tiny-work'; w=200; h=400; ww=100; wh=100},
  @{name='degenerate'; w=0; h=1080; ww=1920; wh=1020}
) | ForEach-Object {
  $r=[DevEmuGroup.Native]::ClampSize([int]$_.w, [int]$_.h, [int]$_.ww, [int]$_.wh)
  [pscustomobject]@{name=$_.name; w=$r[0]; h=$r[1]}
} | ConvertTo-Json -Compress
`,
      ],
      { timeoutMs: 25_000 },
    );
    assert.equal(result.code, 0, result.stderr);
    const rows = JSON.parse(result.stdout) as Array<{
      name: string;
      w: number;
      h: number;
    }>;
    assert.deepEqual(
      rows.map(({ name, w, h }) => [name, w, h]),
      [
        // 1280x2856 被 qemu 适配到整屏(1920x1080)后：钳回工作区高 75%，等比
        ['fit-to-monitor', 343, 765],
        ['within-bounds', 343, 765],
        ['width-bound', 1440, 640],
        ['tiny-work', 38, 75],
        ['degenerate', 0, 1080],
      ],
    );
  },
);
