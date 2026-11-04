$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$outputDir = Join-Path $projectRoot 'artifacts'
$archive = Join-Path $outputDir 'yandex-browser-mcp-windows.zip'
$files = @(
    'extension', 'server', 'scripts', 'test',
    'package.json', 'package-lock.json', 'README.md', 'INSTALL_AGENT.md',
    'AGENT_PROMPT.txt', 'PROTOCOL.md', 'LICENSE', 'start.cmd', 'install.ps1'
)
foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $file))) { throw "Missing package file: $file" }
}
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
Compress-Archive -LiteralPath @($files | ForEach-Object { Join-Path $projectRoot $_ }) -DestinationPath $archive -Force
$sha = [Security.Cryptography.SHA256]::Create()
try { $hash = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($archive))).Replace('-', '').ToLowerInvariant() }
finally { $sha.Dispose() }
[IO.File]::WriteAllText((Join-Path $outputDir 'SHA256SUMS.txt'), "$hash  yandex-browser-mcp-windows.zip`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Output $archive
