$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = if ($env:FOUNDRY_CONFIG) { $env:FOUNDRY_CONFIG } else { Join-Path $RepoRoot 'foundry.config.json' }

$Port = 7988
$Title = 'The Foundry'

if (Test-Path $ConfigPath) {
  $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
  if ($cfg.port) { $Port = [int]$cfg.port }
  if ($cfg.title) { $Title = [string]$cfg.title }
}
if ($env:FOUNDRY_PORT) { $Port = [int]$env:FOUNDRY_PORT }

# Stop ONLY the PID listening on 127.0.0.1:$Port (never touch tailscaled).
$listeners = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $listeners) {
  if ($conn.OwningProcess -and $conn.OwningProcess -ne 0) {
    Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}

Start-Sleep -Milliseconds 300

# Launch detached & hidden via WMI + wscript.exe (zero console window, survives shell exit).
$VbsPath = Join-Path $PSScriptRoot 'start-foundry.vbs'
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine               = "wscript.exe `"$VbsPath`""
  CurrentDirectory          = $RepoRoot
  ProcessStartupInformation = $startup
}
if ($res.ReturnValue -ne 0) {
  throw "Failed to launch $Title hidden (WMI ReturnValue=$($res.ReturnValue))"
}

Write-Output "$Title started hidden & detached on http://127.0.0.1:$Port"
