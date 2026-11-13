import { test, expect, type Browser, type Page } from '@playwright/test';
import { startStack, signIn, prepare, settle, pickClient, type Stack } from './helpers.js';
import { BUILD_SITES, ROW69_SID, ROW70_SID } from './fixtures/sheet.js';

// Each flow runs twice, once on the original artifact (mock window.claude) and once on the
// web app (real backend, mock Google), from the same fixture. Both must write exactly the
// same ranges and values, and those must equal what's asserted here.

let st: Stack;
test.beforeAll(async () => { st = await startStack(); });
test.afterAll(async () => { await st.close(); });

const TODAY = '29 Oct 2026';
const ME = 'Test Intern';
const sid = (i: number) => BUILD_SITES[i].sid as string;
const host = (s: any) => String(s.dom).toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#\s]/)[0].replace(/^business\./, '');
const q = (s: string) => JSON.stringify(s); // CSS attribute value

async function both(browser: Browser, flow: (page: Page) => Promise<void>) {
  const out: Record<string, unknown[]> = {};
  for (const target of ['original', 'app'] as const) {
    st.upstream.reset();
    const context = await browser.newContext();
    await signIn(context, st);
    const page = await context.newPage();
    await prepare(page);
    await page.goto(target === 'app' ? st.appUrl : st.originalUrl);
    await settle(page);
    await flow(page);
    await page.waitForLoadState('networkidle');
    out[target] = st.upstream.writes.map((w) => ({ ...w }));
    await context.close();
  }
  expect(out.app, 'web app writes the same as the artifact').toEqual(out.original);
  return out.app;
}

