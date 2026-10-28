import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './exec.ts';
import { buildWindowGuardScript } from './windowGroup.ts';
import { buildWindowLayerAuditScript } from './windowLayer.ts';

test(
  '原生层级守卫把分离窗口作为整组排列，后台修复不抢前台',
  {
    skip: process.platform !== 'win32',
    timeout: 30_000,
  },
  async () => {
    const native = buildWindowGuardScript('test', 'emulator-5554').match(
      /Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/,
    )?.[1];
    assert.ok(native);
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
function Entry([long]$handle, [bool]$group, [bool]$topmost=$false, [bool]$related=$false) {
  $entry=New-Object DevEmuLayer.WindowEntry($handle,$group,$topmost)
  $entry.Related=$related
  $entry
}
function Plan($name, $stack, $active, [long]$foreground=0) {
  $plan=[DevEmuLayer.Layer]::Plan([DevEmuLayer.WindowEntry[]]$stack,1,$active,$foreground)
  [pscustomobject]@{name=$name; repair=$plan.Repair; anchor=$plan.Anchor.ToInt64(); topmost=$plan.Topmost; order=@($plan.BottomToTop | ForEach-Object { $_.ToInt64() })}
}
@(
  Plan 'split-background' @((Entry 3 $true),(Entry 2 $true),(Entry 90 $false),(Entry 1 $true)) $false
  Plan 'split-active' @((Entry 3 $true),(Entry 90 $false),(Entry 2 $true),(Entry 1 $true)) $true
  Plan 'covered-active' @((Entry 90 $false),(Entry 3 $true),(Entry 2 $true),(Entry 1 $true)) $true
  Plan 'contiguous-background' @((Entry 90 $false),(Entry 3 $true),(Entry 2 $true),(Entry 1 $true)) $false
  Plan 'topmost-mismatch' @((Entry 3 $true $true),(Entry 90 $false),(Entry 2 $true),(Entry 1 $true)) $false
  Plan 'related-popup' @((Entry 91 $false $true $true),(Entry 3 $true),(Entry 92 $false $false $true),(Entry 2 $true),(Entry 1 $true)) $true
  Plan 'topmost-external' @((Entry 90 $false $true),(Entry 3 $true),(Entry 2 $true),(Entry 1 $true)) $true
  Plan 'other-device' @((Entry 93 $false),(Entry 3 $true),(Entry 2 $true),(Entry 94 $false),(Entry 1 $true)) $false
  Plan 'foreground-before-reorder' @((Entry 3 $true),(Entry 2 $true),(Entry 1 $true),(Entry 90 $false)) $false 90
  Plan 'foreground-splits-group' @((Entry 3 $true),(Entry 90 $false),(Entry 2 $true),(Entry 94 $false),(Entry 1 $true)) $false 90
) | ConvertTo-Json -Compress -Depth 4
`,
      ],
      { timeoutMs: 25_000 },
    );
    assert.equal(result.code, 0, result.stderr);
    const plans = JSON.parse(result.stdout) as Array<{
      name: string;
      repair: boolean;
      anchor: number;
      topmost: boolean;
      order: number[];
    }>;
    assert.deepEqual(
      plans.map(({ name, repair, anchor }) => [name, repair, anchor]),
      [
        ['split-background', true, 90],
        ['split-active', true, 0],
        ['covered-active', true, 0],
        ['contiguous-background', false, 90],
        ['topmost-mismatch', true, 90],
        ['related-popup', false, 0],
        ['topmost-external', false, 0],
        ['other-device', true, 94],
        ['foreground-before-reorder', true, 90],
        ['foreground-splits-group', true, 94],
      ],
    );
    for (const plan of plans) {
      assert.equal(plan.topmost, false, plan.name);
      assert.deepEqual(plan.order, [1, 2, 3], plan.name);
    }
  },
);

test('层级诊断拒绝无效窗口标识', () => {
  assert.throws(() => buildWindowLayerAuditScript("test'", 'emulator-5554', 1));
  assert.throws(() => buildWindowLayerAuditScript('test', 'other-window', 1));
  assert.throws(() => buildWindowLayerAuditScript('test', 'emulator-5554', 0));
});
