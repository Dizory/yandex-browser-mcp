param([switch]$RegisterCodex, [switch]$EnableExtensionUpdates)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This installer is for Windows. See README.md for manual setup.' }
$projectRoot = $PSScriptRoot
foreach ($file in @('package-lock.json', 'extension/manifest.json', 'server/index.js', 'scripts/start-bridge.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $file))) { throw "Incomplete package: $file is missing." }
}
$node = Get-Command node.exe -ErrorAction SilentlyContinue
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
    throw 'Node.js 22+ with npm is required. Install the LTS release from https://nodejs.org/ then reopen the terminal and rerun install.ps1.'
}
$nodeVersion = & $node.Source -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'22.0.0') { throw 'Node.js 22+ is required.' }

if ($RegisterCodex) {
    $codex = Get-Command codex -ErrorAction Stop
    $existingText = & $codex.Source mcp list --json
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the existing Codex MCP configuration.' }
    $entries = ($existingText -join "`n") | ConvertFrom-Json
    $existing = @($entries | Where-Object { $_.name -eq 'yandex_browser' })
    if ($existing) {
        if ($existing.transport.url -ne 'http://127.0.0.1:37891/mcp' -or $existing.enabled -ne $true) {
            throw 'An incompatible yandex_browser MCP entry already exists. Expected enabled HTTP at http://127.0.0.1:37891/mcp; inspect the existing entry before replacing it.'
        }
    }
}

Push-Location -LiteralPath $projectRoot
try {
    & $npm.Source ci --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. Fix the reported error and rerun this installer.' }
} finally { Pop-Location }

$configDir = Join-Path $projectRoot 'artifacts'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
$httpConfig = @{ mcpServers = @{ yandex_browser = @{ type = 'http'; url = 'http://127.0.0.1:37891/mcp' } } }
$stdioConfig = @{ mcpServers = @{ yandex_browser = @{ command = $node.Source; args = @((Join-Path $projectRoot 'server/stdio.js')) } } }
[IO.File]::WriteAllText((Join-Path $configDir 'mcp-http.json'), ($httpConfig | ConvertTo-Json -Depth 8), $utf8)
[IO.File]::WriteAllText((Join-Path $configDir 'mcp-stdio.json'), ($stdioConfig | ConvertTo-Json -Depth 8), $utf8)

$bridge = & (Join-Path $projectRoot 'scripts/start-bridge.ps1')
if ($EnableExtensionUpdates) {
    & (Join-Path $projectRoot 'scripts/enable-extension-updates.ps1') -InstallRoot $projectRoot | Out-Host
}
if ($RegisterCodex -and -not $existing) {
    & $codex.Source mcp add yandex_browser --url 'http://127.0.0.1:37891/mcp'
    if ($LASTEXITCODE -ne 0) { throw 'Codex registration failed. The bridge is installed; inspect the CLI output.' }
}

$result = [ordered]@{
    mcpUrl = 'http://127.0.0.1:37891/mcp'
    healthUrl = 'http://127.0.0.1:37891/health'
    extensionPath = (Join-Path $projectRoot 'extension')
    browserSetupUrl = 'browser://extensions'
    httpConfig = (Join-Path $configDir 'mcp-http.json')
    stdioConfig = (Join-Path $configDir 'mcp-stdio.json')
    codexRegistered = [bool]$RegisterCodex
    bridgeRunning = $bridge.running
    bridgeAlreadyRunning = $bridge.alreadyRunning
    bridgeProcessId = $bridge.processId
    extensionConnected = $bridge.connected
    nextStep = 'Load the extensionPath as an unpacked extension in the existing Yandex profile, then run npm run test:browser.'
}
$resultJson = $result | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path $configDir 'install-result.json'), $resultJson, $utf8)
Write-Output $resultJson
