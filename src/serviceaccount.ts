import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ToolError } from './errors.js';

// Access tokens for the app's own service account, which is what calls the Sheets API.
// Two sources, mirroring Google's Application Default Credentials:
//   - Cloud Run (preferred): the attached service account, via the metadata server. No key file.
//   - Elsewhere: a JSON key file named by GOOGLE_APPLICATION_CREDENTIALS, exchanged with a signed JWT.

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

interface KeyFile { client_email: string; private_key: string; token_uri?: string }

export interface TokenSource {
  kind: 'key-file' | 'metadata';
  email(): Promise<string>;
  token(): Promise<string>;
  invalidate(): void;
}

function unavailable(detail: string): ToolError {
  console.error('Service account token unavailable: ' + detail);
  return new ToolError('server_not_connected', 'Service account credentials are unavailable', 503);
}

export function serviceAccount(env: NodeJS.ProcessEnv): TokenSource {
  let cached: { token: string; exp: number } | null = null;
  const fresh = () => (cached && cached.exp - Date.now() > 60_000 ? cached.token : null);

  const path = (env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (path) {
    let key: KeyFile;
    try {
      key = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      throw new Error(`GOOGLE_APPLICATION_CREDENTIALS: can't read ${path} (${(e as Error).message})`);
    }
    if (!key.client_email || !key.private_key) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not a service account key file');
    const tokenUri = key.token_uri || 'https://oauth2.googleapis.com/token';
    return {
      kind: 'key-file',
      email: async () => key.client_email,
      invalidate: () => { cached = null; },
      async token() {
        const t = fresh(); if (t) return t;
        const now = Math.floor(Date.now() / 1000);
        const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({ iss: key.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 });
        const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url');
        let res: globalThis.Response;
        try {
          res = await fetch(tokenUri, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }),
          });
        } catch (e) {
          throw unavailable((e as Error).message);
        }
        const body = (await res.json().catch(() => ({}))) as Record<string, any>;
        if (!res.ok || !body.access_token) throw unavailable(`token endpoint returned ${res.status} ${body.error || ''}`);
        cached = { token: body.access_token, exp: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
        return cached.token;
      },
    };
  }

  // Same override name the Google client libraries use; only the tests set it.
  const host = (env.GCE_METADATA_HOST || 'metadata.google.internal').replace(/\/$/, '');
  const base = `http://${host}/computeMetadata/v1/instance/service-accounts/default`;
  const md = async (p: string) => {
    let res: globalThis.Response;
    try {
      res = await fetch(base + p, { headers: { 'Metadata-Flavor': 'Google' } });
    } catch (e) {
      throw unavailable(`metadata server unreachable (${(e as Error).message}). Outside Cloud Run, set GOOGLE_APPLICATION_CREDENTIALS.`);
    }
    if (!res.ok) throw unavailable(`metadata server returned ${res.status}`);
    return res;
  };
  let email: string | null = null;
  return {
    kind: 'metadata',
    invalidate: () => { cached = null; },
    async email() {
      if (!email) email = (await (await md('/email')).text()).trim();
      return email;
    },
    async token() {
      const t = fresh(); if (t) return t;
      const body = (await (await md('/token?scopes=' + encodeURIComponent(SCOPE))).json()) as Record<string, any>;
      if (!body.access_token) throw unavailable('metadata server returned no token');
      cached = { token: body.access_token, exp: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
      return cached.token;
    },
  };
}
