$ErrorActionPreference = 'Stop'
$node = & (Get-Command node.exe -ErrorAction Stop).Source -p "require('node:fs').realpathSync(process.execPath)"
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Could not resolve the installed Node.js executable.' }
$gh = (Get-Command gh.exe -ErrorAction Stop).Source
& $gh auth status --hostname github.com
if ($LASTEXITCODE -ne 0) { throw 'Sign in with gh auth login before enabling updates.' }
$manifest = Join-Path $env:LOCALAPPDATA 'YandexBrowserMCP\extension\manifest.json'
if ((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).name -ne 'Yandex Browser MCP Bridge') {
    throw "Expected the installed Yandex Browser MCP extension at $manifest"
}
# MSIX shells virtualize new LocalAppData folders; Task Scheduler runs outside that view.
$homeDir = Join-Path $env:USERPROFILE '.yandex-browser-mcp-updater'
New-Item -ItemType Directory -Path $homeDir -Force | Out-Null
$updater = Join-Path $homeDir 'update-extension.mjs'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'update-extension.mjs') -Destination $updater -Force
$log = Join-Path $homeDir 'last-run.log'
function Quote-Literal([string]$s) { return "'" + $s.Replace("'", "''") + "'" }
$runner = Join-Path $homeDir 'run.ps1'
$command = @(
    '$ErrorActionPreference = "Stop"'
    ('$env:Path = ' + (Quote-Literal ((Split-Path -Parent $gh) + ';')) + ' + $env:Path')
    ('try { & ' + (Quote-Literal $node) + ' ' + (Quote-Literal $updater) + ' *> ' + (Quote-Literal $log) + '; exit $LASTEXITCODE }')
    ('catch { $_ | Out-File -LiteralPath ' + (Quote-Literal $log) + ' -Append; exit 1 }')
)
[IO.File]::WriteAllLines($runner, [string[]]$command, [Text.UTF8Encoding]::new($true))
$action = New-ScheduledTaskAction -Execute (Get-Command powershell.exe).Source -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runner + '"')
$who = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $who),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)))
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$name = 'YandexBrowserMCP-ExtensionUpdates'
Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $settings -User $who -RunLevel Limited -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Output "Enabled $name for $who. Last run log: $log"
