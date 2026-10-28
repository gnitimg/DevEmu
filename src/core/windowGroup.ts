import { WINDOW_LAYER_NATIVE } from './windowLayer.ts';

export const VM_GAP_DIP = 14;
export const VM_RADIUS_DIP = 20;

// 守卫只处理本 serial；不使用 topmost，外部应用可以遮住整组。
const NATIVE = String.raw`
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
namespace DevEmuGroup {
  public struct RECT { public int L, T, R, B; }
  public struct POINT { public int X, Y; }
  public struct MONITORINFO { public int size; public RECT monitor, work; public uint flags; }
  public struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x, y; }
  public struct MSLL { public int x, y; public uint data, flags, time; public UIntPtr extra; }
  public delegate IntPtr MouseProc(int code, uint message, IntPtr data);
  public delegate bool EnumProc(IntPtr h, IntPtr data);
  public delegate void WinEventProc(IntPtr hook, uint kind, IntPtr h, int objectId, int childId, uint threadId, uint time);
  public static class Native {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int index, int value);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int index, IntPtr value);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint command);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfoW(IntPtr h, ref MONITORINFO info);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookExW(int id, MouseProc callback, IntPtr module, uint tid);
    [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, uint msg, IntPtr data);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr GetModuleHandleW(string name);
    [DllImport("user32.dll")] public static extern bool PeekMessageW(out MSG msg, IntPtr h, uint min, uint max, uint remove);
    [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] public static extern IntPtr DispatchMessageW(ref MSG msg);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc callback, uint pid, uint tid, uint flags);
    static uint owner;
    static string serial;
    static IntPtr device, pill, location, previousPill, previousLocation, hook;
    static MouseProc callback;
    static WinEventProc layerCallback;
    static IntPtr foregroundHook, reorderHook;
    static bool dragging;
    static int startX, startY, left, top, width, height;
    static RECT lastGeometry;
    static readonly HashSet<IntPtr> hiddenWindows = new HashSet<IntPtr>();
    public static void Init(uint pid, string id) {
      owner=pid; serial=id; SetProcessDPIAware();
      callback=OnMouse;
      hook=SetWindowsHookExW(14, callback, GetModuleHandleW(null), 0);
      layerCallback=delegate(IntPtr eventHook, uint kind, IntPtr win, int objectId, int childId, uint threadId, uint time) {
        DevEmuLayer.Layer.Sync(device, pill, location);
      };
      foregroundHook=SetWinEventHook(3, 3, IntPtr.Zero, layerCallback, 0, 0, 0);
      reorderHook=SetWinEventHook(0x8004, 0x8004, IntPtr.Zero, layerCallback, 0, 0, 0);
    }
    static bool Contains(RECT r, int x, int y) { return x >= r.L && x < r.R && y >= r.T && y < r.B; }
    static IntPtr OnMouse(int code, uint msg, IntPtr data) {
      if (code < 0 || device == IntPtr.Zero) return CallNextHookEx(hook, code, msg, data);
      MSLL m=(MSLL)Marshal.PtrToStructure(data, typeof(MSLL));
      POINT point=new POINT(); point.X=m.x; point.Y=m.y;
      IntPtr target=GetAncestor(WindowFromPoint(point), 2);
      RECT r;
      if ((msg == 0x204 && GetWindowRect(device, out r) && Contains(r, m.x, m.y) && target == device) ||
          (msg == 0x201 && pill != IntPtr.Zero && GetWindowRect(pill, out r) && Contains(r, m.x, m.y) && m.y >= r.B-(int)(48*Scale()) && target == pill)) {
        GetWindowRect(device, out r);
        startX=m.x; startY=m.y; left=r.L; top=r.T; width=r.R-r.L; height=r.B-r.T; dragging=true;
        Raise();
        return (IntPtr)1;
      }
      if (dragging && msg == 0x200) {
        SetWindowPos(device, IntPtr.Zero, left+m.x-startX, top+m.y-startY, width, height, 0x14);
        Align();
      }
      if (dragging && (msg == 0x202 || msg == 0x205)) { dragging=false; return (IntPtr)1; }
      return CallNextHookEx(hook, code, msg, data);
    }
    static double Scale() { uint dpi=GetDpiForWindow(device); return dpi > 0 ? dpi/96.0 : 1; }
    static void Raise() {
      DevEmuLayer.Layer.Sync(device, pill, location, true);
    }
    static void Align(bool force=false) {
      RECT r;
      if (!GetWindowRect(device, out r)) return;
      if (force || r.L != lastGeometry.L || r.T != lastGeometry.T || r.R != lastGeometry.R || r.B != lastGeometry.B) {
        lastGeometry=r;
        // Electron 自己更新不可拉伸窗口的尺寸，避免 Win32 尺寸被最小/最大尺寸约束拒绝。
        Console.WriteLine("GEOM " + r.L + " " + r.T + " " + (r.R-r.L) + " " + (r.B-r.T));
      }
    }
    static void Fit() {
      RECT r, end;
      if (!GetWindowRect(device, out r)) return;
      IntPtr last=location != IntPtr.Zero ? location : pill != IntPtr.Zero ? pill : device;
      if (!GetWindowRect(last, out end)) return;
      MONITORINFO info=new MONITORINFO(); info.size=Marshal.SizeOf(info);
      if (!GetMonitorInfoW(MonitorFromWindow(device, 2), ref info)) return;
      int groupWidth=end.R-r.L;
      int x=Math.Max(info.work.L, Math.Min(r.L, info.work.R-groupWidth));
      int y=Math.Max(info.work.T, Math.Min(r.T, info.work.B-(r.B-r.T)));
      if (x != r.L || y != r.T) { SetWindowPos(device, IntPtr.Zero, x, y, 0, 0, 0x15); Align(); }
    }
    public static void Tick(IntPtr h, uint qpid) {
      device=h; pill=IntPtr.Zero; location=IntPtr.Zero;
      EnumWindows(delegate(IntPtr win, IntPtr unused) {
        uint pid; GetWindowThreadProcessId(win, out pid);
        if (pid == owner) {
          StringBuilder text=new StringBuilder(160); GetWindowTextW(win, text, 160);
          if (text.ToString() == "devemu-pill " + serial) pill=win;
          if (text.ToString() == "devemu-location " + serial) location=win;
        }
        if (pid == qpid && IsWindowVisible(win)) {
          StringBuilder cls=new StringBuilder(128); GetClassNameW(win, cls, 128);
          if (cls.ToString().StartsWith("Qt") && cls.ToString().Contains("QWindowToolSaveBits")) ShowWindow(win, 0);
        }
        return true;
      }, IntPtr.Zero);
      // Owner 管理生命周期；连续 Z 序由 Layer 同步，不能只依赖 owned window 规则。
      bool bound=false;
      if (pill != IntPtr.Zero && GetWindow(pill, 4) != device) { SetWindowLongPtr(pill, -8, device); bound=true; }
      if (location != IntPtr.Zero && GetWindow(location, 4) != device) { SetWindowLongPtr(location, -8, device); bound=true; }
      if (bound) Console.WriteLine("BOUND " + serial + " " + (pill == IntPtr.Zero || GetWindow(pill, 4) == device) + " " + (location == IntPtr.Zero || GetWindow(location, 4) == device));
      bool minimized=IsIconic(device);
      foreach (IntPtr win in new IntPtr[] { pill, location }) {
        if (win == IntPtr.Zero) continue;
        if (minimized && IsWindowVisible(win)) { ShowWindow(win, 0); hiddenWindows.Add(win); }
        else if (!minimized && hiddenWindows.Remove(win)) ShowWindow(win, 4);
      }
      if (minimized) return;
      int style=GetWindowLong(device, -16);
      int fixedStyle=style & ~0x00C00000 & ~0x00040000 & ~0x00010000;
      if (style != fixedStyle) { SetWindowLong(device, -16, fixedStyle); SetWindowPos(device, IntPtr.Zero, 0, 0, 0, 0, 0x37); }
      Align(pill != previousPill || location != previousLocation);
      if (pill != previousPill || location != previousLocation) Fit();
      DevEmuLayer.Layer.Sync(device, pill, location);
      previousPill=pill; previousLocation=location;
    }
  }
}
${WINDOW_LAYER_NATIVE}`;

