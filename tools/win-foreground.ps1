# Read the OS foreground window through Win32 (test helper only, never shipped in the product).
# ASCII only on purpose: PowerShell 5.1 reads -File as ANSI, so non-ASCII comments would break it.
# Output: one compact JSON line. The window title is base64(UTF8) so the console code page cannot mangle it.
#
# Usage:  pwsh -NoProfile -File tools/win-foreground.ps1
#         -> {"hwnd":123456,"fg_pid":4321,"title_b64":"...","title":"...","iconic":false,"ok":true}
param(
  [switch]$ListWindows
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class FpWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  public static List<IntPtr> TopLevel() {
    var list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) { if (IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Title(IntPtr h) {
    var sb = new StringBuilder(512);
    GetWindowTextW(h, sb, 512);
    return sb.ToString();
  }
  public static int PidOf(IntPtr h) {
    int p = 0;
    GetWindowThreadProcessId(h, out p);
    return p;
  }
}
"@

function B64([string]$s) {
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))
}

if ($ListWindows) {
  # z-order list, topmost first: GetWindow(GW_HWNDNEXT = 2) walks down the z-order of top-level windows.
  $rows = @()
  $h = [FpWin]::GetForegroundWindow()
  $i = 0
  while ($h -ne [IntPtr]::Zero -and $i -lt 40) {
    $t = [FpWin]::Title($h)
    if ($t -ne '') {
      $rows += [ordered]@{
        z      = $i
        hwnd   = $h.ToInt64()
        pid    = [FpWin]::PidOf($h)
        iconic = [FpWin]::IsIconic($h)
        title  = $t
      }
      $i++
    }
    $h = [FpWin]::GetWindow($h, 2)
  }
  (@{ ok = $true; windows = $rows } | ConvertTo-Json -Compress -Depth 5)
  exit 0
}

$fg = [FpWin]::GetForegroundWindow()
$title = ''
if ($fg -ne [IntPtr]::Zero) { $title = [FpWin]::Title($fg) }
$out = [ordered]@{
  ok        = $true
  hwnd      = $fg.ToInt64()
  fg_pid    = $(if ($fg -eq [IntPtr]::Zero) { 0 } else { [FpWin]::PidOf($fg) })
  iconic    = $(if ($fg -eq [IntPtr]::Zero) { $false } else { [FpWin]::IsIconic($fg) })
  title     = $title
  title_b64 = (B64 $title)
}
($out | ConvertTo-Json -Compress)
