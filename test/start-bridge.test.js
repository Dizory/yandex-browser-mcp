import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:net';

test('PowerShell cold-start returns and leaves a healthy independent bridge', { skip: process.platform !== 'win32', timeout: 30000 }, async (t) => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'yandex-cold-start-')));
  t.after(async () => {
    try { process.kill(Number(await readFile(join(temp, 'owned.pid'), 'utf8'))); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    assert.equal(dirname(temp), await realpath(tmpdir()));
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const reserve = createServer();
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  await mkdir(join(temp, 'scripts'));
  await mkdir(join(temp, 'server'));
  const script = await readFile(new URL('../scripts/start-bridge.ps1', import.meta.url), 'utf8');
  await writeFile(join(temp, 'scripts/start-bridge.ps1'), script.replaceAll('37891', String(port)));
  await writeFile(join(temp, 'package.json'), '{"type":"module"}');
  await writeFile(join(temp, 'server/index.js'), `
import fs from 'node:fs';
import http from 'node:http';
fs.writeFileSync('owned.pid', String(process.pid));
http.createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({name:'yandex-browser-mcp',connected:false}));
}).listen(${port}, '127.0.0.1');
`);
  let output;
  try {
    output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(temp, 'scripts/start-bridge.ps1')], {
      encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    error.message += `\nstdout: ${error.stdout ?? ''}\nstderr: ${error.stderr ?? ''}`;
    throw error;
  }
  assert.match(output, /True/);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.name, 'yandex-browser-mcp');
});
