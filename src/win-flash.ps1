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
}
"@

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
  } else {
    Emit "err"
  }
}
