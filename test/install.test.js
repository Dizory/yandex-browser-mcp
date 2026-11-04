import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, cp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const windowsOnly = { skip: process.platform !== 'win32', timeout: 180000 };
function powershell(args, options = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
    cwd: root, encoding: 'utf8', timeout: 120000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options,
  });
}

test('Windows installer preserves MCP entries, handles Unicode paths and reuses the bridge', windowsOnly, async (t) => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'yandex-mcp-установка с пробелами-')));
  let ownedPid;
  t.after(async () => {
    if (ownedPid) {
      try { process.kill(ownedPid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    assert.equal(dirname(resolve(temp)), await realpath(tmpdir()));
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  for (const file of ['install.ps1', 'scripts', 'package.json', 'package-lock.json', 'extension', 'server']) {
    await cp(join(root, file), join(temp, file), { recursive: true });
  }
  const bin = join(temp, 'bin');
  await mkdir(bin);
  const configPath = join(bin, 'entries.json');
  const existing = { name: 'keep_me', enabled: true, transport: { type: 'streamable_http', url: 'http://127.0.0.1:45678/unchanged' } };
  await writeFile(configPath, JSON.stringify([existing]));
  await writeFile(join(bin, 'codex.cmd'), '@echo off\r\nnode "%~dp0codex-stub.cjs" %*\r\n');
  await writeFile(join(bin, 'codex-stub.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, 'entries.json');
const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'mcp' && args[1] === 'list') console.log(JSON.stringify(entries));
else if (args[0] === 'mcp' && args[1] === 'add') {
  entries.push({name:args[2],enabled:true,transport:{type:'streamable_http',url:args[4]}});
  fs.writeFileSync(file,JSON.stringify(entries));
} else process.exit(2);
`);
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
  env[pathKey] = `${bin};${env[pathKey]}`;
  const args = ['-File', join(temp, 'install.ps1'), '-RegisterCodex'];
  try { powershell(args, { cwd: temp, env }); }
  finally {
    try {
      const result = JSON.parse(await readFile(join(temp, 'artifacts/install-result.json'), 'utf8'));
      if (!result.bridgeAlreadyRunning) ownedPid = result.bridgeProcessId;
    } catch { /* installer may have failed before starting the server */ }
  }
  const result = JSON.parse(await readFile(join(temp, 'artifacts/install-result.json'), 'utf8'));
  assert.equal(result.bridgeRunning, true);
  assert.equal(result.extensionPath, join(temp, 'extension'));
  assert.equal(result.codexRegistered, true);
  const stdio = JSON.parse(await readFile(result.stdioConfig, 'utf8'));
  assert.equal(stdio.mcpServers.yandex_browser.args[0], join(temp, 'server/stdio.js'));
  powershell(args, { cwd: temp, env });
  const entries = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(entries[0], existing);
  assert.equal(entries.filter((entry) => entry.name === 'yandex_browser').length, 1);
  assert.equal(JSON.parse(await readFile(join(temp, 'artifacts/install-result.json'), 'utf8')).bridgeAlreadyRunning, true);
  entries[1].transport.url = 'http://127.0.0.1:12345/mcp';
  await writeFile(configPath, JSON.stringify(entries));
  assert.throws(() => powershell(args, { cwd: temp, env }), /incompatible yandex_browser/);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), entries);
});

test('Windows distribution contains install files and excludes local artifacts', windowsOnly, async () => {
  powershell(['-File', join(root, 'scripts/package.ps1')]);
  const archive = join(root, 'artifacts/yandex-browser-mcp-windows.zip');
  const checksums = await readFile(join(root, 'artifacts/SHA256SUMS.txt'), 'utf8');
  assert.equal(checksums.split(' ')[0], createHash('sha256').update(await readFile(archive)).digest('hex'));
  const output = powershell(['-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [IO.Compression.ZipFile]::OpenRead('artifacts/yandex-browser-mcp-windows.zip'); try { @($zip.Entries.FullName) | ConvertTo-Json -Compress } finally { $zip.Dispose() }`]);
  const files = JSON.parse(output).map((file) => file.replaceAll('\\', '/'));
  for (const file of ['install.ps1', 'INSTALL_AGENT.md', 'AGENT_PROMPT.txt', 'extension/manifest.json', 'server/index.js', 'scripts/start-bridge.ps1']) {
    assert.ok(files.includes(file), `Missing ${file}`);
  }
  assert.ok(!files.some((file) => /(^|\/)(node_modules|artifacts|\.git|\.env)(\/|$)/.test(file)));
});
