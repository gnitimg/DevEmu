import { run } from './exec.ts';

/** 按 AVD 名强杀 qemu 进程树（注册表丢失时的兜底关闭） */
export async function killEmulatorProcess(avdName: string): Promise<void> {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$proc = Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" | Where-Object { $_.CommandLine -match '-avd ${avdName}(\\s|$)' } | Select-Object -First 1`,
    'if ($proc) { & taskkill.exe /PID $proc.ProcessId /T /F | Out-Null; Write-Output KILLED } else { Write-Output NONE }',
  ].join('\n');
  await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeoutMs: 30_000 });
}

/**
 * Windows：模拟器（Qt）会恢复上次窗口位置，可能落在屏幕顶部之外。
 * 启动后按 AVD 名找到 qemu 窗口并移到可见区域；Qt 在窗口完全显示后可能再恢复
 * 一次几何，故首次移动后周期性重申，共持续约两分钟。
 */
export function repositionEmulatorWindow(avdName: string, x: number, y: number): Promise<void> {
  // avdName 限定为 [\w.-]，可直接嵌入 WQL/正则
  const moveOnce = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$proc = Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" | Where-Object { $_.CommandLine -match '-avd ${avdName}(\\s|$)' } | Select-Object -First 1`,
    'if (-not $proc) { exit 1 }',
    '$w = Get-Process -Id $proc.ProcessId',
    'if (-not $w) { exit 1 }',
    'if ($w.MainWindowHandle -eq 0) { exit 1 }',
    '$h = $w.MainWindowHandle',
    "Add-Type -Namespace DevEmuWin -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags); [DllImport(\"user32.dll\")] public static extern int GetWindowLong(IntPtr h, int i); [DllImport(\"user32.dll\")] public static extern int SetWindowLong(IntPtr h, int i, int v);'",
    `[DevEmuWin.U]::SetWindowPos($h, [IntPtr]::Zero, ${String(x)}, ${String(y)}, 0, 0, 5) | Out-Null`,
    // 去掉 WS_THICKFRAME|WS_MAXIMIZEBOX：只允许移动，不允许拉伸
    '$s = [DevEmuWin.U]::GetWindowLong($h, -16)',
    '$s = ($s -band (-bnot 0x00040000)) -band (-bnot 0x00010000)',
    '[DevEmuWin.U]::SetWindowLong($h, -16, $s) | Out-Null',
    '[DevEmuWin.U]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 39) | Out-Null',
    'exit 0',
  ].join('\n');

  const attempt = (tries: number, delayMs: number): Promise<void> =>
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', moveOnce], {
      timeoutMs: 30_000,
    }).then((res) => {
      // exit 1 = 窗口还没出现或进程没了：有重试就继续等，否则结束
      if (res.code === 0 || tries <= 1) return undefined;
      return new Promise((r) => setTimeout(r, delayMs)).then(() => attempt(tries - 1, delayMs));
    });

  // 找到窗口前最多等 2 分钟；成功后再低频重申 12 次（约 2 分钟），对抗 Qt 的几何恢复
  return attempt(24, 5000).then(() => {
    let reassert = 12;
    const tick = (): Promise<void> =>
      reassert-- <= 0
        ? Promise.resolve()
        : new Promise((r) => setTimeout(r, 10_000))
            .then(() => attempt(1, 0))
            .then(tick);
    return tick();
  });
}
