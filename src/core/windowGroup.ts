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
    [DllImport("user32.dll")] public static extern uint MsgWaitForMultipleObjects(uint count, IntPtr handles, bool waitAll, uint ms, uint wakeMask);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc callback, uint pid, uint tid, uint flags);
    static uint owner;
    static string serial;
    static bool clampWindow;
    static IntPtr device, pill, location, previousPill, previousLocation, hook;
    static MouseProc callback;
    static WinEventProc layerCallback;
    static WinEventProc locationCallback;
    static IntPtr foregroundHook, reorderHook, locationHook;
    static volatile bool dragging;
    static bool raisePending;
    static int startX, startY, left, top, pillDX, pillDY, locDX, locDY;
    static bool pillFollows, locFollows;
    static RECT lastGeometry;
    static readonly HashSet<IntPtr> hiddenWindows = new HashSet<IntPtr>();
    // 拖动热路径：钩子只记录状态，跨进程移动由独立线程按最新光标位置合并执行。
    static IntPtr dragDevice, dragPill, dragLocation;
    static int targetX, targetY;
    static readonly AutoResetEvent dragSignal = new AutoResetEvent(false);
    public static void Init(uint pid, string id, bool clamp) {
      owner=pid; serial=id; clampWindow=clamp; SetProcessDPIAware();
      callback=OnMouse;
      hook=SetWindowsHookExW(14, callback, GetModuleHandleW(null), 0);
      layerCallback=delegate(IntPtr eventHook, uint kind, IntPtr win, int objectId, int childId, uint threadId, uint time) {
        if (!dragging) DevEmuLayer.Layer.Sync(device, pill, location);
      };
      foregroundHook=SetWinEventHook(3, 3, IntPtr.Zero, layerCallback, 0, 0, 0);
      reorderHook=SetWinEventHook(0x8004, 0x8004, IntPtr.Zero, layerCallback, 0, 0, 0);
      var mover=new Thread(MoverLoop) { IsBackground=true, Name="devemu-window-mover" };
      mover.Start();
    }
    // 原生搬窗（Qt 皮肤拖动/系统移动）只靠 25ms Tick 采样会稳定拖尾：位置变化事件直接触发对齐，
    // 事件在守卫线程的消息泵上派发，与 Tick 共用 lastGeometry 去重，不会重复下发 GEOM。
    public static void Watch(uint qpid) {
      if (locationHook != IntPtr.Zero) return;
      locationCallback=delegate(IntPtr eventHook, uint kind, IntPtr win, int objectId, int childId, uint threadId, uint time) {
        if (objectId == 0 && childId == 0 && !dragging && win == device) Align();
      };
      locationHook=SetWinEventHook(0x800B, 0x800B, IntPtr.Zero, locationCallback, qpid, 0, 0x0002);
    }
    static bool Contains(RECT r, int x, int y) { return x >= r.L && x < r.R && y >= r.T && y < r.B; }
    static IntPtr OnMouse(int code, uint msg, IntPtr data) {
      if (code < 0 || device == IntPtr.Zero) return CallNextHookEx(hook, code, msg, data);
      MSLL m=(MSLL)Marshal.PtrToStructure(data, typeof(MSLL));
      POINT point=new POINT(); point.X=m.x; point.Y=m.y;
      IntPtr target=GetAncestor(WindowFromPoint(point), 2);
      RECT r;
      bool onDevice = msg == 0x204 && GetWindowRect(device, out r) && Contains(r, m.x, m.y) && target == device;
      bool onPill = msg == 0x201 && pill != IntPtr.Zero && GetWindowRect(pill, out r) && Contains(r, m.x, m.y) && m.y >= r.B-(int)(48*Scale()) && target == pill;
      if (onDevice || onPill) {
        GetWindowRect(device, out r);
        startX=m.x; startY=m.y; left=r.L; top=r.T;
        // 跟手关键：药丸/面板与设备同偏移移动，但绝不能在这个全局钩子里同步等 qemu 的 UI 线程，
        // 否则每个鼠标事件都阻塞整机输入，事件积压后表现为光标和窗口 1-2 秒后才追上来。
        RECT f = new RECT();
        pillFollows = pill != IntPtr.Zero && GetWindowRect(pill, out f);
        if (pillFollows) { pillDX=f.L-r.L; pillDY=f.T-r.T; }
        locFollows = location != IntPtr.Zero && GetWindowRect(location, out f);
        if (locFollows) { locDX=f.L-r.L; locDY=f.T-r.T; }
        dragDevice=device; dragPill=pill; dragLocation=location;
        targetX=left; targetY=top;
        raisePending=true;
        dragging=true;
        dragSignal.Set();
        return (IntPtr)1;
      }
      // 按下事件被本钩子吞掉，系统不会把该键置为按下态，GetAsyncKeyState 恒为 0：
      // 拖动只能靠钩子收到的抬键消息结束（全局钩子能看到所有抬键）。
      if (dragging && (msg == 0x202 || msg == 0x205)) { dragging=false; return (IntPtr)1; }
      return CallNextHookEx(hook, code, msg, data);
    }
    static void MoverLoop() {
      while (true) {
        if (!dragging) { dragSignal.WaitOne(100); continue; }
        POINT p;
        if (!GetCursorPos(out p)) { Thread.Sleep(5); continue; }
        int nx=left+p.X-startX, ny=top+p.Y-startY;
        if (nx == targetX && ny == targetY) { Thread.Sleep(4); continue; }
        targetX=nx; targetY=ny;
        // 这里是独立线程，跨进程等待由它吸收：同步移动让三窗同帧落位，且永远只处理最新光标，
        // 异步投递在 qemu UI 线程繁忙时会堆积过期位置，松手后反而出现追赶式滑动。
        const uint moveFlags=0x15;
        SetWindowPos(dragDevice, IntPtr.Zero, nx, ny, 0, 0, moveFlags);
        if (pillFollows) SetWindowPos(dragPill, IntPtr.Zero, nx+pillDX, ny+pillDY, 0, 0, moveFlags);
        if (locFollows) SetWindowPos(dragLocation, IntPtr.Zero, nx+locDX, ny+locDY, 0, 0, moveFlags);
      }
    }
    static double Scale() { uint dpi=GetDpiForWindow(device); return dpi > 0 ? dpi/96.0 : 1; }
    static void Raise() {
      DevEmuLayer.Layer.Sync(device, pill, location, true);
    }
    // -noskin 时 qemu 启动期按整显示器（不含任务栏扣减）适配窗口，时点晚于 app 的一次性启动钳制，
    // 会原样覆盖掉 75% 规则；常驻守卫必须每轮 Tick 校验收回。等比缩放，比例残差由 qemu 自行修正。
    public static int[] ClampSize(int w, int h, int workW, int workH) {
      if (w <= 0 || h <= 0 || workW <= 0 || workH <= 0) return new int[] { w, h };
      int maxW=workW*3/4, maxH=workH*3/4;
      if (w <= maxW && h <= maxH) return new int[] { w, h };
      double s=Math.Min((double)maxW/w, (double)maxH/h);
      return new int[] { Math.Max(1, (int)Math.Round(w*s)), Math.Max(1, (int)Math.Round(h*s)) };
    }
    static void EnsureClamped() {
      RECT r;
      if (!GetWindowRect(device, out r)) return;
      int w=r.R-r.L, ht=r.B-r.T;
      if (w <= 0 || ht <= 0) return;
      MONITORINFO info=new MONITORINFO(); info.size=Marshal.SizeOf(info);
      if (!GetMonitorInfoW(MonitorFromWindow(device, 2), ref info)) return;
      int[] wh=ClampSize(w, ht, info.work.R-info.work.L, info.work.B-info.work.T);
      if (wh[0] == w && wh[1] == ht) return;
      SetWindowPos(device, IntPtr.Zero, 0, 0, wh[0], wh[1], 0x16);
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
      if (raisePending) { raisePending=false; Raise(); }
      // 拖动期间移动线程独占窗口位移；这里若再做 Z 序修复/尺寸钳制，会在输入钩子线程上同步等 qemu。
      if (dragging) return;
      // qemu 有多个顶层窗口（设备屏/工具窗），MainWindowHandle 会随 Z 序跳变：
      // 设备屏窗必然面积最大，枚举选定，避免圆角/拖动/层级作用到错误窗口。
      IntPtr bestDevice=IntPtr.Zero; long bestArea=0;
      pill=IntPtr.Zero; location=IntPtr.Zero;
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
          else {
            RECT wr;
            if (GetWindowRect(win, out wr)) {
              long area=(long)(wr.R-wr.L)*(wr.B-wr.T);
              if (area > bestArea) { bestArea=area; bestDevice=win; }
            }
          }
        }
        return true;
      }, IntPtr.Zero);
      device = bestDevice != IntPtr.Zero ? bestDevice : h;
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
      // HarmonyOS 的 Qt 模拟器按自身规则设定尺寸，强行钳制会与 Qt 互相改回（窗口每 25ms 抖一次）。
      if (clampWindow) EnsureClamped();
      // 透明轮廓由 Qt 的设备皮肤提供，不能覆盖为统一圆角区域。
      Align(pill != previousPill || location != previousLocation);
      if (pill != previousPill || location != previousLocation) Fit();
      DevEmuLayer.Layer.Sync(device, pill, location);
      previousPill=pill; previousLocation=location;
    }
  }
}
${WINDOW_LAYER_NATIVE}`;

const guardPrelude = (serial: string, clamp: boolean): string => String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${NATIVE}
'@
$ownerId=(Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
[DevEmuGroup.Native]::Init([uint32]$ownerId, '${serial}', ${clamp ? '$true' : '$false'})`;

