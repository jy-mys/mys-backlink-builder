import http from 'node:http';
import zlib from 'node:zlib';
import { test, expect, request as pwRequest } from '@playwright/test';
import { fetchPage, findLinks, isPrivateIp } from '../src/crawl.js';
import { startStack, sessionCookie, CRON_SECRET, type Stack } from './helpers.js';
import { SHEET_ID } from './fixtures/sheet.js';

// The live-link crawler opens each Live row's URL itself (no Firecrawl) and records whether the
// page still links to the client's website. Local pages stand in for the directories.

let st: Stack;
let sites: http.Server;
let base = '';
const PAGES: Record<string, (res: http.ServerResponse) => void> = {
  '/good': (r) => html(r, '<p>Agencies</p><a href="https://www.mysense.com.my/">MYSense</a>'),
  '/nofollow': (r) => html(r, '<a rel="nofollow noopener" href="//mysense.com.my/seo">site</a>'),
  '/sponsored': (r) => html(r, "<a href='https://blog.mysense.com.my' rel='sponsored'>x</a>"),
  '/mention': (r) => html(r, '<h1>MYSense Sdn Bhd</h1><p>Kuala Lumpur. Website: hidden for free plans.</p>'),
  '/absent': (r) => html(r, '<h1>Another agency</h1><a href="https://other.example/">other</a>'),
  '/gone': (r) => { r.writeHead(404, { 'Content-Type': 'text/html' }); r.end('missing'); },
  '/blocked': (r) => { r.writeHead(403, { 'Content-Type': 'text/html' }); r.end('no bots'); },
  '/redir': (r) => { r.writeHead(301, { Location: '/good' }); r.end(); },
  '/gz': (r) => { r.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' }); r.end(zlib.gzipSync('<a href="https://mysense.com.my">x</a>')); },
};
function html(r: http.ServerResponse, body: string) { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(`<!doctype html><html><body>${body}</body></html>`); }

test.beforeAll(async () => {
  st = await startStack();
  sites = http.createServer((req, res) => (PAGES[req.url || ''] || PAGES['/gone'])(res));
  await new Promise<void>((r) => sites.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(sites.address() as any).port}`;
});
test.afterAll(async () => { await st.close(); await new Promise((r) => sites.close(r)); });
test.beforeEach(() => st.upstream.reset());

const STAFF = 'lead@mysense.com.my';
const cookie = (email = STAFF) => 'mbb=' + sessionCookie(st, { email, name: 'Lead' });
const tab = () => st.upstream.store.sheets.get('MYSense')!;
const linkValue = (sid: string) => (st.upstream.store.sheets.get('Sites')!.find((r) => r[0] === sid) || [])[11] || '';

// Marks rows 5.. of MYSense Live with the given paths; returns row number -> path.
function setLive(paths: (string | null)[]) {
  const g = tab(), out: Record<number, string | null> = {};
  paths.forEach((p, i) => { const row = g[4 + i]; row[8] = 'Live'; row[9] = p === null ? '' : base + p; row[10] = ''; out[5 + i] = p; });
  return out;
}

async function crawl(t: string, origin: string | null = st.appUrl, who: string | null = STAFF) {
  const ctx = await pwRequest.newContext();
  const headers: Record<string, string> = {};
  if (origin) headers.Origin = origin;
  if (who) headers.Cookie = cookie(who);
  const res = await ctx.post(st.appUrl + '/links/crawl', { headers, form: { tab: t }, maxRedirects: 0 });
  const out = { status: res.status(), text: await res.text() };
  await ctx.dispose();
  return out;
}

test('crawl records each live link in the client tab', async () => {
  const paths = ['/good', '/nofollow', '/sponsored', '/mention', '/absent', '/gone', '/blocked', '/redir', '/gz', null];
  setLive(paths);
  const notLive = [...tab()[16]];
  const r = await crawl('MYSense');
  expect(r.status).toBe(200);
  const citation = /citation|no link/i.test(linkValue(tab()[7][0]));
  expect(r.text).toContain(`Checked 10 live links: ${citation ? 6 : 5} OK, ${citation ? 4 : 5} need a look.`);
  const row = (n: number) => tab()[n - 1];
  expect(tab()[3].slice(17, 19)).toEqual(['Crawl result', 'Crawled on']);
  expect(row(5).slice(10, 11)).toEqual(['Dofollow']);
  expect(row(5)[17]).toBe('OK: dofollow link to mysense.com.my.');
  expect(row(5)[18]).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4}$/);
  expect(row(6)[10]).toBe('Nofollow');
  expect(row(7)[10]).toBe('Sponsored');
  const mentionSid = row(8)[0];
  expect(row(8)[17]).toBe(/citation|no link/i.test(linkValue(mentionSid))
    ? 'OK: MYSense is listed (citation, no link expected).'
    : 'Listed, but no link to mysense.com.my found. Add the website to the listing if the site allows it.');
  expect(row(9)[17]).toMatch(/^MYSense \/ mysense\.com\.my not found on the page/);
  expect(row(9)[10]).toBe('');
  expect(row(10)[17]).toBe('Page error (HTTP 404). The listing may have been removed.');
  expect(row(11)[17]).toBe('The site blocked the crawler (HTTP 403). Open the link yourself to check.');
  expect(row(12)[10]).toBe('Dofollow');
  expect(row(13)[10]).toBe('Dofollow');
  expect(row(14)[17]).toBe('No live URL in column J to check.');
  // Rows that aren't Live are left alone, and everything is written as plain text in one batch.
  expect(tab()[16]).toEqual(notLive);
  expect(new Set(st.upstream.valueInputs)).toEqual(new Set(['RAW']));
  expect(st.upstream.sheetsRequests.filter((x) => x.method === 'POST' && x.path.includes('values:batchUpdate'))).toHaveLength(1);

  // The page shows the results.
  const ctx = await pwRequest.newContext();
  const view = await (await ctx.get(st.appUrl + '/links?tab=MYSense', { headers: { Cookie: cookie() } })).text();
  await ctx.dispose();
  expect(view).toContain('OK: dofollow link to mysense.com.my.');
  expect(view).toContain("Crawl MYSense's live links now");
});

test('a client tab without a website is not crawled', async () => {
  st.upstream.store.sheets.get("Dr Tan's Clinic")![4][8] = 'Live';
  const r = await crawl("Dr Tan's Clinic");
  expect(r.text).toContain('website in cell M3');
  expect(st.upstream.writes).toEqual([]);
});

test('crawl needs sign-in, our Origin, and a client tab from Summary', async () => {
  setLive(['/good']);
  expect((await crawl('MYSense', 'https://evil.example')).status).toBe(403);
  expect((await crawl('MYSense', null)).status).toBe(403);
  expect((await crawl('MYSense', st.appUrl, null)).status).toBe(302);
  expect((await crawl('MYSense', st.appUrl, 'random@gmail.com')).status).toBe(302);
  for (const t of ['App access', 'Sites', 'Summary', 'Client template']) expect((await crawl(t)).status).toBe(400);
  expect(st.upstream.writes).toEqual([]);
});

test('weekly endpoint crawls every client with the cron secret only', async () => {
  setLive(['/good']);
  const ctx = await pwRequest.newContext();
  const call = (auth?: string) => ctx.post(st.appUrl + '/api/cron/linkcheck', { headers: auth ? { Authorization: auth } : {} });
  expect((await call()).status()).toBe(401);
  expect((await call('Bearer wrong')).status()).toBe(401);
  const ok = await call('Bearer ' + CRON_SECRET);
  expect(ok.status()).toBe(200);
  const body = await ok.json();
  expect(body.clients.map((c: any) => c.tab)).toEqual(['MYSense', "Dr Tan's Clinic"]);
  expect(body.clients[0]).toMatchObject({ checked: 1, ok: 1, problems: 0 });
  expect(tab()[4][17]).toBe('OK: dofollow link to mysense.com.my.');
  await ctx.dispose();
});

test('the crawler refuses private and local addresses', async () => {
  const port = (sites.address() as any).port;
  for (const u of [`http://127.0.0.1:${port}/good`, `http://localhost:${port}/good`, 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/']) {
    const r = await fetchPage(u, { allowPrivate: false, timeoutMs: 3000 });
    expect(r.error, u).toMatch(/private address|unusual port/);
  }
  expect((await fetchPage('file:///etc/passwd')).error).toBe("isn't a web page address");
  expect(['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'].every(isPrivateIp)).toBe(true);
  expect(['8.8.8.8', '172.32.0.1', '2606:4700::1111'].some(isPrivateIp)).toBe(false);
  // Links to other sites, or to a look-alike domain, don't count.
  expect(findLinks('<a href="https://notmysense.com.my">x</a><a href="https://mysense.com.my.evil.example">y</a>', 'https://dir.example/', 'mysense.com.my', 'MYSense').links).toEqual([]);
});

