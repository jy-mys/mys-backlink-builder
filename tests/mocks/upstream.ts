import crypto from 'node:crypto';
import http from 'node:http';
import { buildStore, ORIGINAL_HTML, SHEET_ID, type Grid } from '../fixtures/sheet.js';

// One local server that stands in for everything outside the app:
//   Google sign-in (/o/oauth2/auth, /token), service-account tokens (/token with a JWT
//   assertion, and the Cloud Run metadata server), Sheets REST v4 (/v4/...),
//   Firecrawl (/v2/search), and, for the parity runs, the original artifact page
//   (/original) with a mock window.claude backed by the same store (/__mcp).

export interface Write { range: string; values: unknown[][] }
export interface Mode {
  sheets: 'ok' | 'forbidden' | 'rate' | 'expireOnce';
  saToken: 'ok' | 'down';
  firecrawl: 'ok' | 'credits';
  loginEmail: string;
}

export const CLIENT_ID = 'test-client.apps.googleusercontent.com';
export const SA_EMAIL = 'backlink-builder@mysense-test.iam.gserviceaccount.com';
export const FIRECRAWL_KEY = 'fc-test-SECRET-key-123';
export const CREDITS_MSG = 'Insufficient credits to perform this request. For more credits, you can upgrade your plan at https://firecrawl.dev/pricing.';

const col = (s: string) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

export function parseRange(r: string) {
  const m = r.match(/^(?:'((?:[^']|'')+)'|([^!']+))!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/);
  if (!m) return null;
  const sheet = m[1] != null ? m[1].replace(/''/g, "'") : m[2];
  const c1 = col(m[3]), r1 = m[4] ? +m[4] - 1 : 0;
  const c2 = m[5] ? col(m[5]) : c1;
  const r2 = m[5] ? (m[6] ? +m[6] - 1 : Infinity) : r1;
  return { sheet, c1, r1, c2, r2 };
}

class SheetError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export function mockRuntimeScript(): string {
  return `window.claude={use:function(n){
  if(n==='mcp')return Promise.resolve({callTool:function(server,tool,input){
    return fetch('/__mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:server,tool:tool,input:input})})
      .then(function(r){return r.json();}).then(function(b){if(b.error)throw b.error;return {payload:b.payload};});}});
  if(n==='user')return Promise.resolve({me:function(){return Promise.resolve({name:'Test Intern'});}});
  return Promise.resolve(null);}};`;
}

// The original fragment, wrapped in the same skeleton as public/index.html, with the mock runtime
// loaded where the app loads its shim. The fragment itself is untouched.
export function originalPage(): string {
  const lines = ORIGINAL_HTML.split('\n');
  const head = lines.slice(0, 267), body = lines.slice(267, 376), script = lines.slice(376);
  return ['<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">', ...head,
    '</head>', '<body>', ...body, '<script src="/mock-claude.js"></script>', ...script, '</body>', '</html>', ''].join('\n');
}

export class Upstream {
  url = '';
  store = buildStore();
  writes: Write[] = [];
  searches: { auth: string; body: any }[] = [];
  sheetsRequests: { method: string; path: string }[] = [];
  mode: Mode = { sheets: 'ok', saToken: 'ok', firecrawl: 'ok', loginEmail: 'intern@mysense.com.my' };
  validTokens = new Set<string>();
  issuedSaTokens: string[] = [];
  authScopes: string[] = [];
  private keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  private server = http.createServer((req, res) => this.handle(req, res));
  private n = 0;