const waitWrites = (n: number) => expect.poll(() => st.upstream.writes.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(n);

test('load clients, then pick a client', async ({ browser }) => {
  const writes = await both(browser, async (page) => {
    await expect(page.locator('#clientSel option')).toHaveText(['Choose a client', 'MYSense', "Dr Tan's Clinic"]);
    await pickClient(page, "Dr Tan's Clinic");
    await expect(page.locator('#lead')).toContainText("Dr Tan's Clinic (Healthcare)");
    await pickClient(page, 'MYSense');
    await expect(page.locator('#lead')).toContainText('MYSense (Professional & B2B Services): 1 of 76 sites live');
    await expect(page.locator('#ind')).toHaveValue('Professional & B2B Services');
    await expect(page.locator('#comps')).toHaveValue('Locus-T (locus-t.com.my), Primal Malaysia (primal.com.my)');
    await expect(page.locator('#tabLink')).toHaveAttribute('href', /#gid=1002$/);
  });
  expect(writes).toEqual([]);
  // The apostrophe tab name reached Sheets quoted, exactly as the page built it.
  expect(st.upstream.sheetsRequests.map((r) => decodeURIComponent(r.path))).toContain("/v4/spreadsheets/1KcJjTGJpxOQVsfkdMFpZ6sIfEWGWtMj0kcm8eWyLkZ0/values/'Dr Tan''s Clinic'!A1:Q");
});

test('change a status; marking Live asks for the URL and fills the date', async ({ browser }) => {
  const s8 = sid(3), s9 = sid(4);
  const writes = await both(browser, async (page) => {
    await pickClient(page, 'MYSense');
    await page.selectOption(`[data-status=${q(s8)}]`, 'sub');
    await waitWrites(1);
    await page.selectOption(`[data-status=${q(s9)}]`, 'live');
    await expect(page.locator('#toast')).toHaveText('Paste the live listing URL, then click Save to sheet.');
    const url = page.locator(`[id=${q('url-' + s9)}]`);
    await expect(url).toBeFocused();
    await url.fill('https://directory.example/mysense');
    await page.click(`[data-save=${q(s9)}]`);
    await waitWrites(2);
    await expect(page.locator('#toast')).toHaveText('Saved to the sheet. Marked live.');
  });
  expect(writes).toEqual([
    { range: "'MYSense'!I8:N8", values: [['Submitted', '', '', ME, '', '']] },
    { range: "'MYSense'!I9:N9", values: [['Live', 'https://directory.example/mysense', '', ME, TODAY, '']] },
  ]);
});

test('save the detail row', async ({ browser }) => {
  const s6 = sid(1);
  const writes = await both(browser, async (page) => {
    await pickClient(page, 'MYSense');
    await page.click(`[data-toggle=${q(s6)}]`);
    await page.selectOption(`[id=${q('lk-' + s6)}]`, 'Dofollow');
    await page.fill(`[id=${q('bl-' + s6)}]`, '');
    await page.click(`[data-save=${q(s6)}]`);
    await waitWrites(1);
  });
  expect(writes).toEqual([{ range: "'MYSense'!I6:N6", values: [['Submitted', '', 'Dofollow', 'Aina', '', '']] }]);
});

test('add a site to a tab', async ({ browser }) => {
  const extra = BUILD_SITES.slice(66).find((s) => s.inds.core || s.inds.all || s.inds['Professional & B2B Services']).sid as string;
  const writes = await both(browser, async (page) => {
    await pickClient(page, 'MYSense');
    await page.click(`button.addtab[data-addtab=${q(extra)}]`);
    await waitWrites(2);
    await expect(page.locator(`[data-status=${q(extra)}]`)).toHaveValue('none');
  });
  expect(writes).toEqual([
    { range: "'MYSense'!A71", values: [[extra]] },
    { range: "'MYSense'!I71", values: [['Not started']] },
  ]);
});

test('save the kit, competitors and website', async ({ browser }) => {
  const writes = await both(browser, async (page) => {
    await pickClient(page, 'MYSense');
    await page.check('[data-kit="address"]');
    await waitWrites(1);
    await page.fill('#comps', 'Locus-T (locus-t.com.my), Primal Malaysia (primal.com.my), Kinetic (kinetic.com.my)');
    await page.press('#comps', 'Tab');
    await waitWrites(2);
    await page.click('.gapimp summary');
    await page.fill('#gapSite', 'https://www.mysense.my/');
    await page.press("#gapSite", "Tab");
    await waitWrites(3);
  });
  expect(writes).toEqual([
    { range: "'MYSense'!M2", values: [['Exact business name; Full address with postcode; +60 phone number']] },
    { range: "'MYSense'!M1", values: [['Locus-T (locus-t.com.my), Primal Malaysia (primal.com.my), Kinetic (kinetic.com.my)']] },
    { range: "'MYSense'!M3", values: [['mysense.my']] },
  ]);
});

test('import a Competitor gap paste, then set a decision', async ({ browser }) => {
  const csv = [
    'Domain,Authority Score,mysense.com.my,locus-t.com.my,primal.com.my',
    'newsite.com.my,40,0,3,2',
    'another.my,25,0,1,1',
    'weak.my,5,0,1,1',
    'have.my,50,4,1,1',
    'digitalnewsasia.com,52,0,1,1',
    'one.my,30,0,1,0',
  ].join('\n');
  const writes = await both(browser, async (page) => {
    await pickClient(page, 'MYSense');
    await page.click('.gapimp summary');
    await page.fill('#gapPaste', csv);
    await page.click('#gapImport');
    await waitWrites(2);
    await expect(page.locator('#toast')).toHaveText('Imported 2 new opportunities. 1 the client already has. 1 already listed. 2 below the filters.');
    await page.selectOption('[data-gaprow="6"]', 'Outreach target');
    await waitWrites(3);
    await expect(page.locator('#toast')).toHaveText('Decision saved to the sheet.');
  });
  expect(writes).toEqual([
    { range: "'Competitor gap'!A6:G7", values: [
      ['MYSense', 'newsite.com.my', 2, 'Locus-T, Primal Malaysia', 40, 'Semrush export', TODAY],
      ['MYSense', 'another.my', 2, 'Locus-T, Primal Malaysia', 25, 'Semrush export', TODAY],
    ] },
    { range: "'Competitor gap'!I6:I7", values: [['New'], ['New']] },
    { range: "'Competitor gap'!I6:J6", values: [['Outreach target', ME]] },
  ]);
});

test('competitor Check: automatic search, untick one, save; then None found', async ({ browser }) => {
  const site69 = BUILD_SITES[64];
  const writes = await both(browser, async (page) => {
    await pickClient(page, 'MYSense');
    await page.click(`button.ckbtn[data-check=${q(ROW69_SID)}]`);
    await page.click(`[data-autocheck=${q(ROW69_SID)}]`);
    await expect(page.locator('tr.ck .ckmsg').first()).toHaveText('Found 2 of 2 in search results. Open the links to confirm, untick any wrong match, then save.');
    await page.uncheck(`[data-ckmark=${q(ROW69_SID)}][data-cname="Primal Malaysia"]`);
    await page.click(`[data-savecheck=${q(ROW69_SID)}]`);
    await waitWrites(1);
    await expect(page.locator('#toast')).toHaveText('Saved: Locus-T on this site.');
    await page.click(`button.ckbtn[data-check=${q(ROW70_SID)}]`);
    await page.click(`[data-savecheck=${q(ROW70_SID)}]`);
    await waitWrites(2);
    await expect(page.locator('#toast')).toHaveText('Saved as None found.');
  });
  expect(writes).toEqual([
    { range: "'MYSense'!O69:Q69", values: [['Locus-T', `${TODAY} · ${ME}`, `Locus-T: https://${host(site69)}/listing/locus-t`]] },
    { range: "'MYSense'!O70:Q70", values: [['None found', `${TODAY} · ${ME}`, '']] },
  ]);
});
