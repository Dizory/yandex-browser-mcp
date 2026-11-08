import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('schedule migration preserves other triggers, skips custom intervals and reports failures',
  { skip: process.platform !== 'win32' }, () => {
    const script = fileURLToPath(new URL('../server/update-extension-schedule.ps1', import.meta.url)).replaceAll("'", "''");
    const command = `
$ErrorActionPreference = 'Stop'
$script:writes = 0
$script:fail = $false
function Get-ScheduledTask { return $script:tasks }
function Set-ScheduledTask($TaskName, $TaskPath, $Trigger) {
    if ($TaskName -ne 'YandexBrowserMCP-ExtensionUpdates' -or $TaskPath -ne '\\') { throw 'Wrong task' }
    if ($script:fail) { throw 'Access denied fixture' }
    $script:writes++
    if (![object]::ReferenceEquals($Trigger, $script:target.Triggers)) { throw 'Triggers replaced' }
}
$script:tasks = @()
. '${script}'
if ($script:writes -ne 0) { throw 'Created absent task' }
$logon = [pscustomobject]@{ Repetition = [pscustomobject]@{ Interval = $null }; UserId = 'original-user' }
$periodic = [pscustomobject]@{ Repetition = [pscustomobject]@{ Interval = 'PT15M' }; StartBoundary = '2026-11-06T10:00:00' }
$script:target = [pscustomobject]@{ TaskName = 'YandexBrowserMCP-ExtensionUpdates'; TaskPath = '\\'; Triggers = @($logon, $periodic) }
$other = [pscustomobject]@{ TaskName = 'YandexBrowserMCP-ServerUpdates'; TaskPath = '\\'; Triggers = @([pscustomobject]@{ Repetition = [pscustomobject]@{ Interval = 'PT15M' } }) }
$script:tasks = @($other, $script:target)
. '${script}'
if ($script:writes -ne 1 -or $periodic.Repetition.Interval -ne 'PT2H') { throw 'Migration failed' }
if ($logon.Repetition.Interval -or $logon.UserId -ne 'original-user' -or $periodic.StartBoundary -ne '2026-11-06T10:00:00') { throw 'Changed other trigger settings' }
if ($other.Triggers[0].Repetition.Interval -ne 'PT15M') { throw 'Changed server task' }
. '${script}'
$periodic.Repetition.Interval = 'PT6H'
. '${script}'
if ($script:writes -ne 1 -or $periodic.Repetition.Interval -ne 'PT6H') { throw 'Not idempotent or custom interval changed' }
$periodic.Repetition.Interval = 'PT15M'
$script:fail = $true
$caught = $false
try { . '${script}' } catch { if ($_.Exception.Message -ne 'Access denied fixture') { throw }; $caught = $true }
if (!$caught) { throw 'Swallowed task update failure' }
Write-Output 'schedule checks passed'
`;
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.match(output, /schedule checks passed/);
  });