test('everyone signed in gets a Check live links button for the chosen client', async ({ browser }) => {
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'mbb', value: sessionCookie(st, { email: 'lead@mysense.com.my', name: 'Lead' }), url: st.appUrl }]);
  const page = await ctx.newPage();
  await page.goto(st.appUrl);
  await page.waitForFunction(() => !!document.querySelector('#clientSel option[value="MYSense"]'));
  await page.selectOption('#clientSel', 'MYSense');
  await page.click('#mbbLinks');
  await expect(page).toHaveURL(/\/links\?tab=MYSense$/);
  await expect(page.locator('h1')).toHaveText('Live link check');
  await ctx.close();
});

test('a row marked "In progress" in the sheet shows as In progress in the app', async ({ browser }) => {
  tab()[5][8] = 'In progress';
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'mbb', value: sessionCookie(st, { email: STAFF, name: 'Lead' }), url: st.appUrl }]);
  const page = await ctx.newPage();
  await page.goto(st.appUrl);
  await page.waitForFunction(() => !!document.querySelector('#clientSel option[value="MYSense"]'));
  await page.selectOption('#clientSel', 'MYSense');
  await page.waitForFunction(() => /Connected to the Backlink Tracker sheet/.test(document.getElementById('sheetBar')!.textContent || ''));
  const sel = page.locator('select.stsel.st-prog');
  await expect(sel.first()).toHaveValue('prog');
  await expect(sel.first().locator('option:checked')).toHaveText('In progress');
  await ctx.close();
});

