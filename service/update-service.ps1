# MailApp update service (runs as LocalSystem under WinSW, via powershell.exe).
#
# Independent of the app: powershell.exe lives in System32 and this script lives
# in C:\ProgramData\MailApp\service, so an app update never locks the service —
# it keeps running and orchestrates the whole update without restarting itself.
#
# Responsibilities:
#  - Heartbeat to the management server as source="service" (so the server can
#    reach the machine even when the app is closed). Token + server URL are read
#    from the shared settings.json the app writes on pairing.
#  - On an "update" command: compare the installed app version with GitHub's
#    latest; if newer, download + silent-install (app only) and relaunch the app
#    in the logged-on user's session; otherwise report "up_to_date".

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo       = 'bolgov0zero/MailApp'
$DataDir    = 'C:\ProgramData\MailApp'
$SettingsFp = Join-Path $DataDir 'settings.json'
$LogFp      = Join-Path $DataDir 'service.log'
$SvcDir     = $PSScriptRoot
$AppPathFp  = Join-Path $SvcDir 'app.txt'   # written by the installer: full path to MailApp.exe
$HeartbeatSec = 10

function Log($msg) {
  try {
    if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
    Add-Content -Path $LogFp -Value ("{0} {1}" -f (Get-Date).ToString('o'), $msg)
  } catch {}
}

function Get-AppExe {
  try { if (Test-Path $AppPathFp) { return (Get-Content $AppPathFp -Raw).Trim() } } catch {}
  return 'C:\Program Files\MailApp\MailApp.exe'
}

function Get-AppVersion($exe) {
  # Determined from the exe itself (ProductVersion), trimmed to 3 components.
  try {
    if (Test-Path $exe) {
      $v = (Get-Item $exe).VersionInfo.ProductVersion.Trim()
      $p = $v -split '\.'
      if ($p.Count -ge 3) { return ($p[0..2] -join '.') }
      return $v
    }
  } catch {}
  return ''
}

function Get-LocalIp {
  try {
    $a = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' } |
      Select-Object -First 1
    if ($a) { return $a.IPAddress }
  } catch {}
  try {
    return ([System.Net.Dns]::GetHostAddresses($env:COMPUTERNAME) |
      Where-Object { $_.AddressFamily -eq 'InterNetwork' } | Select-Object -First 1).IPAddressToString
  } catch {}
  return ''
}

function Read-Server {
  try {
    if (-not (Test-Path $SettingsFp)) { return $null }
    $s = Get-Content $SettingsFp -Raw | ConvertFrom-Json
    if ($s.server -and $s.server.url -and $s.server.deviceToken) {
      return @{ url = $s.server.url.TrimEnd('/'); token = $s.server.deviceToken; profile = $s.authLogin }
    }
  } catch {}
  return $null
}

function Send-Heartbeat($srv, $version, [string]$report) {
  $body = @{
    action       = 'heartbeat'
    device_token = $srv.token
    source       = 'service'
    hostname     = $env:COMPUTERNAME
    local_ip     = (Get-LocalIp)
    version      = $version
    profile      = $srv.profile
  }
  if ($report) { $body.report = $report }
  return Invoke-RestMethod -Uri ($srv.url + '/api.php') -Method Post -TimeoutSec 15 `
    -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress)
}

function Compare-Version($a, $b) {
  # returns 1 if a>b, -1 if a<b, 0 if equal
  try {
    $pa = ($a -split '\.'); $pb = ($b -split '\.')
    for ($i = 0; $i -lt [Math]::Max($pa.Count, $pb.Count); $i++) {
      $x = if ($i -lt $pa.Count) { [int]$pa[$i] } else { 0 }
      $y = if ($i -lt $pb.Count) { [int]$pb[$i] } else { 0 }
      if ($x -ne $y) { return [Math]::Sign($x - $y) }
    }
  } catch {}
  return 0
}

function Invoke-Update($srv, $currentVer) {
  Log "update command received (current $currentVer)"
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" `
    -Headers @{ 'User-Agent' = 'MailApp-Service'; 'Accept' = 'application/vnd.github+json' } -TimeoutSec 20
  $latest = ($rel.tag_name -replace '^v', '')
  if (-not $latest -or (Compare-Version $latest $currentVer) -le 0) {
    Log "already up to date (latest $latest)"
    try { Send-Heartbeat $srv $currentVer 'up_to_date' | Out-Null } catch {}
    return
  }
  $asset = $rel.assets | Where-Object { $_.name -match '\.exe$' -and $_.name -notmatch 'blockmap' } | Select-Object -First 1
  if (-not $asset) { Log 'no .exe asset'; return }

  # Remember whether the GUI was running — only relaunch it afterwards if so.
  $wasRunning = [bool](Get-Process -Name 'MailApp' -ErrorAction SilentlyContinue)
  Log "app running before update: $wasRunning"

  $installer = Join-Path $env:TEMP $asset.name
  try { Send-Heartbeat $srv $currentVer 'downloading' | Out-Null } catch {}
  Log "downloading $($asset.browser_download_url)"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer -UseBasicParsing -TimeoutSec 600
  Log "downloaded to $installer"

  # Silent install. The installer's NSIS skips the service on /S, so this
  # running service is NOT touched/locked — no self-stop, no restart needed.
  try { Send-Heartbeat $srv $currentVer 'installing' | Out-Null } catch {}
  Log 'running silent installer'
  $p = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  Log "installer exit code: $($p.ExitCode)"

  if ($wasRunning) {
    # Relaunch only if the app was running before the update (otherwise leave it
    # closed). A silent SYSTEM install does not start the GUI and the service is
    # in session 0, so we relaunch via an interactive (/it) one-off task.
    try { Send-Heartbeat $srv $currentVer 'launching' | Out-Null } catch {}
    Relaunch-App
  } else {
    Log 'app was not running; not relaunching'
  }

  # Final status: the app is now up to date.
  try {
    $newVer = Get-AppVersion (Get-AppExe)
    Send-Heartbeat $srv $newVer 'up_to_date' | Out-Null
    Log "update complete, now $newVer"
  } catch {}
}

function Relaunch-App {
  try {
    $exe = Get-AppExe
    $user = $null
    try { $user = (Get-CimInstance Win32_ComputerSystem).UserName } catch {}
    if (-not $user) {
      try { $user = (Get-Process explorer -IncludeUserName -ErrorAction Stop | Select-Object -First 1).UserName } catch {}
    }
    if (-not $user) { Log 'relaunch: no interactive user found'; return }
    Log "relaunch: user=$user exe=$exe"
    schtasks /delete /tn 'MailAppLaunch' /f 2>&1 | Out-Null
    $c = schtasks /create /tn 'MailAppLaunch' /tr "`"$exe`"" /sc ONCE /st 00:00 /ru "$user" /it /rl LIMITED /f 2>&1
    Log "relaunch create: $c"
    $r = schtasks /run /tn 'MailAppLaunch' 2>&1
    Log "relaunch run: $r"
  } catch { Log "relaunch error: $($_.Exception.Message)" }
}

# ── main loop ──────────────────────────────────────────────────────
Log 'service started'
while ($true) {
  try {
    $srv = Read-Server
    if ($srv) {
      $exe = Get-AppExe
      $ver = Get-AppVersion $exe
      $resp = Send-Heartbeat $srv $ver $null
      if ($resp -and $resp.command -eq 'update') {
        Invoke-Update $srv $ver
      }
    }
  } catch {
    Log "loop error: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $HeartbeatSec
}
