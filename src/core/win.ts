import { run, stream } from './exec.ts';
import { buildWindowGuardScript } from './windowGroup.ts';
export { buildWindowGuardScript } from './windowGroup.ts';

/** 按 AVD 名强杀 qemu 进程树（注册表丢失时的兜底关闭） */
export async function killEmulatorProcess(avdName: string): Promise<void> {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$proc = Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" | Where-Object { $_.CommandLine -match '-avd ${avdName}(\\s|$)' } | Select-Object -First 1`,
    'if ($proc) { & taskkill.exe /PID $proc.ProcessId /T /F | Out-Null; Write-Output KILLED } else { Write-Output NONE }',
  ].join('\n');
  await run(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeoutMs: 30_000 },
  );
}

/** 强杀全部 qemu 进程树（软件重置/清理前确保 AVD 文件锁释放的最后兜底） */
export async function killAllEmulatorProcesses(): Promise<void> {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F | Out-Null }`,
  ].join('\n');
  await run(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeoutMs: 30_000 },
  );
}

/**
 * Windows：模拟器（Qt）会恢复上次窗口位置，可能落在屏幕之外。
 * 启动后按 AVD 名找到 qemu 窗口并移到指定位置一次；随后周期性复查，
 * 只在窗口完全跑出虚拟屏幕时才拉回，不干预用户手动移动后的位置。
 * 窗口外观改造：去标题栏（WS_CAPTION）、去拉伸/最大化（THICKFRAME|MAXIMIZEBOX），
 * 移动改由常驻守卫的 Alt+左键拖动承担。
 */
export function repositionEmulatorWindow(
  avdName: string,
  x: number,
  y: number,
): Promise<void> {
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
      'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; namespace DevEmuWin { public struct RECT { public int L; public int T; public int R; public int B; } public static class U { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i); [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); } }\'',
      `$move = { [DevEmuWin.U]::SetWindowPos($h, [IntPtr]::Zero, ${String(x)}, ${String(y)}, 0, 0, 5) | Out-Null }`,
      force
        ? [
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
    run(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script(force)],
      {
        timeoutMs: 30_000,
      },
    );

  const waitWindow = (tries: number, delayMs: number): Promise<void> =>
    attempt(true).then((res) => {
      // exit 1 = 窗口还没出现或进程没了：有重试就继续等，否则结束
      if (res.code === 0 || tries <= 1) return undefined;
      return new Promise((r) => setTimeout(r, delayMs)).then(() =>
        waitWindow(tries - 1, delayMs),
      );
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

const guards = new Map<string, ReturnType<typeof stream>>();
const geometryListeners = new Set<(serial: string, geometry: ShellGeom) => void>();

export function onWindowGroupGeometry(listener: (serial: string, geometry: ShellGeom) => void): () => void {
  geometryListeners.add(listener);
  return () => geometryListeners.delete(listener);
}

const qemuGoneListeners = new Set<(serial: string) => void>();

/** qemu 进程消失（关机/被杀/外部启动的设备退出）时回调；窗口组据此同步关闭 */
export function onQemuGone(listener: (serial: string) => void): () => void {
  qemuGoneListeners.add(listener);
  return () => qemuGoneListeners.delete(listener);
}

export function startWindowGuard(avdName: string, serial: string): void {
  if (guards.has(serial)) return;
  const script = buildWindowGuardScript(avdName, serial);
  const child = stream(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      onLine: (line) => {
        const geometry = line.match(/^GEOM (-?\d+) (-?\d+) (\d+) (\d+)$/);
        if (geometry) {
          const values = geometry.slice(1).map(Number);
          for (const listener of geometryListeners) listener(serial, {x:values[0]!,y:values[1]!,screenW:values[2]!,screenH:values[3]!});
        }
        else if (line === 'QEMU-GONE') { for (const listener of qemuGoneListeners) listener(serial); }
        else if (line) console.error('[window-group]', line);
      },
      onExit: () => guards.delete(serial),
    },
  );
  child.on('error', () => guards.delete(serial));
  guards.set(serial, child);
}

export function stopWindowGuards(): void {
  for (const child of guards.values()) child.kill();
  guards.clear();
}

export interface ShellGeom {
  /** qemu 主窗口左上角（物理像素） */
  x: number;
  y: number;
  /** 主窗口宽高（物理像素，等于 guest 屏幕比例） */
  screenW: number;
  screenH: number;
}

/**
 * 查询 qemu 主窗口几何（药丸窗口定位用）。
 * 进程声明 DPI aware，返回物理像素坐标；openPill 按 /scaleFactor 换算 DIP。
 */
export async function getShellGeometry(
  avdName: string,
): Promise<ShellGeom | undefined> {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$proc = Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" | Where-Object { $_.CommandLine -match '-avd ${avdName}(\\s|$)' } | Select-Object -First 1`,
    'if (-not $proc) { exit 1 }',
    '$w = Get-Process -Id $proc.ProcessId',
    'if (-not $w -or $w.MainWindowHandle -eq 0) { exit 1 }',
    '$h = $w.MainWindowHandle',
    'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; namespace DevEmuS { public struct RECT { public int L; public int T; public int R; public int B; } public static class U { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); } }\'',
    '[DevEmuS.U]::SetProcessDPIAware() | Out-Null',
    '$r = New-Object DevEmuS.RECT',
    '[DevEmuS.U]::GetWindowRect($h, [ref]$r) | Out-Null',
    '$sw = $r.R - $r.L',
    '$sh = $r.B - $r.T',
    'if ($sw -lt 80 -or $sh -lt 80) { exit 1 }',
    "Write-Output ('GEOM ' + $r.L + ' ' + $r.T + ' ' + $sw + ' ' + $sh)",
  ].join('\n');
  const res = await run(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      timeoutMs: 30_000,
    },
  ).catch(() => undefined);
  const line = res?.stdout.split(/\r?\n/).find((l) => l.startsWith('GEOM '));
  if (!line) return undefined;
  const parts = line
    .slice(5)
    .trim()
    .split(/\s+/)
    .map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)))
    return undefined;
  return { x: parts[0]!, y: parts[1]!, screenW: parts[2]!, screenH: parts[3]! };
}