test('saving a row as Submitted fills Date submitted (column V) once', async () => {
  const today = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());
  const ctx = await pwRequest.newContext();
  const save = (range: string, status: string) => ctx.post(st.appUrl + '/api/tool', {
    headers: { 'Content-Type': 'application/json', Origin: st.appUrl, Cookie: cookie() },
    data: { server: 'Google Sheets', tool: 'update_values', input: { spreadsheetId: SHEET_ID, range, values: [[status, '', '', 'Aina', '', '']] } },
  });
  expect((await save("'MYSense'!I8:N8", 'Submitted')).status()).toBe(200);
  expect(tab()[7][21]).toBe(today);
  tab()[7][21] = '3 Nov 2026';
  await save("'MYSense'!I8:N8", 'Submitted'); // already dated: kept
  expect(tab()[7][21]).toBe('3 Nov 2026');
  await save("'MYSense'!I9:N9", 'Live');      // other statuses: no date
  expect(tab()[8][21] || '').toBe('');
  await save("'Dr Tan''s Clinic'!I5:N5", 'Submitted'); // quoted tab names work
  expect(st.upstream.store.sheets.get("Dr Tan's Clinic")![4][21]).toBe(today);
  await ctx.dispose();
});

test('the build table can be filtered by its columns', async ({ browser }) => {
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'mbb', value: sessionCookie(st, { email: STAFF, name: 'Lead' }), url: st.appUrl }]);
  const page = await ctx.newPage();
  await page.goto(st.appUrl);
  await page.waitForFunction(() => !!document.querySelector('#clientSel option[value="MYSense"]'));
  await page.selectOption('#clientSel', 'MYSense');
  await page.waitForFunction(() => /Connected to the Backlink Tracker sheet/.test(document.getElementById('sheetBar')!.textContent || ''));
  const visible = () => page.locator('#rows tr.r:visible');
  const total = await visible().count();
  expect(total).toBeGreaterThan(3);
  // One dropdown per category column, none for Site or Next step.
  const labels = await page.locator('.mbb-frow select').evaluateAll((s) => s.map((x) => x.getAttribute('data-mbbf')));
  expect(labels).toEqual(['Status', 'Who can do it', 'Priority', 'Cost', 'Link value']);

  const cost = page.locator('select[data-mbbf="Cost"]');
  const free = (await cost.locator('option').allTextContents()).find((t) => /^Free \(\d+\)$/.test(t))!;
  await cost.selectOption({ label: free });
  const n = Number(free.match(/\((\d+)\)/)![1]);
  await expect(visible()).toHaveCount(n);
  for (const t of await page.locator('#rows tr.r:visible td[data-l="Cost"]').allTextContents()) expect(t.trim()).toBe('Free');
  await expect(page.locator('#count')).toHaveText(new RegExp(`^Showing ${n} of \\d+ \\(filtered\\)$`));

  // Filters survive the page redrawing the table (here: the search box), and combine with it.
  await page.fill('#q', 'google');
  await expect(page.locator('select[data-mbbf="Cost"]')).toHaveValue('Free');
  for (const t of await page.locator('#rows tr.r:visible td[data-l="Cost"]').allTextContents()) expect(t.trim()).toBe('Free');
  await page.fill('#q', '');

  // A combination with no rows says so, and Clear filters brings everything back.
  await page.locator('select[data-mbbf="Status"]').selectOption({ index: 1 });
  await page.locator('select[data-mbbf="Cost"]').selectOption('Paid').catch(() => null);
  if (await visible().count() === 0) await expect(page.locator('.mbb-empty')).toContainText('No sites match these filters');
  await page.locator('.mbb-clear').first().click();
  await expect(visible()).toHaveCount(total);
  await expect(page.locator('#count')).not.toContainText('filtered');

  // The SEO view adds its own category columns.
  await page.check('#seoCk');
  const seo = await page.locator('.mbb-frow select').evaluateAll((s) => s.map((x) => x.getAttribute('data-mbbf')));
  expect(seo).toEqual(['Status', 'Who can do it', 'Priority', 'Cost', 'Link value', 'Verdict', 'Link type', 'MY traffic / mo', 'Spam risk']);
  await ctx.close();
});

