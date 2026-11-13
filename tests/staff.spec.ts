import { test, expect, request as pwRequest } from '@playwright/test';
import { startStack, sessionCookie, type Stack } from './helpers.js';
import { SHEET_ID } from './fixtures/sheet.js';

// Staff (@mysense.com.my) sign in by domain; interns sign in with a Gmail address that staff
// add on /staff. The list lives in a hidden "App access" tab that the page's tool calls can't reach.

let st: Stack;
test.beforeAll(async () => { st = await startStack(); });
test.afterAll(async () => { await st.close(); });
test.beforeEach(() => st.upstream.reset());

const STAFF = 'lead@mysense.com.my';
const INTERN = 'aina.intern@gmail.com';
const TAB = 'App access';

const cookieFor = (email: string) => 'mbb=' + sessionCookie(st, { email, name: email.split('@')[0] });

async function get(path: string, email: string | null) {
  const ctx = await pwRequest.newContext();
  const res = await ctx.get(st.appUrl + path, { headers: email ? { Cookie: cookieFor(email) } : {}, maxRedirects: 0 });
  const out = { status: res.status(), location: res.headers().location, text: await res.text() };
  await ctx.dispose();
  return out;
}

async function post(path: string, email: string | null, form: Record<string, string>, origin: string | null = st.appUrl) {
  const ctx = await pwRequest.newContext();
  const headers: Record<string, string> = {};
  if (email) headers.Cookie = cookieFor(email);
  if (origin) headers.Origin = origin;
  const res = await ctx.post(st.appUrl + path, { headers, form, maxRedirects: 0 });
  const out = { status: res.status(), text: await res.text() };
  await ctx.dispose();
  return out;
}

async function tool(email: string, body: unknown) {
  const ctx = await pwRequest.newContext();
  const res = await ctx.post(st.appUrl + '/api/tool', { headers: { 'Content-Type': 'application/json', Origin: st.appUrl, Cookie: cookieFor(email) }, data: body });
  const out = { status: res.status(), body: await res.json().catch(() => null) };
  await ctx.dispose();
  return out;
}

async function login(email: string) {
  st.upstream.mode.loginEmail = email;
  const ctx = await pwRequest.newContext();
  const res = await ctx.get(st.appUrl + '/auth/login');
  const signedIn = (await ctx.storageState()).cookies.some((c) => c.name === 'mbb' && c.value);
  const text = await res.text();
  await ctx.dispose();
  return { status: res.status(), signedIn, text };
}

const accessTab = () => st.upstream.store.sheets.get(TAB);
const summary = { server: 'Google Sheets', tool: 'get_values', input: { spreadsheetId: SHEET_ID, range: 'Summary!A5:C34' } };

test('only staff can open the staff page', async () => {
  expect(await get('/staff', null)).toMatchObject({ status: 302, location: '/auth/login' });
  const staff = await get('/staff', STAFF);
  expect(staff.status).toBe(200);
  expect(staff.text).toContain('Add intern');
  expect(staff.text).toContain('No interns yet.');
  // An intern on the list still can't manage it.
  await post('/staff/add', STAFF, { email: INTERN, name: 'Aina' });
  expect((await get('/staff', INTERN)).status).toBe(403);
  expect((await post('/staff/add', INTERN, { email: 'friend@gmail.com', name: 'x' })).status).toBe(403);
  expect(accessTab()!.some((r) => r[0] === 'friend@gmail.com')).toBe(false);
});

test('adding an intern creates the hidden tab and lets that Gmail sign in', async () => {
  // A fresh address: the app caches the list for a minute, and earlier tests listed INTERN.
  const NEW = 'new.intern@gmail.com';
  expect(await login(NEW)).toMatchObject({ status: 403, signedIn: false });
  expect(accessTab()).toBeUndefined();

  const added = await post('/staff/add', STAFF, { email: ' New.Intern@Gmail.com ', name: 'Aina Rahman' });
  expect(added.status).toBe(200);
  expect(added.text).toContain(`${NEW} can now sign in.`);
  expect(st.upstream.hidden.has(TAB)).toBe(true);
  expect(accessTab()![0]).toEqual(['Intern Gmail', 'Name', 'Access', 'Changed by', 'Changed on']);
  expect(accessTab()![1].slice(0, 4)).toEqual([NEW, 'Aina Rahman', 'Active', STAFF]);
  expect(accessTab()![1][4]).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4}$/);
  // Stored as plain text, never as formulas.
  expect(new Set(st.upstream.valueInputs)).toEqual(new Set(['RAW']));

  expect(await login(NEW)).toMatchObject({ status: 200, signedIn: true });
  expect((await tool(NEW, summary)).status).toBe(200);
  expect(await login('someone.else@gmail.com')).toMatchObject({ status: 403, signedIn: false });
  expect((await get('/staff', STAFF)).text).toContain('Aina Rahman');
});