/** 双窗拖动（药丸把手发起）：qemu 与药丸按同一偏移跟随鼠标，左键抬起结束。
 *  pillHwndHex 为药丸窗口句柄的十六进制（getNativeWindowHandle），由 electron 侧直传，
 *  避免按标题找窗口（页面 title 会覆盖窗口标题）。
 *  独立进程执行，无需前台校验（拖动由明确的用户按下动作发起）。 */
export function startPairDrag(avdName: string, pillHwndHex: string): void {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; namespace DevEmuD { public struct RECT { public int L; public int T; public int R; public int B; } public struct POINT { public int X; public int Y; } public static class U { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int cx, int cy, bool r); [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k); [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p); } }\'',
    `$avd = '${avdName}'`,
    '[DevEmuD.U]::SetProcessDPIAware() | Out-Null',
    `$pill = [IntPtr]([Convert]::ToInt64('${pillHwndHex || '0'}', 16))`,
    '$hwnd = [IntPtr]::Zero',
    'for ($i = 0; $i -lt 20 -and $hwnd -eq [IntPtr]::Zero; $i++) {',
    "  $proc = Get-CimInstance Win32_Process -Filter \"Name='qemu-system-x86_64.exe'\" | Where-Object { $_.CommandLine -match ('-avd ' + $avd + '(\\s|$)') } | Select-Object -First 1",
    '  if ($proc) { $w = Get-Process -Id $proc.ProcessId; if ($w -and $w.MainWindowHandle -ne 0) { $hwnd = $w.MainWindowHandle } }',
    '  if ($hwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 500 }',
    '}',
    'if ($hwnd -eq [IntPtr]::Zero) { exit 1 }',
    // 等待左键按下（正常情况下调用即已按下），最多 3 秒
    'for ($i = 0; $i -lt 30; $i++) {',
    '  if (([DevEmuD.U]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0) { break }',
    '  Start-Sleep -Milliseconds 100',
    '}',
    'if (([DevEmuD.U]::GetAsyncKeyState(0x01) -band 0x8000) -eq 0) { exit 0 }',
    '$r0 = New-Object DevEmuD.RECT',
    '[DevEmuD.U]::GetWindowRect($hwnd, [ref]$r0) | Out-Null',
    '$p0 = New-Object DevEmuD.POINT',
    '[DevEmuD.U]::GetCursorPos([ref]$p0) | Out-Null',
    '$offX = $p0.X - $r0.L',
    '$offY = $p0.Y - $r0.T',
    '$dw = $r0.R - $r0.L',
    '$dh = $r0.B - $r0.T',
    '$px = 0; $py = 0; $pw = 0; $ph = 0',
    'if ($pill -ne [IntPtr]::Zero) {',
    '  $pr = New-Object DevEmuD.RECT',
    '  [DevEmuD.U]::GetWindowRect($pill, [ref]$pr) | Out-Null',
    '  $px = $pr.L - $r0.L',
    '  $py = $pr.T - $r0.T',
    '  $pw = $pr.R - $pr.L',
    '  $ph = $pr.B - $pr.T',
    '}',
    'while (([DevEmuD.U]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0) {',
    '  $p1 = New-Object DevEmuD.POINT',
    '  [DevEmuD.U]::GetCursorPos([ref]$p1) | Out-Null',
    '  $nx = $p1.X - $offX',
    '  $ny = $p1.Y - $offY',
    '  [DevEmuD.U]::MoveWindow($hwnd, $nx, $ny, $dw, $dh, $true) | Out-Null',
    '  if ($pill -ne [IntPtr]::Zero) { [DevEmuD.U]::MoveWindow($pill, $nx + $px, $ny + $py, $pw, $ph, $true) | Out-Null }',
    '  Start-Sleep -Milliseconds 16',
    '}',
  ].join('\n');
  void stream(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      onLine: () => undefined,
    },
  );
}