const GUARD_LOOP = String.raw`
$msg=New-Object DevEmuGroup.MSG
$lastProbe=[DateTime]::MinValue
$lastTick=[DateTime]::MinValue
$h=[IntPtr]::Zero
while ($true) {
  while ([DevEmuGroup.Native]::PeekMessageW([ref]$msg, [IntPtr]::Zero, 0, 0, 1)) {
    [DevEmuGroup.Native]::TranslateMessage([ref]$msg) | Out-Null
    [DevEmuGroup.Native]::DispatchMessageW([ref]$msg) | Out-Null
  }
  $now=[DateTime]::Now
  # 低级鼠标钩子回调走消息泵；轮询进程和 Tick 不能再用 Start-Sleep 把输入一起压住。
  if (($now-$lastProbe).TotalMilliseconds -ge 250) {
    $lastProbe=$now
    if (-not (Get-Process -Id $ownerId -ErrorAction SilentlyContinue)) { exit 0 }
    $p=Get-Process -Id $qemuId -ErrorAction SilentlyContinue
    if (-not $p) { Write-Output 'QEMU-GONE'; exit 0 }
    $h=$p.MainWindowHandle
  }
  if (($now-$lastTick).TotalMilliseconds -ge 25) {
    $lastTick=$now
    # 退出竞态：进程对象仍在但主窗口句柄已回收（null/0），绝不能让 Tick 异常杀死循环，QEMU-GONE 必须可达
    if ($null -ne $h -and "$h" -ne "0") { try { [DevEmuGroup.Native]::Tick($h, [uint32]$qemuId) } catch {} }
  }
  [DevEmuGroup.Native]::MsgWaitForMultipleObjects(0, [IntPtr]::Zero, $false, 10, 0x04FF) | Out-Null
}`;

