import { test, expect, request as pwRequest } from '@playwright/test';
import { startStack, signIn, sessionCookie, prepare, settle, pickClient, SESSION_SECRET, CLIENT_SECRET, type Stack } from './helpers.js';
import { FIRECRAWL_KEY, SA_EMAIL } from './mocks/upstream.js';
import { ROW69_SID, SHEET_ID } from './fixtures/sheet.js';

let st: Stack;
test.beforeAll(async () => { st = await startStack(); });
test.afterAll(async () => { await st.close(); });
test.beforeEach(() => st.upstream.reset());

async function api(body: unknown, opts: { cookie?: string | null; origin?: string | null } = {}) {
  const ctx = await pwRequest.newContext();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie !== null) headers.Cookie = 'mbb=' + (opts.cookie ?? sessionCookie(st));
  if (opts.origin !== null) headers.Origin = opts.origin ?? st.appUrl;
  const res = await ctx.post(st.appUrl + '/api/tool', { headers, data: body, maxRedirects: 0 });
  const out = { status: res.status(), body: await res.json().catch(() => null) };
  await ctx.dispose();
  return out;
}

const read = (input: Record<string, unknown>) => ({ server: 'Google Sheets', tool: 'get_values', input });

test('Workload Identity: Sheets calls use the metadata-server token', async () => {
  const wi = await startStack({ credentials: 'metadata' });
  try {
    expect(wi.cfg.sa.kind).toBe('metadata');
    expect(await wi.cfg.sa.email()).toBe(SA_EMAIL);
    const ctx = await pwRequest.newContext();
    const res = await ctx.post(wi.appUrl + '/api/tool', {
      headers: { 'Content-Type': 'application/json', Origin: wi.appUrl, Cookie: 'mbb=' + sessionCookie(wi) },
      data: read({ spreadsheetId: SHEET_ID, range: 'Summary!A5:C34' }),
    });
    expect(res.status()).toBe(200);
    expect(wi.upstream.issuedSaTokens.length).toBe(1);
    await ctx.dispose();
  } finally {
    await wi.close();
  }
});

test('allowed call works (baseline)', async () => {
  const r = await api(read({ spreadsheetId: SHEET_ID, range: 'Summary!A5:C34' }));
  expect(r.status).toBe(200);
  expect(r.body.payload.values[0]).toEqual(['MYSense', 'MYSense', 'Professional & B2B Services']);
});

test('empty range returns values: [] rather than an error', async () => {
  const r = await api(read({ spreadsheetId: SHEET_ID, range: "'MYSense'!A400" }));
  expect(r.status).toBe(200);
  expect(r.body.payload.values).toEqual([]);
});