  async start() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as any).port}`;
    return this;
  }
  close() { return new Promise((r) => this.server.close(r)); }
  reset() {
    this.store = buildStore();
    this.writes = []; this.searches = []; this.sheetsRequests = []; this.authScopes = [];
    this.mode = { sheets: 'ok', saToken: 'ok', firecrawl: 'ok', loginEmail: 'intern@mysense.com.my' };
  }

  // A service account key file whose token_uri points at this mock.
  saKeyFile() {
    return {
      type: 'service_account',
      project_id: 'mysense-test',
      private_key_id: 'test-key',
      private_key: this.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      client_email: SA_EMAIL,
      token_uri: this.url + '/token',
    };
  }
  get metadataHost() { return this.url.replace(/^http:\/\//, ''); }
  private issueSaToken() {
    const at = 'sa-at-' + ++this.n;
    this.validTokens.add(at);
    this.issuedSaTokens.push(at);
    return at;
  }

  /* ---- store operations (shared by the REST mock and the window.claude mock) ---- */
  getValues(range: string) {
    const p = parseRange(range);
    if (!p) throw new SheetError(400, `Unable to parse range: ${range}`);
    const g = this.store.sheets.get(p.sheet);
    if (!g) throw new SheetError(400, `Unable to parse range: ${range}`);
    const out: string[][] = [];
    for (let r = p.r1; r <= Math.min(p.r2, g.length - 1); r++) {
      const row = (g[r] || []).slice(p.c1, p.c2 + 1).map((v) => (v == null ? '' : String(v)));
      while (row.length && row[row.length - 1] === '') row.pop();
      out.push(row);
    }
    while (out.length && !out[out.length - 1].length) out.pop();
    return out.length ? { range, majorDimension: 'ROWS', values: out } : { range, majorDimension: 'ROWS' };
  }
  updateValues(range: string, values: unknown[][]) {
    const p = parseRange(range);
    const g = p && this.store.sheets.get(p.sheet);
    if (!p || !g) throw new SheetError(400, `Unable to parse range: ${range}`);
    values.forEach((row, i) => {
      const r = p.r1 + i;
      while (g.length <= r) g.push([]);
      row.forEach((v, j) => {
        const c = p.c1 + j;
        while (g[r].length <= c) g[r].push('');
        g[r][c] = v == null ? '' : String(v);
      });
    });
    this.writes.push({ range, values });
    return { spreadsheetId: SHEET_ID, updatedRange: range, updatedRows: values.length };
  }
  getSpreadsheet() {
    return { sheets: [...this.store.gids].map(([title, sheetId]) => ({ properties: { title, sheetId } })) };
  }
  search(query: string) {
    const host = (query.match(/site:(\S+)/) || [])[1] || 'example.com';
    return {
      success: true,
      data: {
        web: [
          { url: `https://${host}/listing/locus-t`, title: 'Locus-T Sdn Bhd | Digital agency', description: 'Locus-T is a digital marketing agency in Kuala Lumpur.' },
          { url: `https://${host}/listing/primal`, title: 'Primal Malaysia', description: 'Primal Malaysia digital agency profile.' },
          { url: 'https://elsewhere.example/primal', title: 'Primal Malaysia elsewhere', description: 'Off-site result, must be ignored.' },
        ],
      },
    };
  }

  /* ---- HTTP ---- */
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const u = new URL(req.url || '/', this.url);
    const body = await new Promise<string>((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    try {
      if (u.pathname === '/original') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(originalPage()); }
      if (u.pathname === '/mock-claude.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(mockRuntimeScript()); }
      if (u.pathname === '/__mcp') return this.mcp(JSON.parse(body), json);

      if (u.pathname === '/o/oauth2/auth') {
        this.authScopes.push(u.searchParams.get('scope') || '');
        const back = new URL(u.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', 'code-' + ++this.n);
        back.searchParams.set('state', u.searchParams.get('state')!);
        res.writeHead(302, { Location: back.toString() });
        return res.end();
      }
      if (u.pathname === '/token') {
        const f = new URLSearchParams(body);
        if (f.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
          if (this.mode.saToken === 'down') return json(500, { error: 'internal_failure' });
          const [h, p, sig] = String(f.get('assertion')).split('.');
          const ok = crypto.createVerify('RSA-SHA256').update(h + '.' + p).verify(this.keys.publicKey, Buffer.from(sig, 'base64url'));
          const c = JSON.parse(Buffer.from(p, 'base64url').toString());
          if (!ok || c.iss !== SA_EMAIL || c.aud !== this.url + '/token' || c.scope !== 'https://www.googleapis.com/auth/spreadsheets') return json(400, { error: 'invalid_grant' });
          return json(200, { access_token: this.issueSaToken(), expires_in: 3599, token_type: 'Bearer' });
        }
        if (f.get('grant_type') === 'authorization_code' && f.get('code_verifier')) {
          const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
          const idt = enc({ alg: 'RS256' }) + '.' + enc({ aud: CLIENT_ID, email: this.mode.loginEmail, email_verified: true, name: 'Login User' }) + '.sig';
          return json(200, { access_token: 'user-at-' + ++this.n, expires_in: 3599, id_token: idt, scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile' });
        }
        return json(400, { error: 'invalid_request' });
      }
      if (u.pathname.startsWith('/computeMetadata/v1/instance/service-accounts/default/')) {
        if (req.headers['metadata-flavor'] !== 'Google') return json(403, { error: 'Missing Metadata-Flavor header' });
        if (this.mode.saToken === 'down') return json(500, { error: 'unavailable' });
        if (u.pathname.endsWith('/email')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(SA_EMAIL); }
        if (u.pathname.endsWith('/token')) return json(200, { access_token: this.issueSaToken(), expires_in: 3599, token_type: 'Bearer' });
      }

      if (u.pathname.startsWith('/v4/spreadsheets/')) {
        this.sheetsRequests.push({ method: req.method || '', path: u.pathname + u.search });
        const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
        if (this.mode.sheets === 'expireOnce') { this.mode.sheets = 'ok'; this.validTokens.clear(); }
        if (!this.validTokens.has(token)) return json(401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } });
        if (this.mode.sheets === 'forbidden') return json(403, { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } });
        if (this.mode.sheets === 'rate') return json(429, { error: { code: 429, message: 'Quota exceeded for quota metric \'Read requests\'', status: 'RESOURCE_EXHAUSTED' } }, { 'Retry-After': '1' });
        const m = u.pathname.match(/^\/v4\/spreadsheets\/([^/]+)(?:\/values\/(.+))?$/);
        if (!m || decodeURIComponent(m[1]) !== SHEET_ID) return json(404, { error: { code: 404, message: 'Requested entity was not found.' } });
        if (!m[2]) return json(200, this.getSpreadsheet());
        const range = decodeURIComponent(m[2]);
        if (req.method === 'GET') return json(200, this.getValues(range));
        if (req.method === 'PUT') {
          if (u.searchParams.get('valueInputOption') !== 'USER_ENTERED') return json(400, { error: { code: 400, message: 'valueInputOption required' } });
          return json(200, this.updateValues(range, JSON.parse(body).values));
        }
      }

      if (u.pathname === '/v2/search') {
        const b = JSON.parse(body);
        this.searches.push({ auth: String(req.headers.authorization || ''), body: b });
        if (this.mode.firecrawl === 'credits') return json(402, { success: false, error: CREDITS_MSG });
        return json(200, this.search(b.query));
      }
      json(404, { error: 'not found' });
    } catch (e) {
      if (e instanceof SheetError) return json(e.status, { error: { code: e.status, message: e.message } });
      json(500, { error: { code: 500, message: String(e) } });
    }
  }

  private mcp(b: { server: string; tool: string; input: any }, json: (s: number, d: unknown) => void) {
    try {
      if (b.server === 'Google Sheets' && b.input.spreadsheetId !== SHEET_ID) throw new SheetError(404, 'Requested entity was not found.');
      if (b.tool === 'get_values') { const v = this.getValues(b.input.range); return json(200, { payload: { ...v, values: (v as any).values || [] } }); }
      if (b.tool === 'update_values') return json(200, { payload: this.updateValues(b.input.range, b.input.values) });
      if (b.tool === 'get_spreadsheet') return json(200, { payload: this.getSpreadsheet() });
      if (b.tool === 'firecrawl_search') {
        this.searches.push({ auth: 'connector', body: b.input });
        if (this.mode.firecrawl === 'credits') return json(200, { error: { code: 'tool_error', message: CREDITS_MSG } });
        return json(200, { payload: this.search(b.input.query) });
      }
      json(200, { error: { code: 'not_in_manifest', message: 'unknown tool' } });
    } catch (e: any) {
      json(200, { error: { code: 'tool_error', message: e.message } });
    }
  }
}

export type { Grid };
