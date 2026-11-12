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
  // 抬键兜底：钩子被系统静默旁路时由 MoverLoop 轮询异步键状态结束拖动；
  // buttonSeen 闩锁保证从未观察到按下态就绝不解除（旧断言"不得使用
  // GetAsyncKeyState"基于"被吞按键不反映到异步键状态"的误诊，已删）
  assert.match(script, /GetAsyncKeyState\(0x01\)/);
  assert.match(script, /GetAsyncKeyState\(0x02\)/);
  assert.match(script, /buttonSeen/);
  assert.match(script, /static void MoverLoop\(\)/);
  // 跨进程等待只允许发生在移动线程；异步投递会堆积过期位置
  assert.match(script, /const uint moveFlags=0x15/);
  assert.doesNotMatch(script, /SWP_ASYNCWINDOWPOS|0x4015/);
  assert.match(script, /MsgWaitForMultipleObjects/);
  // 拖动期间守卫主循环不再做 Z 序修复/钳制
  assert.match(script, /if \(dragging\) return;/);
});

test('HarmonyOS 守卫按 pid 定位窗口，实例名只以 base64 传入（用作窗口标题）', () => {
  const serial = hosPillSerial('Pura 90 测试');
  const script = buildHosWindowGuardScript(4321, serial, 'Pura 90 测试');
  // 实例名可含空格/中文/引号：原样拼进脚本会被引号打断，base64 后仅作标题
  assert.doesNotMatch(script, /Pura 90/);
  const b64 = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
  assert.ok(b64, '标题必须 base64 传入');
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), 'Pura 90 测试');
  assert.match(script, /\$qemuId=4321/);
  assert.match(script, /\[DevEmuGroup\.Native\]::Watch\(\[uint32\]\$qemuId\)/);
  assert.match(script, /static void MoverLoop\(\)/);
  // Qt 模拟器自己定尺寸；守卫再钳制会与 Qt 互相改回，表现为窗口持续抽搐
  assert.match(script, /::Init\(\[uint32\]\$ownerId, '[^']+', \$false, \$title\)/);
  assert.throws(() => buildHosWindowGuardScript(0, serial, 'x'), /非法窗口组/);
  assert.throws(() => buildHosWindowGuardScript(4321, "a'; exit 0; #", 'x'), /非法窗口组/);
  assert.throws(() => buildHosWindowGuardScript(4321, serial, '  '), /非法窗口组/);
});

test('Android 守卫保留 75% 尺寸钳制', () => {
  const script = buildWindowGuardScript('test', 'emulator-5554');
  assert.match(script, /::Init\(\[uint32\]\$ownerId, '[^']+', \$true, \$title\)/);
});

test('守卫把设备窗口标题改写为设备名称', () => {
  const script = buildWindowGuardScript('test', 'emulator-5554');
  // Qt 启动/旋转会改写标题，Tick 里低频复查并写回
  assert.match(script, /SetWindowTextW\(device, windowTitle\)/);
  assert.match(script, /EnsureTitle\(\);/);
  // test → base64
  assert.match(script, /FromBase64String\('dGVzdA=='\)/);
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
