import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { reloadUpdatedExtension } from '../extension/lib/self-update.js';
import { applyBuild } from '../scripts/update-extension.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ymcp-test-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const live = join(root, 'extension');
  await cp(new URL('../extension/', import.meta.url), live, { recursive: true });
  const output = join(root, 'release.json');
  execFileSync(process.execPath, ['scripts/package-extension.mjs', '15', 'a'.repeat(40), output], {
    cwd: new URL('../', import.meta.url), windowsHide: true,
  });
  return { root, live, build: JSON.parse(await readFile(output)) };
}

test('extension-only installation preserves the previous tree and never downgrades', async t => {
  const { root, live, build } = await fixture(t);
  const old = await readFile(join(live, 'manifest.json'), 'utf8');
  await mkdir(join(root, 'server'));
  await writeFile(join(root, 'server', 'keep'), 'MCP');
  assert.equal(await applyBuild(root, build, 15), true);
  assert.equal(JSON.parse(await readFile(join(live, 'manifest.json'))).version_name, 'auto-15');
  assert.equal(await readFile(join(root, '.extension-previous', 'manifest.json'), 'utf8'), old);
  assert.equal(await applyBuild(root, build, 15), false);
  assert.equal(await applyBuild(root, { ...build, serial: 14 }, 14), false);
  assert.equal(await readFile(join(root, 'server', 'keep'), 'utf8'), 'MCP');
  assert.ok(!Object.keys(build.files).some(path => /^(server|scripts|node_modules)\//.test(path)));
});

test('malformed package cannot escape staging or replace an installed tree', async t => {
  const { root, live, build } = await fixture(t);
  const old = await readFile(join(live, 'manifest.json'), 'utf8');
  for (const bad of ['../server/index.js', 'lib\\escape', 'lib/NUL.js', 'C:evil']) {
    await assert.rejects(applyBuild(root, { ...build, files: { ...build.files, [bad]: 'aA==' } }, 15), /Invalid extension file/);
  }
  await assert.rejects(applyBuild(root, build, 16), /Invalid extension build/);
  assert.equal(await readFile(join(live, 'manifest.json'), 'utf8'), old);
  await rename(live, join(root, '.extension-previous'));
  assert.equal(await applyBuild(root, build, 15), true);
});

test('only an idle worker reloads a published build different from the running build', async () => {
  let reloads = 0;
  let disk = 'auto-8';
  const runtime = { getManifest: () => ({version_name: 'auto-7'}), getURL: name => name, reload: () => reloads++ };
  const read = async (name, options) => {
    assert.equal(name, 'manifest.json');
    assert.equal(options.cache, 'no-store');
    return Response.json({ version_name: disk });
  };
  await reloadUpdatedExtension(runtime, () => false, read);
  assert.equal(reloads, 0);
  await reloadUpdatedExtension(runtime, () => true, read);
  for (disk of ['auto-7', undefined, 'invalid']) await reloadUpdatedExtension(runtime, () => true, read);
  assert.equal(reloads, 1);
});
