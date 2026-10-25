/** PrintWindow 直接抓 qemu 窗口内容（不受遮挡影响），并打印窗口矩形 */
import { loadAppSettings } from '../src/core/settings.ts';
import { detectSdk } from '../src/core/sdk.ts';
import { launchEmulator } from '../src/core/emulator.ts';
import { waitBooted } from '../src/core/adb.ts';
import { run } from '../src/core/exec.ts';

const AVD = process.argv[2] ?? 'dg';
const SCOPE = process.argv[3] === 'shared' ? { kind: 'shared' as const } : { kind: 'project' as const, projectId: 'aaa' };

const settings = loadAppSettings();
const sdk = detectSdk(settings.sdkPath)!;

console.log(`[diag] 启动 ${AVD}…`);
const entry = await launchEmulator(sdk, settings.dataRoot, SCOPE, AVD);
const booted = await waitBooted(sdk.adb, entry.serial, 480_000);
console.log(`[diag] boot=${booted}`);
await new Promise((r) => setTimeout(r, 5000));

const ps = [
  "$ErrorActionPreference='Stop'",
  `$proc = Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" | Where-Object { $_.CommandLine -match '-avd ${AVD}(\\s|$)' } | Select-Object -First 1`,
  '$w = Get-Process -Id $proc.ProcessId',
  'for ($i=0; $i -lt 80; $i++) { if ($w.MainWindowHandle -ne 0) { break }; Start-Sleep -Milliseconds 500; $w.Refresh() }',
  'if ($w.MainWindowHandle -eq 0) { Write-Output NOHANDLE; exit 0 }',
  'Add-Type -AssemblyName System.Drawing',
  "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class WinCap { [DllImport(\"user32.dll\")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags); [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr h, out RECT r); public struct RECT { public int L; public int T; public int R; public int B; } }'",
  '$r = New-Object WinCap+RECT',
  '[WinCap]::GetWindowRect($w.MainWindowHandle, [ref]$r) | Out-Null',
  "Write-Output ('RECT ' + $r.L + ',' + $r.T + ' ' + ($r.R - $r.L) + 'x' + ($r.B - $r.T))",
  '$bw = [Math]::Max(1, $r.R - $r.L); $bh = [Math]::Max(1, $r.B - $r.T)',
  '$bmp = New-Object System.Drawing.Bitmap($bw, $bh)',
  '$g = [System.Drawing.Graphics]::FromImage($bmp)',
  '$hdc = $g.GetHdc()',
  '[WinCap]::PrintWindow($w.MainWindowHandle, $hdc, 2) | Out-Null',
  '$g.ReleaseHdc($hdc); $g.Dispose()',
  "$bmp.Save('F:\\cs\\DevEmu\\diag-window.png')",
  '$bmp.Dispose()',
  'Write-Output SAVED',
].join('\n');
const win = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeoutMs: 120_000 });
console.log('[diag]', win.stdout.trim().replace(/\r?\n/g, ' | '), win.stderr.slice(0, 200));

await run(sdk.adb, ['-s', entry.serial, 'emu', 'kill'], { timeoutMs: 10_000 }).catch(() => undefined);
console.log('[diag] stopped');
