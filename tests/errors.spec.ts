import { test, expect, type Page } from '@playwright/test';
import { startStack, signIn, sessionCookie, prepare, settle, pickClient, type Stack } from './helpers.js';
import { SA_EMAIL } from './mocks/upstream.js';
import { ROW69_SID } from './fixtures/sheet.js';

let st: Stack;
test.beforeAll(async () => { st = await startStack(); });
test.afterAll(async () => { await st.close(); });
test.beforeEach(() => st.upstream.reset());

const bar = (page: Page) => page.locator('#sheetBar');

test('expired service-account token: refreshed and retried without the user noticing', async ({ page, context }) => {
  st.upstream.mode.sheets = 'expireOnce';
  await signIn(context, st);
  await prepare(page);
  await page.goto(st.appUrl);
  await settle(page);
  await expect(bar(page)).toContainText('Connected to the Backlink Tracker sheet.');
  expect(st.upstream.issuedSaTokens.length).toBeGreaterThanOrEqual(2);
});

test('service-account credentials unavailable: not-set-up message with Retry', async ({ browser }) => {
  const down = await startStack({ credentials: 'metadata' });
  try {
    down.upstream.mode.saToken = 'down';
    const context = await browser.newContext();
    await signIn(context, down);
    const page = await context.newPage();
    await prepare(page);
    await page.goto(down.appUrl);
    await settle(page);
    await expect(bar(page).locator('span').first()).toHaveText("Google Sheets isn't set up for this app yet. Ask an admin to finish setup, then click Retry. Until then you can browse the list, but progress won't load or save.");
    await expect(bar(page).locator('#retryBtn')).toBeVisible();
    down.upstream.mode.saToken = 'ok';
    await page.click('#retryBtn');
    await settle(page);
    await expect(bar(page)).toContainText('Connected to the Backlink Tracker sheet.');
    await context.close();
  } finally {
    await down.close();
  }
});

test('expired session: the page sends you to Google sign-in', async ({ request }) => {
  const res = await request.get(st.appUrl + '/', { headers: { Cookie: 'mbb=' + sessionCookie(st, { iat: Date.now() - 8 * 24 * 3600_000 }) }, maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers().location).toBe('/auth/login');
});

test('sheet not shared with the service account: tool_error naming its email', async ({ page, context }) => {
  st.upstream.mode.sheets = 'forbidden';
  await signIn(context, st);
  await prepare(page);
  await page.goto(st.appUrl);
  await settle(page);
  await expect(bar(page).locator('span').first()).toHaveText(`Google Sheets refused the request. Check the Backlink Tracker sheet is shared with this app. (The sheet must be shared with the app's service account ${SA_EMAIL} as Editor. Google said: The caller does not have permission)`);
  await expect(bar(page).locator('#retryBtn')).toBeVisible();
});

test('Sheets 429: retried once, then the retry message; Retry recovers', async ({ page, context }) => {
  st.upstream.mode.sheets = 'rate';
  await signIn(context, st);
  await prepare(page);
  await page.goto(st.appUrl);
  await settle(page);
  await expect(bar(page).locator('span').first()).toHaveText("Couldn't reach Google Sheets right now (server_unavailable). Click Retry in a moment.");
  // Summary + Sites each tried twice (first attempt + the page's one retry).
  const summary = st.upstream.sheetsRequests.filter((r) => decodeURIComponent(r.path).endsWith('Summary!A5:C34'));
  expect(summary.length).toBe(2);
  st.upstream.mode.sheets = 'ok';
  await page.click('#retryBtn');
  await settle(page);
  await expect(bar(page)).toContainText('Connected to the Backlink Tracker sheet.');
});

test('signed out mid-session: not_granted message, no Retry', async ({ page, context }) => {
  await signIn(context, st);
  await prepare(page);
  await page.goto(st.appUrl);
  await settle(page);
  await context.clearCookies();
  await page.click('#refreshBtn');
  await settle(page);
  await expect(bar(page).locator('span').first()).toHaveText("You're not signed in. Reload the page to sign in with Google and load clients from the sheet.");
  await expect(bar(page).locator('#retryBtn')).toHaveCount(0);
});

async function openCheck(page: Page) {
  await pickClient(page, 'MYSense');
  await page.click(`button.ckbtn[data-check=${JSON.stringify(ROW69_SID)}]`);
  await page.click(`[data-autocheck=${JSON.stringify(ROW69_SID)}]`);
  return page.locator('tr.ck .ckmsg').first();
}

test('Firecrawl out of credits: out-of-credits message', async ({ page, context }) => {
  st.upstream.mode.firecrawl = 'credits';
  await signIn(context, st);
  await prepare(page);
  await page.goto(st.appUrl);
  await settle(page);
  const msg = await openCheck(page);
  await expect(msg).toHaveText('Automatic search is out of Firecrawl credits. Use the Google links below, or ask a lead to top up Firecrawl.');
  await expect(msg).toHaveClass(/warn/);
});

test('Firecrawl not configured: use-the-Google-links fallback', async ({ browser }) => {
  const noKey = await startStack({ firecrawlKey: '' });
  try {
    const context = await browser.newContext();
    await signIn(context, noKey);
    const page = await context.newPage();
    await prepare(page);
    await page.goto(noKey.appUrl);
    await settle(page);
    const msg = await openCheck(page);
    await expect(msg).toHaveText("Automatic search needs the Firecrawl connector, and it isn't available for you. Use the Google links below instead.");
    await expect(page.locator('tr.ck a', { hasText: 'Search Google ↗' }).first()).toBeVisible();
    expect(noKey.upstream.searches).toEqual([]);
    await context.close();
  } finally {
    await noKey.close();
  }
});
