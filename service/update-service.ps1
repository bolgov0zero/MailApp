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
# CRITICAL: with the progress bar on, Invoke-WebRequest is 10-50x slower and a
# ~90 MB installer can exceed the timeout (was causing 'Загрузка' to hang).
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Bump this when you change update-service.ps1. Shown in the admin and used to
# see which machines already picked up the new script.
$ScriptVersion = 1

$Repo       = 'bolgov0zero/MailApp'
$DataDir    = 'C:\ProgramData\MailApp'
$SettingsFp = Join-Path $DataDir 'settings.json'
$LogFp      = Join-Path $DataDir 'service.log'
$SvcDir     = $PSScriptRoot
$AppPathFp  = Join-Path $SvcDir 'app.txt'   # written by the installer: full path to MailApp.exe
$HeartbeatSec = 5
$SelfCheckSec = 600                         # re-check own script for changes every 10 min

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
    action         = 'heartbeat'
    device_token   = $srv.token
    source         = 'service'
    hostname       = $env:COMPUTERNAME
    local_ip       = (Get-LocalIp)
    version        = $version
    profile        = $srv.profile
    script_version = $ScriptVersion
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

function Invoke-Update($srv, $currentVer, $info) {
  # $info comes from the heartbeat command response: { version, url, sha256 }.
  # The installer is hosted on the management server itself (HTTPS).
  $latest = "$($info.version)"
  Log "update command received (current $currentVer, server $latest)"
  if (-not $info.url) { Log 'no update url from server'; return }
  if (-not $latest -or (Compare-Version $latest $currentVer) -le 0) {
    Log "already up to date (server $latest)"
    try { Send-Heartbeat $srv $currentVer 'up_to_date' | Out-Null } catch {}
    return
  }

  # Remember whether the GUI was running — only relaunch it afterwards if so.
  $wasRunning = [bool](Get-Process -Name 'MailApp' -ErrorAction SilentlyContinue)
  Log "app running before update: $wasRunning"

  $installer = Join-Path $env:TEMP "MailApp-Setup-$latest.exe"
  try { Send-Heartbeat $srv $currentVer 'downloading' | Out-Null } catch {}
  Log "downloading $($info.url)"
  $downloaded = $false
  for ($i = 1; $i -le 3 -and -not $downloaded; $i++) {
    try {
      Invoke-WebRequest -Uri $info.url -OutFile $installer -UseBasicParsing -TimeoutSec 1800
      $downloaded = $true
    } catch {
      Log "download attempt $i failed: $($_.Exception.Message)"
      Start-Sleep -Seconds 5
    }
  }
  if (-not $downloaded) {
    Log 'download failed after retries'
    try { Send-Heartbeat $srv $currentVer 'error' | Out-Null } catch {}
    return
  }
  Log "downloaded to $installer"

  # Verify integrity against the sha256 reported by the server.
  if ($info.sha256) {
    $h = (Get-FileHash -Algorithm SHA256 -Path $installer).Hash
    if ($h -ne ("$($info.sha256)").ToUpper()) {
      Log "sha256 mismatch (got $h, expected $($info.sha256))"
      try { Send-Heartbeat $srv $currentVer 'error' | Out-Null } catch {}
      return
    }
    Log 'sha256 ok'
  }

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
  # Native commands writing to stderr must NOT become terminating errors here
  # (e.g. schtasks emits ERROR text that, under 'Stop', aborts the relaunch).
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $exe = Get-AppExe
    $user = $null
    try { $user = (Get-CimInstance Win32_ComputerSystem).UserName } catch {}
    if (-not $user) {
      try { $user = (Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue | Select-Object -First 1).UserName } catch {}
    }
    if (-not $user) { Log 'relaunch: no interactive user found'; return }
    Log "relaunch: user=$user exe=$exe"
    # Register via explicit XML with LogonType=InteractiveToken — the reliable
    # way to launch a GUI in the logged-on user's session from a SYSTEM service
    # (no password needed; runs in the interactive desktop).
    $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>MailApp relaunch after update</Description></RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>$user</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>$exe</Command></Exec>
  </Actions>
</Task>
"@
    $xmlPath = Join-Path $env:TEMP 'mailapp-launch.xml'
    [System.IO.File]::WriteAllText($xmlPath, $xml, [System.Text.Encoding]::Unicode)
    $c = & schtasks /create /tn 'MailAppLaunch' /xml "$xmlPath" /f 2>&1
    Log "relaunch create (exit $LASTEXITCODE): $c"
    $r = & schtasks /run /tn 'MailAppLaunch' 2>&1
    Log "relaunch run (exit $LASTEXITCODE): $r"
    Start-Sleep -Seconds 2
    $q = (& schtasks /query /tn 'MailAppLaunch' /v /fo LIST 2>&1 | Select-String -Pattern 'Result|Результат') -join ' | '
    Log "relaunch lastresult: $q"
  } catch {
    Log "relaunch error: $($_.Exception.Message)"
  } finally {
    $ErrorActionPreference = $prev
  }
}

# ── main loop ──────────────────────────────────────────────────────
Log "service started (script v$ScriptVersion)"
$selfHash = try { (Get-FileHash -Algorithm SHA256 -Path $PSCommandPath).Hash } catch { '' }
$lastSelfCheck = Get-Date
while ($true) {
  try {
    $srv = Read-Server
    if ($srv) {
      $exe = Get-AppExe
      $ver = Get-AppVersion $exe
      $resp = Send-Heartbeat $srv $ver $null
      if ($resp -and $resp.command -eq 'update') {
        Invoke-Update $srv $ver $resp
      }
    }
    # Self-update: if this script file changed on disk, restart to apply it
    # (WinSW onfailure=restart relaunches powershell with the new script).
    if (((Get-Date) - $lastSelfCheck).TotalSeconds -ge $SelfCheckSec) {
      $lastSelfCheck = Get-Date
      $h = try { (Get-FileHash -Algorithm SHA256 -Path $PSCommandPath).Hash } catch { '' }
      if ($selfHash -and $h -and $h -ne $selfHash) {
        Log 'script changed on disk — restarting to apply'
        exit 1
      }
    }
  } catch {
    Log "loop error: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $HeartbeatSec
}
