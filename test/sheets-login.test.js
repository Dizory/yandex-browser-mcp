import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

test('Sheets desktop login validates callback state, uses PKCE and saves only a refresh credential', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ymcp-oauth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clientFile = join(dir, 'client.json');
  await writeFile(clientFile, JSON.stringify({ installed: { client_id: 'test-client', client_secret: 'test-secret' } }));
  // The real SDK builds the URL and verifier. Replace only the remote token exchange.
  const stub = `
    import { OAuth2Client } from 'google-auth-library';
    import { createHash } from 'node:crypto';
    OAuth2Client.prototype.getToken = async ({ code, codeVerifier }) => {
      if (createHash('sha256').update(codeVerifier).digest('base64url') !== code) throw Error('PKCE mismatch');
      return {tokens: {refresh_token: 'test-refresh-token', access_token: 'discard-me'}};
    };
    process.argv[2] = process.env.YMCP_TEST_CLIENT;
    await import('./scripts/sheets-login.js');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', stub], {
    cwd: new URL('../', import.meta.url), windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: dir, YMCP_TEST_CLIENT: clientFile },
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = once(child, 'exit');
  for await (const line of createInterface({ input: child.stdout })) {
    if (!line.startsWith('https://')) continue;
    const auth = new URL(line);
    assert.equal(auth.searchParams.get('access_type'), 'offline');
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    const callback = new URL(auth.searchParams.get('redirect_uri'));
    assert.equal(callback.hostname, '127.0.0.1');
    callback.searchParams.set('state', 'wrong');
    assert.equal((await fetch(callback)).status, 400);
    callback.searchParams.set('state', auth.searchParams.get('state'));
    callback.searchParams.set('code', auth.searchParams.get('code_challenge'));
    assert.equal((await fetch(callback)).status, 200);
  }
  assert.equal((await exit)[0], 0);
  const saved = JSON.parse(await readFile(join(dir, 'yandex-browser-mcp', 'google-user.json')));
  assert.deepEqual(saved, { type: 'authorized_user', client_id: 'test-client', client_secret: 'test-secret', refresh_token: 'test-refresh-token' });
});