export function buildWindowGuardScript(
  avdName: string,
  serial: string,
): string {
  if (!/^[\w.-]+$/.test(avdName) || !/^emulator-\d{1,5}$/.test(serial))
    throw new Error('非法窗口组');
  // avd 名嵌入正则：允许字符里只有 '.' 是元字符，不转义会匹配到同前缀的其他实例
  const avdMatcher = avdName.replace(/\./g, '\\.');
  return String.raw`
${guardPrelude(serial, true)}
$qemuId=0
for ($i=0; $i -lt 120 -and -not $qemuId; $i++) {
  $p=Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" | Where-Object { $_.CommandLine -match '-avd ${avdMatcher}(\s|$)' } | Select-Object -First 1
  if ($p) { $qemuId=$p.ProcessId } else { Start-Sleep -Seconds 1 }
}
if (-not $qemuId) { exit 1 }
# qemu 进程确定后再装位置事件钩子（按 pid 过滤，系统级事件不进入回调）
[DevEmuGroup.Native]::Watch([uint32]$qemuId)
${GUARD_LOOP}`;
}

/** HarmonyOS 模拟器没有与实例名稳定的进程匹配串（名字可含空格/中文），
 *  由主进程先解析出 Emulator.exe 的 pid 再交给守卫。 */
export function buildHosWindowGuardScript(pid: number, serial: string): string {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff)
    throw new Error('非法窗口组');
  if (!/^hos-[A-Za-z0-9_-]{1,120}$/.test(serial)) throw new Error('非法窗口组');
  return String.raw`
${guardPrelude(serial, false)}
$qemuId=${String(pid)}
if (-not (Get-Process -Id $qemuId -ErrorAction SilentlyContinue)) { exit 1 }
[DevEmuGroup.Native]::Watch([uint32]$qemuId)
${GUARD_LOOP}`;
}