export function buildWindowGuardScript(
  avdName: string,
  serial: string,
): string {
  if (!/^[\w.-]+$/.test(avdName) || !/^emulator-\d{1,5}$/.test(serial))
    throw new Error('非法窗口组');
  return String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${NATIVE}
'@
$ownerId=(Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
[DevEmuGroup.Native]::Init([uint32]$ownerId, '${serial}')
$qemuId=0
for ($i=0; $i -lt 120 -and -not $qemuId; $i++) {
  $p=Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" | Where-Object { $_.CommandLine -match '-avd ${avdName}(\s|$)' } | Select-Object -First 1
  if ($p) { $qemuId=$p.ProcessId } else { Start-Sleep -Seconds 1 }
}
if (-not $qemuId) { exit 1 }
$msg=New-Object DevEmuGroup.MSG
while ($true) {
  if (-not (Get-Process -Id $ownerId -ErrorAction SilentlyContinue)) { exit 0 }
  while ([DevEmuGroup.Native]::PeekMessageW([ref]$msg, [IntPtr]::Zero, 0, 0, 1)) {
    [DevEmuGroup.Native]::TranslateMessage([ref]$msg) | Out-Null
    [DevEmuGroup.Native]::DispatchMessageW([ref]$msg) | Out-Null
  }
  $p=Get-Process -Id $qemuId -ErrorAction SilentlyContinue
  if (-not $p) { Write-Output 'QEMU-GONE'; exit 0 }
  if ($p.MainWindowHandle -ne 0) { [DevEmuGroup.Native]::Tick($p.MainWindowHandle, [uint32]$qemuId) }
  Start-Sleep -Milliseconds 25
}`;
}
