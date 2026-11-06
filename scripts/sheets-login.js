import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import { sheetsScope, userCredentialsPath } from '../server/sheets-auth.js';

async function login() {
  if (!process.argv[2]) throw new Error('Usage: npm run sheets:login -- "path/to/desktop-client.json"');
  let installed;
  try { ({ installed } = JSON.parse((await readFile(process.argv[2], 'utf8')).replace(/^\uFEFF/, ''))); }
  catch { throw new Error('Could not read the Desktop app client JSON'); }
  if (!installed?.client_id || !installed.client_secret) throw new Error('Expected OAuth client type Desktop app');
  const state = randomBytes(32).toString('hex');
  const server = createServer();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const redirect = 'http://127.0.0.1:' + server.address().port + '/oauth2callback';
    const client = new OAuth2Client(installed.client_id, installed.client_secret, redirect);
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const authUrl = client.generateAuthUrl({ access_type: 'offline', scope: [sheetsScope], prompt: 'consent',
      state, code_challenge_method: 'S256', code_challenge: codeChallenge });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Google login timed out')), 300_000);
      server.on('request', (req, res) => {
        let url;
        try { url = new URL(req.url, redirect); } catch { res.writeHead(400).end(); return; }
        if (req.method !== 'GET' || url.pathname !== '/oauth2callback' || url.searchParams.get('state') !== state) {
          res.writeHead(400).end('Invalid OAuth callback'); return;
        }
        clearTimeout(timer);
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Return to the terminal for the login result.');
        if (!url.searchParams.get('code')) reject(new Error('Google authorization was declined'));
        else resolve(url.searchParams.get('code'));
      });
      console.log('Open this link in your browser to authorize Google Sheets:\n' + authUrl);
    });
    const { tokens } = await client.getToken({ code, codeVerifier });
    if (!tokens.refresh_token || (tokens.scope && !tokens.scope.split(' ').includes(sheetsScope))) {
      throw new Error('Google did not grant offline access to Sheets');
    }
    await mkdir(dirname(userCredentialsPath), { recursive: true, mode: 0o700 });
    const temp = userCredentialsPath + '.' + randomUUID();
    try {
      await writeFile(temp, JSON.stringify({ type: 'authorized_user', client_id: installed.client_id,
        client_secret: installed.client_secret, refresh_token: tokens.refresh_token }), { mode: 0o600, flag: 'wx' });
      await rename(temp, userCredentialsPath);
    } finally { await rm(temp, { force: true }); }
    console.log('Google Sheets connected for this OS user.');
  } finally { server.closeAllConnections(); server.close(); }
}

login().catch(error => {
  // OAuth errors can contain the full credential-bearing HTTP request.
  console.error(error.response || error.config ? 'Google rejected the OAuth token exchange' : error.message);
  process.exitCode = 1;
});
