$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$gh = (Get-Command gh.exe -ErrorAction Stop).Source
& $gh auth status --hostname github.com
if ($LASTEXITCODE -ne 0) { throw 'Sign in with gh auth login before enabling updates.' }
$manifest = Join-Path $env:LOCALAPPDATA 'YandexBrowserMCP\extension\manifest.json'
if ((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).name -ne 'Yandex Browser MCP Bridge') {
    throw "Expected the installed Yandex Browser MCP extension at $manifest"
}
$homeDir = Join-Path $env:LOCALAPPDATA 'YandexBrowserMCPExtensionUpdater'
New-Item -ItemType Directory -Path $homeDir -Force | Out-Null
$updater = Join-Path $homeDir 'update-extension.mjs'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'update-extension.mjs') -Destination $updater -Force
$log = Join-Path $homeDir 'last-run.log'
function Quote-Literal([string]$s) { return "'" + $s.Replace("'", "''") + "'" }
$command = '& ' + (Quote-Literal $node) + ' ' + (Quote-Literal $updater) + ' *> ' + (Quote-Literal $log) + '; exit $LASTEXITCODE'
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded"
$who = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $who),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)))
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$name = 'YandexBrowserMCP-ExtensionUpdates'
Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $settings -User $who -RunLevel Limited -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Output "Enabled $name for $who. Last run log: $log"
