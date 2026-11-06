import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const repo = 'Dizory/yandex-browser-mcp';
const asset = 'extension.json';
const run = promisify(execFile);
const releases = 'https://github.com/' + repo + '/releases/download/';
const exists = async path => lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
const installedBuild = manifest => Number(/^auto-([1-9]\d*)$/.exec(manifest.version_name)?.[1] || 0);

async function manifest(dir) {
  if (!(await lstat(dir)).isDirectory()) throw new Error('Expected an extension directory: ' + dir);
  const info = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  if (info.name !== 'Yandex Browser MCP Bridge' || info.manifest_version !== 3 ||
      info.background?.service_worker !== 'background.js') throw new Error('Unexpected extension in ' + dir);
  return info;
}

export async function applyBuild(root, bundle, expected) {
  if (bundle.serial !== expected || !Number.isSafeInteger(expected) || expected < 1 ||
      !/^[0-9a-f]{40}$/.test(bundle.commit) || !bundle.files || Array.isArray(bundle.files) ||
      typeof bundle.files !== 'object' || !Object.hasOwn(bundle.files, 'background.js')) throw new Error('Invalid extension build');
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  const live = join(root, 'extension');
  const previous = join(root, '.extension-previous');
  // A stopped process between the two renames leaves the old tree intact.
  if (!await exists(live) && await exists(previous)) await rename(previous, live);
  const hasLive = !!await exists(live);
  if (hasLive && installedBuild(await manifest(live)) >= expected) return false;
  const stage = await mkdtemp(join(root, '.extension-stage-'));
  try {
    for (const [name, data] of Object.entries(bundle.files)) {
      if (name.split('/').some(part => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part) || part.endsWith('.') || reserved.test(part)) ||
          typeof data !== 'string') throw new Error('Invalid extension file: ' + name);
      const file = join(stage, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, Buffer.from(data, 'base64'), { flag: 'wx' });
    }
    if (installedBuild(await manifest(stage)) !== expected) throw new Error('Build marker mismatch');
    if (await exists(previous)) {
      await manifest(previous); // Never remove an unrelated folder or a symlink.
      await rm(previous, { recursive: true });
    }
    if (hasLive) await rename(live, previous);
    try { await rename(stage, live); }
    catch (error) { if (hasLive) await rename(previous, live); throw error; }
    return true;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function download(url, limit) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error('Download failed: HTTP ' + response.status + ' ' + url);
  const chunks = [];
  let length = 0;
  for await (const bytes of response.body) {
    length += bytes.length;
    if (length > limit) throw new Error('Release file too large: ' + url);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function update() {
  if (!process.env.LOCALAPPDATA) throw new Error('Expected Windows LOCALAPPDATA');
  const root = resolve(process.argv[2] || resolve(process.env.LOCALAPPDATA, 'YandexBrowserMCP'));
  // A named pipe lock is released by Windows even if the updater is killed.
  const lock = createServer(socket => socket.end());
  const lockKey = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 24);
  try {
    await new Promise((ok, fail) => {
      lock.once('error', fail);
      lock.listen('\\\\.\\pipe\\ymcp-extension-' + lockKey, ok);
    });
  } catch (error) { if (error.code === 'EADDRINUSE') return; throw error; }
  try {
    const live = join(root, 'extension');
    if (!await exists(live) && await exists(join(root, '.extension-previous'))) {
      await rename(join(root, '.extension-previous'), live);
    }
    const current = await exists(live) ? installedBuild(await manifest(live)) : 0;
    const { serial } = JSON.parse(await download(releases + 'ext-channel/channel.json', 4096));
    if (!Number.isSafeInteger(serial) || serial < 1) throw new Error('Invalid update channel');
    if (serial <= current) { console.log('No newer extension build.'); return; }
    const temp = await mkdtemp(join(tmpdir(), 'ymcp-release-'));
    try {
      const path = join(temp, asset);
      const release = releases + 'ext-build-' + serial + '/';
      const [bytes, signature] = await Promise.all([download(release + asset, 8 * 1024 * 1024),
        download(release + 'attestation.json', 1024 * 1024)]);
      const signed = join(temp, 'attestation.json');
      await Promise.all([writeFile(path, bytes), writeFile(signed, signature)]);
      const bundle = JSON.parse(bytes);
      if (!/^[0-9a-f]{40}$/.test(bundle.commit)) throw new Error('Invalid build commit');
      await run(process.env.YMCP_VERIFIER || 'gh', ['attestation', 'verify', path, '--bundle', signed, '-R', repo,
        '--signer-workflow', repo + '/.github/workflows/test.yml', '--source-ref', 'refs/heads/main',
        '--source-digest', bundle.commit, '--deny-self-hosted-runners'], { windowsHide: true, timeout: 120000,
        env: { ...process.env, GH_CONFIG_DIR: temp, GH_TOKEN: '', GITHUB_TOKEN: '', GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' } });
      await mkdir(root, { recursive: true });
      await applyBuild(root, bundle, serial);
      console.log('Installed extension build ' + serial);
    } finally { await rm(temp, { recursive: true, force: true }); }
  } finally { lock.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  update().catch(error => { console.error(error.message); process.exitCode = 1; });
}
