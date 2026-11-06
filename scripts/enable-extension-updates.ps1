param([string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'YandexBrowserMCP'))
$ErrorActionPreference = 'Stop'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
if (Test-Path -LiteralPath (Join-Path $InstallRoot '.git')) { throw 'Choose an installation folder outside the Git checkout.' }
$node = & (Get-Command node.exe -ErrorAction Stop).Source -p "require('node:fs').realpathSync(process.execPath)"
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Could not resolve the installed Node.js executable.' }
# MSIX shells virtualize new LocalAppData folders; Task Scheduler runs outside that view.
$homeDir = Join-Path $env:USERPROFILE '.yandex-browser-mcp-updater'
New-Item -ItemType Directory -Path $homeDir -Force | Out-Null
# A private, pinned verifier works with a local signature bundle and an empty GitHub configuration.
$version = '2.103.3'
$cpu = & $node -p 'process.arch'
$architectures = @{ x64 = 'amd64'; arm64 = 'arm64'; ia32 = '386' }
$arch = $architectures[$cpu]
if (!$arch) { throw "Unsupported CPU architecture: $cpu" }
$digests = @{
    amd64 = '98d0cfa794721665d7973dd728c78aff7bd836d58f10f6d7a03568eccb0a22e0'
    arm64 = '197211c98687d7770ac331fe8a3b6c198c389108c1536cdbedf659fe4703e484'
    '386' = 'e18001aaa03da36635626b3557947a886704d67f532292577c5945ad0535f6eb'
}
$gh = Join-Path $homeDir "gh-$version-$arch.exe"
if (!(Test-Path -LiteralPath $gh -PathType Leaf)) {
    $archive = [IO.Path]::GetTempFileName()
    $staged = "$gh.$([guid]::NewGuid()).tmp"
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/cli/cli/releases/download/v$version/gh_${version}_windows_${arch}.zip" -OutFile $archive
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $digests[$arch]) { throw 'Verifier download checksum mismatch' }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [IO.Compression.ZipFile]::OpenRead($archive)
        try {
            $entry = @($zip.Entries | Where-Object Name -eq 'gh.exe')
            if ($entry.Count -ne 1) { throw 'Unexpected verifier archive' }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry[0], $staged)
        } finally { $zip.Dispose() }
        Move-Item -LiteralPath $staged -Destination $gh
    } finally {
        [IO.File]::Delete($archive)
        [IO.File]::Delete($staged)
    }
}
$updater = Join-Path $homeDir 'update-extension.mjs'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'update-extension.mjs') -Destination $updater -Force
$log = Join-Path $homeDir 'last-run.log'
function Quote-Literal([string]$s) { return "'" + $s.Replace("'", "''") + "'" }
$runner = Join-Path $homeDir 'run.ps1'
$command = @(
    '$ErrorActionPreference = "Stop"'
    ('$env:YMCP_VERIFIER = ' + (Quote-Literal $gh))
    ('try { & ' + (Quote-Literal $node) + ' ' + (Quote-Literal $updater) + ' ' + (Quote-Literal $InstallRoot) + ' *> ' + (Quote-Literal $log) + '; exit $LASTEXITCODE }')
    ('catch { $_ | Out-File -LiteralPath ' + (Quote-Literal $log) + ' -Append; exit 1 }')
)
[IO.File]::WriteAllLines($runner, [string[]]$command, [Text.UTF8Encoding]::new($true))
$env:YMCP_VERIFIER = $gh
& $node $updater $InstallRoot
if ($LASTEXITCODE -ne 0) { throw 'Initial extension update failed; fix the reported error and run setup again.' }
$action = New-ScheduledTaskAction -Execute (Get-Command powershell.exe).Source -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runner + '"')
$who = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $who),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)))
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$name = 'YandexBrowserMCP-ExtensionUpdates'
Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $settings -User $who -RunLevel Limited -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Output "Load this unpacked extension in Yandex Browser: $(Join-Path $InstallRoot 'extension')"
Write-Output "Enabled $name for $who. Last run log: $log"
