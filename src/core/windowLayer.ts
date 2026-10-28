// 此代码同时供窗口守卫和原生层级回归使用；不参与窗口定位、尺寸或外观设置。
export const WINDOW_LAYER_NATIVE = String.raw`
namespace DevEmuLayer {
  using System;
  using System.Text;
  using System.Collections.Generic;
  using System.Runtime.InteropServices;

  public class WindowEntry {
    public IntPtr Handle;
    public bool Group;
    public bool Related;
    public bool Topmost;
    public WindowEntry(long handle, bool group, bool topmost) {
      Handle=new IntPtr(handle); Group=group; Topmost=topmost;
    }
  }
  public class LayerPlan {
    public bool Repair;
    public IntPtr Anchor;
    public bool Topmost;
    public IntPtr[] BottomToTop;
  }
  public static class Layer {
    struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] static extern IntPtr GetTopWindow(IntPtr parent);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern IntPtr BeginDeferWindowPos(int count);
    [DllImport("user32.dll")] static extern IntPtr DeferWindowPos(IntPtr batch, IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool EndDeferWindowPos(IntPtr batch);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
    static bool repairing;

    static List<WindowEntry> ReadStack(IntPtr device, IntPtr pill, IntPtr location) {
      var stack=new List<WindowEntry>();
      var visited=new HashSet<IntPtr>();
      for (IntPtr h=GetTopWindow(IntPtr.Zero); h != IntPtr.Zero && visited.Add(h); h=GetWindow(h, 2)) {
        RECT rect;
        int cloaked=0;
        if (!IsWindowVisible(h) || IsIconic(h) || !GetWindowRect(h, out rect) || rect.R <= rect.L || rect.B <= rect.T) continue;
        DwmGetWindowAttribute(h, 14, out cloaked, 4);
        if (cloaked != 0) continue;
        var item=new WindowEntry(h.ToInt64(), h == device || h == pill || h == location, (GetWindowLong(h, -20) & 8) != 0);
        item.Related=GetAncestor(h, 3) == device;
        stack.Add(item);
      }
      return stack;
    }

    // Owner 只约束侧栏在设备上方，不能阻止其他窗口插在三者之间。
    public static LayerPlan Plan(WindowEntry[] stack, long deviceHandle, bool active, long foregroundHandle=0) {
      IntPtr device=new IntPtr(deviceHandle);
      int deviceIndex=-1, foregroundIndex=-1, first=-1, last=-1;
      bool topmost=false, mismatch=false, split=false, covered=false;
      var members=new List<IntPtr>();
      for (int i=0; i<stack.Length; i++) {
        if (stack[i].Handle == device) { deviceIndex=i; topmost=stack[i].Topmost; }
        if (stack[i].Handle.ToInt64() == foregroundHandle) foregroundIndex=i;
        if (stack[i].Group) {
          if (first < 0) first=i;
          last=i;
        }
      }
      if (deviceIndex < 0 || first < 0) return new LayerPlan { Repair=false, BottomToTop=new IntPtr[0] };
      for (int i=0; i<stack.Length; i++) {
        if (stack[i].Group) mismatch |= stack[i].Topmost != topmost;
        else if (!stack[i].Related) {
          if (i > first && i < last) split=true;
          if (i < first && stack[i].Topmost == topmost) covered=true;
        }
      }
      members.Add(device);
      for (int i=stack.Length-1; i>=0; i--)
        if (stack[i].Group && stack[i].Handle != device) members.Add(stack[i].Handle);
      IntPtr anchor=new IntPtr(topmost ? -1 : 0);
      if (!active) {
        // 非活动组以设备当前的 Z 位置为准，不能借修复图层把整组抬到别的后台窗口上面。
        for (int i=deviceIndex-1; i>=0; i--) {
          if (stack[i].Group || stack[i].Related) continue;
          if (stack[i].Topmost == topmost) anchor=stack[i].Handle;
          break;
        }
        // 激活事件可能先于系统重排；侧栏的 show 也不能把设备组留在当前前台窗口上面。
        if (foregroundIndex > first && !stack[foregroundIndex].Related && stack[foregroundIndex].Topmost == topmost) {
          split=true;
          if (foregroundIndex > deviceIndex) anchor=stack[foregroundIndex].Handle;
        }
      }
      return new LayerPlan { Repair=split || mismatch || (active && covered), Anchor=anchor, Topmost=topmost, BottomToTop=members.ToArray() };
    }

    public static bool Sync(IntPtr device, IntPtr pill, IntPtr location, bool bringToFront=false) {
      if (repairing || device == IntPtr.Zero || IsIconic(device)) return false;
      repairing=true;
      try {
        IntPtr fg=GetForegroundWindow();
        bool active=bringToFront || fg == device || fg == pill || fg == location || GetAncestor(fg, 3) == device;
        var stack=ReadStack(device, pill, location);
        var plan=Plan(stack.ToArray(), device.ToInt64(), active, fg.ToInt64());
        if (!plan.Repair) return false;
        const uint flags=0x0213; // 不移动、不改尺寸、不抢焦点、不让 owned window 改动 owner 的位置。
        foreach (var item in stack) {
          if (item.Group && item.Topmost != plan.Topmost)
            SetWindowPos(item.Handle, new IntPtr(plan.Topmost ? -1 : -2), 0, 0, 0, 0, flags);
        }
        IntPtr batch=BeginDeferWindowPos(plan.BottomToTop.Length);
        if (batch != IntPtr.Zero) {
          foreach (IntPtr h in plan.BottomToTop) {
            batch=DeferWindowPos(batch, h, plan.Anchor, 0, 0, 0, 0, flags);
            if (batch == IntPtr.Zero) break;
          }
        }
        if (batch == IntPtr.Zero || !EndDeferWindowPos(batch))
          foreach (IntPtr h in plan.BottomToTop) SetWindowPos(h, plan.Anchor, 0, 0, 0, 0, flags);
        return true;
      } finally { repairing=false; }
    }

    public static string Snapshot(IntPtr device, IntPtr pill, IntPtr location) {
      var stack=ReadStack(device, pill, location);
      IntPtr fg=GetForegroundWindow();
      bool active=fg == device || fg == pill || fg == location || GetAncestor(fg, 3) == device;
      var plan=Plan(stack.ToArray(), device.ToInt64(), active, fg.ToInt64());
      var json=new StringBuilder();
      json.Append("{\"foreground\":").Append(fg.ToInt64()).Append(",\"active\":").Append(active ? "true" : "false");
      json.Append(",\"needsRepair\":").Append(plan.Repair ? "true" : "false").Append(",\"anchor\":").Append(plan.Anchor.ToInt64()).Append(",\"stack\":[");
      for (int i=0; i<stack.Count; i++) {
        var item=stack[i];
        if (i > 0) json.Append(',');
        string role=item.Handle == device ? "device" : item.Handle == pill ? "pill" : item.Handle == location ? "location" : "external";
        json.Append("{\"z\":").Append(i).Append(",\"role\":\"").Append(role).Append("\",\"handle\":").Append(item.Handle.ToInt64());
        json.Append(",\"owner\":").Append(GetWindow(item.Handle, 4).ToInt64()).Append(",\"topmost\":").Append(item.Topmost ? "true" : "false").Append('}');
      }
      return json.Append("]}").ToString();
    }
  }
}
`;