test('removing an intern locks them out at once; adding back reuses the row', async () => {
  await post('/staff/add', STAFF, { email: INTERN, name: 'Aina Rahman' });
  expect((await tool(INTERN, summary)).status).toBe(200);

  const removed = await post('/staff/remove', STAFF, { email: INTERN });
  expect(removed.text).toContain(`${INTERN} can no longer sign in.`);
  expect(accessTab()![1].slice(0, 3)).toEqual([INTERN, 'Aina Rahman', 'Removed']);
  // The existing session stops working, and signing in again is refused.
  const r = await tool(INTERN, summary);
  expect(r.status).toBe(401);
  expect(r.body.error.code).toBe('not_granted');
  expect(await get('/', INTERN)).toMatchObject({ status: 302, location: '/auth/login' });
  expect(await login(INTERN)).toMatchObject({ status: 403, signedIn: false });

  await post('/staff/add', STAFF, { email: INTERN, name: 'Aina Rahman' });
  expect(accessTab()!.filter((row) => row[0] === INTERN)).toHaveLength(1);
  expect(await login(INTERN)).toMatchObject({ signedIn: true });
});

test('staff page rejects non-Gmail addresses and cross-site posts', async () => {
  for (const email of ['aina@yahoo.com', 'someone@mysense.com.my', 'not-an-email', '']) {
    const r = await post('/staff/add', STAFF, { email, name: 'x' });
    expect(r.status).toBe(400);
    expect(r.text).toContain('Interns need a @gmail.com address');
  }
  expect((await post('/staff/add', STAFF, { email: INTERN, name: 'x' }, 'https://evil.example')).status).toBe(403);
  expect((await post('/staff/add', STAFF, { email: INTERN, name: 'x' }, null)).status).toBe(403);
  expect(accessTab()).toBeUndefined();
});

test('the page\'s tool calls cannot read, write or list the access tab', async () => {
  await post('/staff/add', STAFF, { email: INTERN, name: 'Aina Rahman' });
  st.upstream.sheetsRequests = [];
  const sheets = (tool_: string, input: Record<string, unknown>) => tool(INTERN, { server: 'Google Sheets', tool: tool_, input: { spreadsheetId: SHEET_ID, ...input } });
  for (const range of ["'App access'!A1:E", 'App access!A2', "'app  ACCESS'!B3", 'AppAccess!A1']) {
    expect((await sheets('get_values', { range })).status).toBe(403);
    expect((await sheets('update_values', { range, values: [['friend@gmail.com', 'x', 'Active']] })).status).toBe(403);
  }
  for (const f of ["='App access'!A2", '=INDIRECT("App"&" access!A2")', '=IMPORTRANGE("x","y")', '+ app access!A1']) {
    const r = await sheets('update_values', { range: "'MYSense'!B6", values: [[f]] });
    expect(r.status, f).toBe(403);
  }
  expect(st.upstream.sheetsRequests).toEqual([]);
  // Ordinary text that merely mentions it is fine.
  expect((await sheets('update_values', { range: "'MYSense'!N6", values: [['asked about app access']] })).status).toBe(200);

  const list = await sheets('get_spreadsheet', { fields: ['sheets.properties.title', 'sheets.properties.sheetId'] });
  expect(list.status).toBe(200);
  const titles = list.body.payload.sheets.map((s: any) => s.properties.title);
  expect(titles).toContain('MYSense');
  expect(titles).not.toContain(TAB);
});

test('the privacy notice is public', async () => {
  const r = await get('/privacy', null);
  expect(r.status).toBe(200);
  expect(r.text).toContain('only your name and email address');
});
