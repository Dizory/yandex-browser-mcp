$ErrorActionPreference = 'Stop'
$name = 'YandexBrowserMCP-ExtensionUpdates'
$task = Get-ScheduledTask | Where-Object { $_.TaskName -eq $name -and $_.TaskPath -eq '\' }
if (!$task) { return }
$changed = $false
foreach ($trigger in $task.Triggers) {
    if ($trigger.Repetition.Interval -eq 'PT15M') {
        $trigger.Repetition.Interval = 'PT2H'
        $changed = $true
    }
}
if ($changed) {
    Set-ScheduledTask -TaskName $name -TaskPath '\' -Trigger $task.Triggers | Out-Null
    Write-Output 'Extension update checks changed from 15 minutes to 2 hours.'
}
