import { run, stream } from './exec.ts';

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
 * Windows：模拟器（Qt）会恢复上次窗口位置，可能落在屏幕之外。
 * 启动后按 AVD 名找到 qemu 窗口并移到指定位置一次；随后周期性复查，
 * 只在窗口完全跑出虚拟屏幕时才拉回，不干预用户手动移动后的位置。
 * 去掉 WS_THICKFRAME|WS_MAXIMIZEBOX：只允许移动，不允许拉伸——
 * 无法做到零延迟的等比锁定（同步拦截需注入模拟器进程），按用户决策禁用缩放。
 */
export function repositionEmulatorWindow(avdName: string, x: number, y: number): Promise<void> {
  // avdName 限定为 [\w.-]，可直接嵌入 WQL/正则
  // force=true：首次定位，无条件移动；false：仅当窗口与虚拟屏幕完全无交集时移动
  const script = (force: boolean) =>
    [
      "$ErrorActionPreference='SilentlyContinue'",
      `$proc = Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" | Where-Object { $_.CommandLine -match '-avd ${avdName}(\\s|$)' } | Select-Object -First 1`,
      'if (-not $proc) { exit 1 }',
      '$w = Get-Process -Id $proc.ProcessId',
      'if (-not $w) { exit 1 }',
      'if ($w.MainWindowHandle -eq 0) { exit 1 }',
      '$h = $w.MainWindowHandle',
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; namespace DevEmuWin { public struct RECT { public int L; public int T; public int R; public int B; } public static class U { [DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); [DllImport(\"user32.dll\")] public static extern int GetWindowLong(IntPtr h, int i); [DllImport(\"user32.dll\")] public static extern int SetWindowLong(IntPtr h, int i, int v); [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr h, out RECT r); } }'",
      `$move = { [DevEmuWin.U]::SetWindowPos($h, [IntPtr]::Zero, ${String(x)}, ${String(y)}, 0, 0, 5) | Out-Null }`,
      force ? '& $move' : [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen',
        '$r = New-Object DevEmuWin.RECT',
        '[DevEmuWin.U]::GetWindowRect($h, [ref]$r) | Out-Null',
        // 与虚拟屏幕完全无交集（整体不可见）才拉回；部分越界视为用户自行摆放
        'if ($r.R -le $vs.Left -or $r.L -ge $vs.Right -or $r.B -le $vs.Top -or $r.T -ge $vs.Bottom) { & $move }',
      ].join('\n'),
      // 去掉 WS_THICKFRAME|WS_MAXIMIZEBOX：只允许移动，不允许拉伸
      '$s = [DevEmuWin.U]::GetWindowLong($h, -16)',
      '$s = ($s -band (-bnot 0x00040000)) -band (-bnot 0x00010000)',
      '[DevEmuWin.U]::SetWindowLong($h, -16, $s) | Out-Null',
      '[DevEmuWin.U]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 39) | Out-Null',
      'exit 0',
    ]
      .flat()
      .join('\n');

  const attempt = (force: boolean) =>
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script(force)], {
      timeoutMs: 30_000,
    });

  const waitWindow = (tries: number, delayMs: number): Promise<void> =>
    attempt(true).then((res) => {
      // exit 1 = 窗口还没出现或进程没了：有重试就继续等，否则结束
      if (res.code === 0 || tries <= 1) return undefined;
      return new Promise((r) => setTimeout(r, delayMs)).then(() => waitWindow(tries - 1, delayMs));
    });

  // 找到窗口前最多等 2 分钟（期间完成首次定位）；之后低频复查约 2 分钟，仅纠离屏
  return waitWindow(24, 5000).then(() => {
    let reassert = 12;
    const tick = (): Promise<void> =>
      reassert-- <= 0
        ? Promise.resolve()
        : new Promise((r) => setTimeout(r, 10_000))
            .then(() => attempt(false))
            .then(tick);
    return tick();
  });
}