export function buildWindowLayerAuditScript(
  avdName: string,
  serial: string,
  electronPid: number,
): string {
  if (
    !/^[\w.-]+$/.test(avdName) ||
    !/^emulator-\d{1,5}$/.test(serial) ||
    !Number.isInteger(electronPid) ||
    electronPid <= 0
  )
    throw new Error('非法窗口组');
  return String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${WINDOW_LAYER_NATIVE}
namespace DevEmuAudit {
  using System;
  using System.Text;
  using System.Runtime.InteropServices;
  public delegate bool EnumProc(IntPtr h, IntPtr data);
  public static class Find {
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr data);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder text, int size);
    public static IntPtr ByTitle(uint pid, string title) {
      IntPtr found=IntPtr.Zero;
      EnumWindows(delegate(IntPtr h, IntPtr unused) {
        uint owner; GetWindowThreadProcessId(h, out owner);
        if (owner == pid) { var text=new StringBuilder(160); GetWindowTextW(h,text,160); if(text.ToString() == title) { found=h; return false; } }
        return true;
      },IntPtr.Zero);
      return found;
    }
  }
}
'@
$qemu=Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" | Where-Object { $_.CommandLine -match '-avd ${avdName}(\s|$)' } | Select-Object -First 1
if (-not $qemu) { throw '虚拟机未运行' }
$device=(Get-Process -Id $qemu.ProcessId).MainWindowHandle
$pill=[DevEmuAudit.Find]::ByTitle(${electronPid}, 'devemu-pill ${serial}')
$location=[DevEmuAudit.Find]::ByTitle(${electronPid}, 'devemu-location ${serial}')
[DevEmuLayer.Layer]::Snapshot($device,$pill,$location)
`;
}