test('rejects another spreadsheet ID, without calling Google', async () => {
  for (const tool of ['get_values', 'update_values', 'get_spreadsheet']) {
    const r = await api({ server: 'Google Sheets', tool, input: { spreadsheetId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms', range: 'A1', values: [['x']], fields: ['sheets.properties.title', 'sheets.properties.sheetId'] } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('blocked_by_policy');
  }
  expect(st.upstream.sheetsRequests).toEqual([]);
});

test('rejects other tool names and servers', async () => {
  const cases = [
    { server: 'Google Sheets', tool: 'batch_clear_values', input: { spreadsheetId: SHEET_ID } },
    { server: 'Google Sheets', tool: 'append_values', input: { spreadsheetId: SHEET_ID, range: 'A1', values: [['x']] } },
    { server: 'Firecrawl', tool: 'firecrawl_scrape', input: { url: 'https://example.com' } },
    { server: 'Gmail', tool: 'send_email', input: {} },
    { server: '__proto__', tool: 'constructor', input: {} },
    { server: 'Google Sheets', tool: 'get_spreadsheet', input: { spreadsheetId: SHEET_ID, fields: ['sheets'] } },
    { server: 'Google Sheets', tool: 'get_values', input: { spreadsheetId: SHEET_ID, range: 'A1', extra: 1 } },
  ];
  for (const c of cases) {
    const r = await api(c);
    expect(r.status, JSON.stringify(c)).toBe(403);
    expect(r.body.error.code).toBe('blocked_by_policy');
  }
  expect(st.upstream.sheetsRequests).toEqual([]);
  expect(st.upstream.searches).toEqual([]);
});

test('rejects a request with no session (or a forged one)', async () => {
  const none = await api(read({ spreadsheetId: SHEET_ID, range: 'A1' }), { cookie: null });
  expect(none.status).toBe(401);
  expect(none.body.error.code).toBe('not_granted');
  const forged = await api(read({ spreadsheetId: SHEET_ID, range: 'A1' }), { cookie: 'eyJlbWFpbCI6ImF0dGFja2VyQGV2aWwuY29tIn0' });
  expect(forged.status).toBe(401);
  const ctx = await pwRequest.newContext();
  const home = await ctx.get(st.appUrl + '/', { maxRedirects: 0 });
  expect(home.status()).toBe(302);
  expect(home.headers().location).toBe('/auth/login');
  const me = await ctx.get(st.appUrl + '/api/me');
  expect(me.status()).toBe(401);
  await ctx.dispose();
});

test('rejects a request from another origin, or with no Origin', async () => {
  const other = await api(read({ spreadsheetId: SHEET_ID, range: 'A1' }), { origin: 'https://evil.example' });
  expect(other.status).toBe(403);
  const missing = await api(read({ spreadsheetId: SHEET_ID, range: 'A1' }), { origin: null });
  expect(missing.status).toBe(403);
  expect(st.upstream.sheetsRequests).toEqual([]);
});

test('Firecrawl: limit capped at 10, key sent server-side only, per-user rate limit', async () => {
  const r = await api({ server: 'Firecrawl', tool: 'firecrawl_search', input: { query: 'site:example.com "x"', objective: 'o', limit: 500 } });
  expect(r.status).toBe(200);
  expect(st.upstream.searches[0].body.limit).toBe(10);
  expect(st.upstream.searches[0].auth).toBe('Bearer ' + FIRECRAWL_KEY);
  const who = sessionCookie(st, { email: 'heavy.user@mysense.com.my' });
  for (let i = 0; i < 30; i++) expect((await api({ server: 'Firecrawl', tool: 'firecrawl_search', input: { query: 'q' + i, limit: 1 } }, { cookie: who })).status).toBe(200);
  const over = await api({ server: 'Firecrawl', tool: 'firecrawl_search', input: { query: 'one more', limit: 1 } }, { cookie: who });
  expect(over.status).toBe(429);
  expect(over.body.error).toMatchObject({ code: 'rate_limited', retryable: false });
});

test('sign-in: allow-list by domain and by email; others refused', async () => {
  const login = async (email: string) => {
    st.upstream.mode.loginEmail = email;
    const ctx = await pwRequest.newContext();
    const res = await ctx.get(st.appUrl + '/auth/login');
    const cookies = (await ctx.storageState()).cookies.filter((c) => c.name === 'mbb' && c.value);
    await ctx.dispose();
    return { status: res.status(), url: res.url(), signedIn: cookies.length === 1, httpOnly: cookies[0]?.httpOnly };
  };
  expect(await login('intern@mysense.com.my')).toMatchObject({ status: 200, signedIn: true, httpOnly: true });
  expect(await login('friend.of.mysense@gmail.com')).toMatchObject({ signedIn: true });
  const denied = await login('stranger@gmail.com');
  expect(denied).toMatchObject({ status: 403, signedIn: false });
  // Identity only: no Sheets scope is requested from the person signing in.
  expect(new Set(st.upstream.authScopes)).toEqual(new Set(['openid email profile']));
});

test('no token, secret or API key ever reaches the browser; headers set', async ({ page, context }) => {
  await signIn(context, st);
  const seen: string[] = [];
  page.on('response', async (res) => {
    if (!res.url().startsWith(st.appUrl)) return;
    seen.push(JSON.stringify(res.headers()));
    try { seen.push(await res.text()); } catch { /* redirects have no body */ }
  });
  const violations: string[] = [];
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
  await prepare(page);
  const nav = await page.goto(st.appUrl);
  await settle(page);
  await pickClient(page, 'MYSense');
  await page.click(`button.ckbtn[data-check=${JSON.stringify(ROW69_SID)}]`);
  await page.click(`[data-autocheck=${JSON.stringify(ROW69_SID)}]`);
  await expect(page.locator('tr.ck .ckmsg').first()).toContainText('Found 2 of 2');

  const all = seen.join('\n');
  // The cookie payload is encrypted, so the raw values must not appear anywhere.
  const privateKey = st.upstream.saKeyFile().private_key.split('\n')[1];
  expect(st.upstream.issuedSaTokens.length).toBeGreaterThan(0);
  for (const secret of [...st.upstream.issuedSaTokens, privateKey, FIRECRAWL_KEY, CLIENT_SECRET, SESSION_SECRET]) expect(all).not.toContain(secret);
  expect(await page.evaluate(() => document.cookie)).toBe('');
  expect(await page.evaluate(() => typeof (window as any).claude.use)).toBe('function');

  const h = nav!.headers();
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['content-security-policy']).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
  expect(h['content-security-policy']).not.toMatch(/script-src[^;]*unsafe-inline/);
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(violations).toEqual([]);
});
