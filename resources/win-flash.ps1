Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class OAFlash {
  [StructLayout(LayoutKind.Sequential)]
  public struct FLASHWINFO {
    public uint cbSize;
    public IntPtr hwnd;
    public uint dwFlags;
    public uint uCount;
    public uint dwTimeout;
  }
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO info);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr LoadImage(IntPtr hinst, string name, uint type, int cx, int cy, uint load);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", EntryPoint = "SetClassLongPtrW", SetLastError = true)]
  public static extern IntPtr SetClassLongPtr(IntPtr hwnd, int index, IntPtr value);
}
"@

[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

$script:IconPath = ""
$script:IconBig = [IntPtr]::Zero
$script:IconSmall = [IntPtr]::Zero

function Emit([string]$text) {
  [Console]::Out.WriteLine($text)
  [Console]::Out.Flush()
}

function FlashHwnd([Int64]$value, [uint32]$flags) {
  $info = New-Object OAFlash+FLASHWINFO
  $info.cbSize = [uint32][Runtime.InteropServices.Marshal]::SizeOf($info)
  $info.hwnd = [IntPtr]::new($value)
  $info.dwFlags = $flags
  $info.uCount = 0
  $info.dwTimeout = 0
  if (-not [OAFlash]::IsWindow($info.hwnd)) {
    Emit "fail invalid-window"
    return
  }
  # FlashWindowEx returns the previous active state, not success or failure.
  [void][OAFlash]::FlashWindowEx([ref]$info)
  Emit ("ok " + $info.cbSize)
}

function SetWindowIcon([Int64]$value, [string]$iconPath) {
  $hwnd = [IntPtr]::new($value)
  if (-not [OAFlash]::IsWindow($hwnd)) {
    Emit "fail invalid-window"
    return
  }
  $big = [IntPtr]::Zero
  $small = [IntPtr]::Zero
  if ($iconPath -and $iconPath -ne "0") {
    if ($script:IconPath -ne $iconPath -or $script:IconBig -eq [IntPtr]::Zero) {
      $loadedBig = [OAFlash]::LoadImage([IntPtr]::Zero, $iconPath, 1, 32, 32, 0x10)
      $loadedSmall = [OAFlash]::LoadImage([IntPtr]::Zero, $iconPath, 1, 16, 16, 0x10)
      if ($loadedBig -eq [IntPtr]::Zero -and $loadedSmall -eq [IntPtr]::Zero) {
        Emit "fail icon"
        return
      }
      $script:IconPath = $iconPath
      $script:IconBig = $loadedBig
      $script:IconSmall = $loadedSmall
    }
    $big = $script:IconBig
    $small = $script:IconSmall
  }
  [void][OAFlash]::SendMessage($hwnd, 0x80, [IntPtr]::Zero, $small)
  [void][OAFlash]::SendMessage($hwnd, 0x80, [IntPtr]1, $big)
  [void][OAFlash]::SetClassLongPtr($hwnd, -14, $big)
  [void][OAFlash]::SetClassLongPtr($hwnd, -34, $small)
  Emit $(if ($iconPath -eq "0") { "ok blank" } else { "ok icon" })
}

Emit "ready"
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq "FG") {
    Emit ([OAFlash]::GetForegroundWindow().ToInt64().ToString())
  } elseif ($line.StartsWith("FLASH ")) {
    FlashHwnd ([Int64]$line.Substring(6)) 14
  } elseif ($line.StartsWith("STOP ")) {
    FlashHwnd ([Int64]$line.Substring(5)) 0
  } elseif ($line.StartsWith("ICON ")) {
    $rest = $line.Substring(5).Trim()
    $split = $rest.IndexOf(" ")
    if ($split -lt 1) {
      Emit "err"
    } else {
      SetWindowIcon ([Int64]$rest.Substring(0, $split)) $rest.Substring($split + 1).Trim()
    }
  } else {
    Emit "err"
  }
}
