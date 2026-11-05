import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './exec.ts';
import { buildWindowGuardScript } from './windowGroup.ts';

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
