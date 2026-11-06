import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { JWT, UserRefreshClient } from 'google-auth-library';

export const sheetsScope = 'https://www.googleapis.com/auth/spreadsheets';
export const userCredentialsPath = join(process.env.LOCALAPPDATA || homedir(), 'yandex-browser-mcp', 'google-user.json');

let cached;
export async function sheetsAccessToken() {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS || userCredentialsPath;
  let source;
  try { source = await readFile(path, 'utf8'); }
  catch { throw new Error('Google Sheets is not connected. Run npm run sheets:login -- "path/to/desktop-client.json" or set GOOGLE_APPLICATION_CREDENTIALS for the bridge.'); }
  if (source !== cached?.source) {
    let data;
    try { data = JSON.parse(source.replace(/^\uFEFF/, '')); } catch { throw new Error('Invalid Google credentials JSON'); }
    let client;
    if (data?.type === 'authorized_user' && data.client_id && data.client_secret && data.refresh_token) {
      client = new UserRefreshClient({ clientId: data.client_id, clientSecret: data.client_secret, refreshToken: data.refresh_token });
    } else if (data?.type === 'service_account' && data.client_email && data.private_key) {
      client = new JWT({ email: data.client_email, key: data.private_key, scopes: [sheetsScope] });
    } else throw new Error('Expected Google service_account or authorized_user credentials');
    cached = { source, client };
  }
  try {
    const { token } = await cached.client.getAccessToken();
    if (!token) throw new Error();
    return token;
  } catch { throw new Error('Google token refresh failed. Check the account credentials or repeat sheets:login.'); }
}
