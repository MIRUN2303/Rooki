param(
  [string]$tool,
  [string]$argsJson = "{}"
)
$ErrorActionPreference = "Stop"
$args_ = $argsJson | ConvertFrom-Json

$Workspace = if ($env:ROOKI_WORKSPACE) { $env:ROOKI_WORKSPACE } else { "D:\web practice\rooki2" }

function Out-J($obj) {
  Write-Output ($obj | ConvertTo-Json -Compress -Depth 6)
  exit 0
}
function Fail($msg, $unsupported = $false) {
  Out-J ([ordered]@{ ok = $false; error = "$msg"; unsupported = $unsupported })
}

# ---------- native interop ----------
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Native {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
}
"@

# ---------- volume (Core Audio, pure C# helper) ----------
# ---------- volume ----------
# ponytail: exact get/set via Core Audio COM fails on this .NET 10 runtime
# (BadImageFormat from dynamic ComImport interop). Relative steps + mute via
# media keys work everywhere; exact levels are reported unsupported and the
# AI explains naturally. Upgrade path: ship a precompiled CoreAudio helper.

function Send-MediaKey($vk) {
  [Native]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
  [Native]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
}

# ---------- helpers ----------
function Test-SafePath($p) {
  try {
    $full = [IO.Path]::GetFullPath($p)
    $user = [IO.Path]::GetFullPath($env:USERPROFILE)
    $ws = [IO.Path]::GetFullPath($Workspace)
    return $full.StartsWith($user, [StringComparison]::OrdinalIgnoreCase) -or
           $full.StartsWith($ws, [StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
}
$SearchRoots = @(
  (Join-Path $env:USERPROFILE "Desktop"),
  (Join-Path $env:USERPROFILE "Documents"),
  (Join-Path $env:USERPROFILE "Downloads"),
  $Workspace
) | Where-Object { Test-Path $_ }

function Get-FileEntry($f) {
  [ordered]@{ name = $f.Name; path = $f.FullName; kind = if ($f.PSIsContainer) { "folder" } else { "file" }; size = if ($f.PSIsContainer) { $null } else { $f.Length }; modified = $f.LastWriteTime.ToString("yyyy-MM-dd HH:mm") }
}
function Find-Apps($name) {
  $match = $name -replace '\.exe$', ''
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -and $_.ProcessName -like "*$match*" }
}

switch ($tool) {
  "system.volume_get" {
    Fail "exact volume level is not readable on this system (Core Audio interop unavailable)" $true
  }
  "system.volume_set" {
    Fail "exact volume level cannot be set on this system (Core Audio interop unavailable)" $true
  }
  "system.volume_delta" {
    $steps = [Math]::Min(20, [Math]::Max(1, [Math]::Abs([int]$args_.delta)))
    $vk = if ([int]$args_.delta -gt 0) { 0xAF } else { 0xAE }
    for ($i = 0; $i -lt $steps; $i++) {
      [Native]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
      [Native]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 60
    }
    Out-J ([ordered]@{ ok = $true; data = [ordered]@{ applied = $steps; note = "relative steps; exact level cannot be read back on this system" } })
  }
  "system.volume_mute" {
    [Native]::keybd_event(0xAD, 0, 0, [UIntPtr]::Zero)
    [Native]::keybd_event(0xAD, 0, 2, [UIntPtr]::Zero)
    Out-J ([ordered]@{ ok = $true; data = [ordered]@{ action = "volume mute toggle key sent" } })
  }
  "system.brightness_get" {
    try {
      $b = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop
      Out-J ([ordered]@{ ok = $true; data = [ordered]@{ brightness = $b.CurrentBrightness } })
    } catch { Fail "brightness not exposed by this display" $true }
  }
  "system.brightness_set" {
    try {
      $pct = [Math]::Min(100, [Math]::Max(0, [int]$args_.pct))
      $m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop
      Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = 0; Brightness = $pct }
      Start-Sleep -Milliseconds 300
      $b = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness
      Out-J ([ordered]@{ ok = $true; data = [ordered]@{ brightness = $b.CurrentBrightness }; verified = ([Math]::Abs($b.CurrentBrightness - $pct) -le 5) })
    } catch { Fail "brightness not supported on this display" $true }
  }
  "system.info" {
    $os = Get-CimInstance Win32_OperatingSystem
    $cs = Get-CimInstance Win32_ComputerSystem
    $drives = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
      [ordered]@{ drive = $_.DeviceID; free = [Math]::Round($_.FreeSpace / 1GB, 1); total = [Math]::Round($_.Size / 1GB, 1) }
    }
    Out-J ([ordered]@{ ok = $true; data = [ordered]@{
      os = $os.Caption; version = $os.Version; uptimeDays = [Math]::Round(((Get-Date) - $os.LastBootUpTime).TotalDays, 1)
      cpu = $cs.Name; ramGB = [Math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
      drives = @($drives)
    } })
  }
  "storage.usage" {
    $roots = @("Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music") | ForEach-Object { Join-Path $env:USERPROFILE $_ } | Where-Object { Test-Path $_ }
    $folders = foreach ($r in $roots) {
      $size = (Get-ChildItem $r -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
      [ordered]@{ name = Split-Path $r -Leaf; path = $r; sizeGB = [Math]::Round($size / 1GB, 2) }
    }
    $d = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object -First 1
    Out-J ([ordered]@{ ok = $true; data = [ordered]@{
      drive = $d.DeviceID; freeGB = [Math]::Round($d.FreeSpace / 1GB, 1); totalGB = [Math]::Round($d.Size / 1GB, 1)
      folders = @($folders)
    } })
  }
  "app.list" {
    $apps = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } |
      Select-Object @{n = "name"; e = { $_.ProcessName } }, @{n = "title"; e = { $_.MainWindowTitle } }, @{n = "id"; e = { $_.Id } } |
      Sort-Object name | ForEach-Object { [ordered]@{ name = $_.name; title = $_.title; id = $_.id } }
    Out-J ([ordered]@{ ok = $true; data = @($apps) })
  }
  "app.open" {
    $target = "$($args_.name)".Trim()
    $running = Find-Apps $target
    if ($running) {
      $h = $running[0].MainWindowHandle
      if ($h -ne 0) { [Native]::ShowWindow($h, 9); [Native]::SetForegroundWindow($h) }
      Out-J ([ordered]@{ ok = $true; data = [ordered]@{ action = "focused"; name = $running[0].ProcessName; id = $running[0].Id }; verified = $true })
    }
    $lnkDirs = @((Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs"), (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"))
    $lnk = $null
    foreach ($d in $lnkDirs) {
      if (Test-Path $d) {
        $cand = Get-ChildItem $d -Recurse -Filter *.lnk -ErrorAction SilentlyContinue |
          Where-Object { $_.BaseName -like "*$target*" } | Select-Object -First 1
        if ($cand) { $lnk = $cand.FullName; break }
      }
    }
    if ($lnk) {
      Start-Process $lnk
      Start-Sleep -Seconds 2
      $proc = Find-Apps $target
      Out-J ([ordered]@{ ok = $true; data = [ordered]@{ action = "launched"; app = $target; running = [bool]$proc }; verified = [bool]$proc })
    }
    try {
      Start-Process -FilePath $target -ErrorAction Stop
      Start-Sleep -Seconds 2
      $proc = Find-Apps $target
      Out-J ([ordered]@{ ok = $true; data = [ordered]@{ action = "launched"; app = $target; running = [bool]$proc }; verified = [bool]$proc })
    } catch { Fail "no app named '$target' found on this system" $false }
  }
  "app.close" {
    $target = "$($args_.name)".Trim()
    $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like "*$target*" -or $_.MainWindowTitle -like "*$target*" }
    if (-not $procs) { Fail "no app named '$target' is running" $false }
    foreach ($p in $procs) {
      if ($p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow() } else { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Seconds 2
    $still = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like "*$target*" -and $_.MainWindowTitle }
    if ($still) { foreach ($p in $still) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }
    Out-J ([ordered]@{ ok = $true; data = [ordered]@{ action = "closed"; app = $target; remaining = @($still).Count }; verified = (@($still).Count -eq 0) })
  }
  "app.focus" {
    $target = "$($args_.name)".Trim()
    $running = Find-Apps $target
    if (-not $running) { Fail "no running window matches '$target'" $false }
    $h = $running[0].MainWindowHandle
    if ($h -eq 0) { Fail "'$target' has no focusable window" $false }
    [Native]::ShowWindow($h, 9)
    [Native]::SetForegroundWindow($h)
    Out-J ([ordered]@{ ok = $true; data = [ordered]@{ action = "focused"; name = $running[0].ProcessName; id = $running[0].Id }; verified = $true })
  }
  "files.desktop" {
    $p = Join-Path $env:USERPROFILE "Desktop"
    $items = Get-ChildItem $p -ErrorAction SilentlyContinue | Sort-Object { -not $_.PSIsContainer }, Name | ForEach-Object { Get-FileEntry $_ }
    Out-J ([ordered]@{ ok = $true; data = [ordered]@{ path = $p; items = @($items) } })
  }
  "files.list" {
    $p = "$($args_.path)"
    if (-not (Test-SafePath $p)) { Fail "path outside allowed areas" $false }
    if (-not (Test-Path $p)) { Fail "path not found: $p" $false }
    $items = Get-ChildItem $p -ErrorAction SilentlyContinue | Sort-Object { -not $_.PSIsContainer }, Name | ForEach-Object { Get-FileEntry $_ }
    Out-J ([ordered]@{ ok = $true; data = [ordered]@{ path = $p; items = @($items) } })
  }
  "files.search" {
    $q = "$($args_.query)".Trim()
    $hits = foreach ($r in $SearchRoots) {
      Get-ChildItem $r -Recurse -ErrorAction SilentlyContinue -Force |
        Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|\.venv|venv|AppData)\\' -and $_.Name -like "*$q*" } |
        Select-Object -First 40
    }
    $items = $hits | Sort-Object LastWriteTime -Descending | Select-Object -First 12 | ForEach-Object { Get-FileEntry $_ }
    Out-J ([ordered]@{ ok = $true; data = [ordered]@{ query = $q; hits = @($items) } })
  }
  "files.recent" {
    $days = [Math]::Min(30, [Math]::Max(0, [int]$args_.days))
    $since = (Get-Date).AddDays(-$days)
    $hits = foreach ($r in $SearchRoots) {
      Get-ChildItem $r -Recurse -File -ErrorAction SilentlyContinue -Force |
        Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|\.venv|venv|AppData)\\' -and $_.LastWriteTime -gt $since } |
        Select-Object -First 60
    }
    $items = $hits | Sort-Object LastWriteTime -Descending | Select-Object -First 15 | ForEach-Object { Get-FileEntry $_ }
    Out-J ([ordered]@{ ok = $true; data = [ordered]@{ days = $days; files = @($items) } })
  }
  "files.read" {
    $p = "$($args_.path)"
    if (-not (Test-SafePath $p)) { Fail "path outside allowed areas" $false }
    if (-not (Test-Path $p)) { Fail "path not found: $p" $false }
    $ext = [IO.Path]::GetExtension($p).ToLower()
    if ($ext -notin @(".txt", ".md", ".json", ".csv", ".log", ".ps1", ".ts", ".tsx", ".js", ".mjs", ".py", ".html", ".css", ".xml", ".yaml", ".yml", ".ini", ".cfg")) { Fail "cannot read $ext files" $true }
    $text = Get-Content $p -Raw -ErrorAction SilentlyContinue
    if (-not $text) { Fail "could not read file (binary or locked)" $false }
    $text = $text.Substring(0, [Math]::Min(4000, $text.Length))
    Out-J ([ordered]@{ ok = $true; data = [ordered]@{ path = $p; content = $text; truncated = ((Get-Item $p).Length -gt 4000) } })
  }
  "files.open" {
    $p = "$($args_.path)"
    if (-not (Test-SafePath $p)) { Fail "path outside allowed areas" $false }
    if (-not (Test-Path $p)) { Fail "path not found: $p" $false }
    Start-Process $p
    Out-J ([ordered]@{ ok = $true; data = [ordered]@{ action = "opened"; path = $p } })
  }
  "media.play_pause" {
    [Native]::keybd_event(0xB3, 0, 0, [UIntPtr]::Zero)
    [Native]::keybd_event(0xB3, 0, 2, [UIntPtr]::Zero)
    Out-J ([ordered]@{ ok = $true; data = [ordered]@{ action = "media play/pause key sent"; note = "playback state cannot be verified from a browser" } })
  }
  "media.next" {
    [Native]::keybd_event(0xB0, 0, 0, [UIntPtr]::Zero)
    [Native]::keybd_event(0xB0, 0, 2, [UIntPtr]::Zero)
    Out-J ([ordered]@{ ok = $true; data = [ordered]@{ action = "next track key sent" } })
  }
  "media.previous" {
    [Native]::keybd_event(0xB1, 0, 0, [UIntPtr]::Zero)
    [Native]::keybd_event(0xB1, 0, 2, [UIntPtr]::Zero)
    Out-J ([ordered]@{ ok = $true; data = [ordered]@{ action = "previous track key sent" } })
  }
  "browser.open" {
    $url = "$($args_.url)".Trim()
    if ($url -notmatch '^https?://') { Fail "bad url" $false }
    $brave = @(
      "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
      "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($brave) {
      Start-Process $brave $url
      Out-J ([ordered]@{ ok = $true; data = [ordered]@{ action = "opened"; browser = "brave"; url = $url } })
    } else {
      Start-Process $url
      Out-J ([ordered]@{ ok = $true; data = [ordered]@{ action = "opened"; browser = "default"; url = $url } })
    }
  }
  default { Fail "unknown tool: $tool" $false }
}