test('the Start here list can be filtered by status, cost and link value', async ({ browser }) => {
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'mbb', value: sessionCookie(st, { email: STAFF, name: 'Lead' }), url: st.appUrl }]);
  const page = await ctx.newPage();
  await page.goto(st.appUrl);
  await page.waitForFunction(() => !!document.querySelector('#clientSel option[value="MYSense"]'));
  await page.selectOption('#clientSel', 'MYSense');
  await page.waitForFunction(() => /Connected to the Backlink Tracker sheet/.test(document.getElementById('sheetBar')!.textContent || ''));
  const cards = () => page.locator('#startList li:has(input[data-start]):visible');
  const total = await cards().count();
  expect(total).toBeGreaterThan(2);
  expect(await page.locator('#mbbStartBar select').evaluateAll((s) => s.map((x) => x.getAttribute('data-mbbs')))).toEqual(['Status', 'Cost', 'Link value']);

  // Link value: options come from the Sites tab, with counts that add up to the list.
  const link = page.locator('select[data-mbbs="Link value"]');
  const opts = (await link.locator('option').allTextContents()).slice(1);
  expect(opts.reduce((n, t) => n + Number(t.match(/\((\d+)\)$/)![1]), 0)).toBe(total);
  const first = opts[0].replace(/ \(\d+\)$/, ''), n = Number(opts[0].match(/\((\d+)\)$/)![1]);
  await link.selectOption(first);
  await expect(cards()).toHaveCount(n);

  // Status follows the tick box: tick the first card (marks it Live), then filter on Live.
  await page.locator('.mbb-sclear').click();
  await expect(cards()).toHaveCount(total);
  const firstBox = page.locator('#startList input[data-start]').first();
  const sid = await firstBox.getAttribute('data-start');
  await firstBox.check();
  await page.waitForFunction(() => /Saved/.test(document.getElementById('toast')!.textContent || ''));
  await page.locator('select[data-mbbs="Status"]').selectOption('Live');
  await expect(page.locator(`#startList li:visible input[data-start="${sid}"]`)).toHaveCount(1);
  for (const box of await page.locator('#startList li:visible input[data-start]').all()) await expect(box).toBeChecked();

  // No match says so.
  await page.locator('select[data-mbbs="Link value"]').selectOption({ index: (await link.locator('option').count()) - 1 });
  if (await cards().count() === 0) await expect(page.locator('.mbb-snone')).toBeVisible();
  await ctx.close();
});
