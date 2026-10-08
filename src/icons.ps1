# Extracts clean app icons (no shortcut arrow) for .lnk files, the way Explorer resolves
# them: the shortcut's IconLocation ("file,index"), else its target. Paths come in as a
# JSON array in $env:APRON_ICON_PATHS; prints a JSON object { path: "data:image/png;base64,..." }.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ApronIcons {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern uint ExtractIconEx(string file, int index, IntPtr[] large, IntPtr[] small, uint count);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr h);
}
'@

function To-DataUrl([System.Drawing.Bitmap]$bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  'data:image/png;base64,' + [Convert]::ToBase64String($ms.ToArray())
}

function Icon-From([string]$file, [int]$index) {
  if (-not $file -or -not (Test-Path -LiteralPath $file)) { return $null }
  if ($file -match '\.ico$') { return (New-Object System.Drawing.Icon($file, 48, 48)).ToBitmap() }
  $large = New-Object IntPtr[] 1
  if ([ApronIcons]::ExtractIconEx($file, $index, $large, $null, 1) -gt 0 -and $large[0] -ne [IntPtr]::Zero) {
    $bmp = ([System.Drawing.Icon]::FromHandle($large[0])).ToBitmap()
    [void][ApronIcons]::DestroyIcon($large[0])
    return $bmp
  }
  return $null
}

$shell = New-Object -ComObject WScript.Shell
$out = @{}
foreach ($path in (ConvertFrom-Json $env:APRON_ICON_PATHS)) {
  try {
    $bmp = $null
    if ($path -match '\.lnk$') {
      $link = $shell.CreateShortcut($path)
      $loc = [Environment]::ExpandEnvironmentVariables([string]$link.IconLocation)
      $file = $loc; $index = 0
      if ($loc -match '^(.*),(-?\d+)$') { $file = $Matches[1]; $index = [int]$Matches[2] }
      if ($file) { $bmp = Icon-From $file $index }
      if (-not $bmp) { $bmp = Icon-From ([Environment]::ExpandEnvironmentVariables([string]$link.TargetPath)) 0 }
    }
    if (-not $bmp) { $bmp = ([System.Drawing.Icon]::ExtractAssociatedIcon($path)).ToBitmap() }
    $out[$path] = To-DataUrl $bmp
  } catch {
    # leave it out; the app shows its first letter instead
  }
}
$out | ConvertTo-Json -Compress
