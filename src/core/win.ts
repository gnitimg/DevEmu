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
 * 窗口外观改造：去标题栏（WS_CAPTION）、去拉伸/最大化（THICKFRAME|MAXIMIZEBOX），
 * 移动改由常驻守卫的 Alt+左键拖动承担。
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
      force
        ? [
            // 首次定位：高 ≤ 屏幕高 75% 或宽 ≤ 屏幕宽 75%（先触发者为准），另一边等比
            '$r0 = New-Object DevEmuWin.RECT',
            '[DevEmuWin.U]::GetWindowRect($h, [ref]$r0) | Out-Null',
            '$w0 = $r0.R - $r0.L',
            '$h0 = $r0.B - $r0.T',
            'if ($w0 -gt 0 -and $h0 -gt 0) {',
            '  Add-Type -AssemblyName System.Windows.Forms',
            '  $wa = [System.Windows.Forms.SystemInformation]::WorkingArea',
            '  $maxW = [int]($wa.Width * 0.75)',
            '  $maxH = [int]($wa.Height * 0.75)',
            '  $nw = $w0; $nh = $h0',
            '  if ($nw -gt $maxW) { $nw = $maxW; $nh = [int][Math]::Round($nw * $h0 / $w0) }',
            '  if ($nh -gt $maxH) { $nh = $maxH; $nw = [int][Math]::Round($nh * $w0 / $h0) }',
            `  [DevEmuWin.U]::SetWindowPos($h, [IntPtr]::Zero, ${String(x)}, ${String(y)}, $nw, $nh, 0x0014) | Out-Null`,
            '}',
          ].join('\n')
        : [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen',
        '$r = New-Object DevEmuWin.RECT',
        '[DevEmuWin.U]::GetWindowRect($h, [ref]$r) | Out-Null',
        // 与虚拟屏幕完全无交集（整体不可见）才拉回；部分越界视为用户自行摆放
        'if ($r.R -le $vs.Left -or $r.L -ge $vs.Right -or $r.B -le $vs.Top -or $r.T -ge $vs.Bottom) { & $move }',
      ].join('\n'),
      // 去标题栏 + 去拉伸/最大化：允许移动（Alt+拖动），不允许拉伸
      '$s = [DevEmuWin.U]::GetWindowLong($h, -16)',
      '$s = ($s -band (-bnot 0x00C00000)) -band (-bnot 0x00040000) -band (-bnot 0x00010000)',
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

/**
 * 常驻窗口守卫：qemu 退出后自退。
 * - 样式自愈：Qt 若重新加回标题栏/拉伸边框/最大化，约 1.6 秒内剥掉；
 * - Alt+左键拖动：无边框窗口的移动方式（按住 Alt 在窗口任意处拖动）。
 * 轻量轮询（25ms 间隔，仅 user32 调用），WMI 只在启动时解析一次 qemu pid。
 * 注意 $pid 是 PowerShell 只读自动变量，这里用 $qpid。
 */
export function startWindowGuard(avdName: string): void {
  const watcher = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; namespace DevEmuG { public struct RECT { public int L; public int T; public int R; public int B; } public struct POINT { public int X; public int Y; } public static class U { [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport(\"user32.dll\")] public static extern bool MoveWindow(IntPtr h, int x, int y, int cx, int cy, bool r); [DllImport(\"user32.dll\")] public static extern int GetWindowLong(IntPtr h, int i); [DllImport(\"user32.dll\")] public static extern int SetWindowLong(IntPtr h, int i, int v); [DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); [DllImport(\"user32.dll\")] public static extern short GetAsyncKeyState(int k); [DllImport(\"user32.dll\")] public static extern bool GetCursorPos(out POINT p); [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); } }'",
    `$avd = '${avdName}'`,
    '$qpid = 0',
    'for ($i = 0; $i -lt 120 -and -not $qpid; $i++) {',
    "  $p = Get-CimInstance Win32_Process -Filter \"Name='qemu-system-x86_64.exe'\" | Where-Object { $_.CommandLine -match ('-avd ' + $avd + '(\\s|$)') } | Select-Object -First 1",
    '  if ($p) { $qpid = $p.ProcessId } else { Start-Sleep -Seconds 1 }',
    '}',
    'if (-not $qpid) { exit 1 }',
    '$hwnd = [IntPtr]::Zero',
    '$tick = 0',
    'while ($true) {',
    '  if ($tick % 4 -eq 0) {',
    '    $w = Get-Process -Id $qpid',
    '    if (-not $w) { exit 0 }',
    '    if ($w.MainWindowHandle -ne 0) { $hwnd = $w.MainWindowHandle }',
    '  }',
    '  if ($hwnd -ne [IntPtr]::Zero) {',
    // 样式自愈：与 reposition 的样式手术保持同一掩码
    '    if ($tick % 64 -eq 0) {',
    '      $s = [DevEmuG.U]::GetWindowLong($hwnd, -16)',
    '      if (($s -band 0x00C00000) -ne 0 -or ($s -band 0x00040000) -ne 0 -or ($s -band 0x00010000) -ne 0) {',
    '        $s2 = ($s -band (-bnot 0x00C00000)) -band (-bnot 0x00040000) -band (-bnot 0x00010000)',
    '        [DevEmuG.U]::SetWindowLong($hwnd, -16, $s2) | Out-Null',
    '        [DevEmuG.U]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 0, 0, 39) | Out-Null',
    '      }',
    '    }',
    // Alt+左键拖动移动（仅 qemu 为前台窗口时）
    '    if (([DevEmuG.U]::GetAsyncKeyState(0x12) -band 0x8000) -ne 0 -and ([DevEmuG.U]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0 -and ([DevEmuG.U]::GetForegroundWindow() -eq $hwnd)) {',
    '      $r0 = New-Object DevEmuG.RECT',
    '      [DevEmuG.U]::GetWindowRect($hwnd, [ref]$r0) | Out-Null',
    '      $p0 = New-Object DevEmuG.POINT',
    '      [DevEmuG.U]::GetCursorPos([ref]$p0) | Out-Null',
    '      $offX = $p0.X - $r0.L',
    '      $offY = $p0.Y - $r0.T',
    '      $dw = $r0.R - $r0.L',
    '      $dh = $r0.B - $r0.T',
    '      while (([DevEmuG.U]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0) {',
    '        $p1 = New-Object DevEmuG.POINT',
    '        [DevEmuG.U]::GetCursorPos([ref]$p1) | Out-Null',
    '        [DevEmuG.U]::MoveWindow($hwnd, $p1.X - $offX, $p1.Y - $offY, $dw, $dh, $true) | Out-Null',
    '        Start-Sleep -Milliseconds 10',
    '      }',
    '    }',
    '  }',
    '  $tick = ($tick + 1) % 64',
    '  Start-Sleep -Milliseconds 25',
    '}',
  ].join('\n');
  void stream('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', watcher], {
    onLine: () => undefined,
  });
}
