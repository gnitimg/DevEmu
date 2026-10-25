import { run } from './exec.ts';

/**
 * Windows：模拟器（Qt）会恢复上次窗口位置，可能落在屏幕顶部之外。
 * 启动后按 AVD 名找到 qemu 窗口并移到可见区域。
 */
export function repositionEmulatorWindow(avdName: string, x: number, y: number): Promise<void> {
  // avdName 限定为 [\w.-]，可直接嵌入 WQL/正则
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$proc = Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" | Where-Object { $_.CommandLine -match '-avd ${avdName}(\\s|$)' } | Select-Object -First 1`,
    'if (-not $proc) { exit 0 }',
    '$w = Get-Process -Id $proc.ProcessId',
    'if (-not $w) { exit 0 }',
    'for ($i = 0; $i -lt 80; $i++) { if ($w.MainWindowHandle -ne 0) { break }; Start-Sleep -Milliseconds 500; $w.Refresh() }',
    'if ($w.MainWindowHandle -eq 0) { exit 0 }',
    "Add-Type -Namespace DevEmuWin -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);'",
    '[DevEmuWin.U]::SetWindowPos($w.MainWindowHandle, [IntPtr]::Zero, ' +
      String(x) +
      ', ' +
      String(y) +
      ', 0, 0, 5) | Out-Null',
  ].join('\n');

  return run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    timeoutMs: 60_000,
  }).then(() => undefined);
}
