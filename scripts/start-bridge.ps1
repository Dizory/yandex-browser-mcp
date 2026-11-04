$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$healthUrl = 'http://127.0.0.1:37891/health'

function Get-BridgeHealth {
    try { return Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2 } catch { return $null }
}

$health = Get-BridgeHealth
if ($health -and $health.name -eq 'yandex-browser-mcp') {
    [pscustomobject]@{ running = $true; alreadyRunning = $true; connected = ($health.connected -eq $true) }
    return
}
$probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 37891)
try { $probe.Start() }
catch { throw 'Port 37891 is occupied by another or unhealthy service. Do not stop it blindly; inspect its owner.' }
finally { $probe.Stop() }

$node = Get-Command node.exe -ErrorAction Stop
$logs = Join-Path $projectRoot 'artifacts'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$bridge = Start-Process -FilePath $node.Source -ArgumentList 'server/index.js' `
    -WorkingDirectory $projectRoot -WindowStyle Hidden `
    -RedirectStandardError (Join-Path $logs 'bridge.stderr.log') `
    -RedirectStandardOutput (Join-Path $logs 'bridge.stdout.log') -PassThru

for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 200
    $health = Get-BridgeHealth
    if ($health -and $health.name -eq 'yandex-browser-mcp') {
        $bridge.Id | Set-Content -LiteralPath (Join-Path $logs 'server.pid') -Encoding ASCII
        [pscustomobject]@{ running = $true; alreadyRunning = $false; processId = $bridge.Id; connected = ($health.connected -eq $true) }
        return
    }
    if ($bridge.HasExited) { break }
}
if (-not $bridge.HasExited) { $bridge.Kill() }
throw "Bridge did not become healthy. See $logs\bridge.stderr.log"
