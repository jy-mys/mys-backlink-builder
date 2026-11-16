import { test, expect, request as pwRequest } from '@playwright/test';
import { startStack, sessionCookie, CRON_SECRET, TAVILY_KEY, type Stack } from './helpers.js';

// Bulk competitor check: one Tavily search per in-scope site, limited to that site's domain.
// The mock Tavily finds Locus-T and Primal Malaysia on every site, plus one off-site result.

let st: Stack;
test.beforeAll(async () => { st = await startStack(); });
test.afterAll(async () => { await st.close(); });
test.beforeEach(async () => { st.upstream.reset(); (await import('../src/compcheck.js')).forgetUsage(); });

const STAFF = 'lead@mysense.com.my';
const INTERN = 'aina.intern@gmail.com';
const cookie = (email: string) => 'mbb=' + sessionCookie(st, { email, name: 'x' });
const tab = () => st.upstream.store.sheets.get('MYSense')!;
const today = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());

async function run(t: string, who: string | null = STAFF, origin: string | null = st.appUrl) {
  const ctx = await pwRequest.newContext();
  const headers: Record<string, string> = {};
  if (origin) headers.Origin = origin;
  if (who) headers.Cookie = cookie(who);
  const res = await ctx.post(st.appUrl + '/links/competitors', { headers, form: { tab: t }, maxRedirects: 0 });
  const out = { status: res.status(), text: await res.text() };
  await ctx.dispose();
  return out;
}

test('staff run a bulk competitor check that fills O–Q for every site', async () => {
  tab()[7][15] = today + ' · Aina'; // row 8 was checked today: skipped
  const r = await run('MYSense');
  expect(r.status).toBe(200);
  const rows = tab().slice(4).filter((x) => x[0]);
  const searched = st.upstream.tavily.length;
  expect(searched).toBe(rows.length - 1);
  expect(r.text).toContain(`Searched ${searched} sites: competitors found on ${searched}.`);
  expect(r.text).toContain('1 site was checked in the last 7 days and skipped.');
  // Every search is limited to one site, uses the server's key, and costs one basic search.
  for (const c of st.upstream.tavily) {
    expect(c.auth).toBe('Bearer ' + TAVILY_KEY);
    expect(c.body).toMatchObject({ search_depth: 'basic', max_results: 10 });
    expect(c.body.include_domains).toHaveLength(1);
    expect(c.body.query).toBe('"Locus-T" OR "locus-t.com.my" OR "Primal Malaysia" OR "primal.com.my"');
  }
  const row5 = tab()[4];
  expect(row5[14]).toBe('Locus-T, Primal Malaysia');
  expect(row5[15]).toBe(today + ' · auto check');
  const host = st.upstream.tavily.find((c) => c.body.include_domains[0])!.body.include_domains[0];
  expect(row5[16]).toMatch(/^Locus-T: https:\/\/\S+\/listing\/locus-t; Primal Malaysia: https:\/\/\S+\/listing\/primal$/);
  expect(row5[16]).not.toContain('elsewhere.example');
  expect(host).not.toMatch(/^www\./);
  // Row 7's earlier manual find is kept, with its evidence.
  expect(tab()[6][14]).toBe('Locus-T, Primal Malaysia');
  expect(tab()[6][16]).toContain('Locus-T: https://example.com/locus');
  // The skipped row is untouched.
  expect(tab()[7][15]).toBe(today + ' · Aina');
  expect(new Set(st.upstream.valueInputs)).toEqual(new Set(['RAW']));
  expect(r.text).not.toContain(TAVILY_KEY);
});

test('stops cleanly when the free searches run out', async () => {
  st.upstream.tavilyMode = 'quotaAfter2';
  const r = await run('MYSense');
  expect(r.status).toBe(200);
  expect(r.text).toContain("Stopped early: This month&#39;s free Tavily searches are used up.");
  expect(tab().slice(4).filter((x) => x[15]?.endsWith('· auto check'))).toHaveLength(2);
});

test('needs staff, our Origin, a listed client tab, and competitors in M1', async () => {
  expect((await run('MYSense', INTERN)).status).toBe(302); // not on the intern list
  await (await pwRequest.newContext()).post(st.appUrl + '/staff/add', { headers: { Origin: st.appUrl, Cookie: cookie(STAFF) }, form: { email: INTERN, name: 'Aina' } });
  expect((await run('MYSense', INTERN)).status).toBe(403);
  expect((await run('MYSense', STAFF, 'https://evil.example')).status).toBe(403);
  expect((await run('Sites')).status).toBe(400);
  const drTan = await run("Dr Tan's Clinic");
  expect(drTan.text).toContain('competitors in cell M1');
  expect(st.upstream.tavily).toEqual([]);
  // Interns see why the button isn't there for them.
  const ctx = await pwRequest.newContext();
  const view = await (await ctx.get(st.appUrl + '/links?tab=MYSense', { headers: { Cookie: cookie(INTERN) } })).text();
  const staffView = await (await ctx.get(st.appUrl + '/links?tab=MYSense', { headers: { Cookie: cookie(STAFF) } })).text();
  await ctx.dispose();
  expect(view).toContain('Staff can run this');
  expect(view).not.toContain('action="/links/competitors"');
  expect(staffView).toContain("Check competitors on all of MYSense's sites");
});

test('monthly endpoint checks every client with the cron secret only', async () => {
  const ctx = await pwRequest.newContext();
  const call = (auth?: string) => ctx.post(st.appUrl + '/api/cron/competitors', { headers: auth ? { Authorization: auth } : {} });
  expect((await call()).status()).toBe(401);
  const ok = await call('Bearer ' + CRON_SECRET);
  expect(ok.status()).toBe(200);
  const body = await ok.json();
  expect(body.clients[0]).toMatchObject({ tab: 'MYSense', withHits: st.upstream.tavily.length });
  expect(body.clients[1].message).toContain('cell M1');
  await ctx.dispose();
});

test('matches the full competitor name, not a word from it', async () => {
  const { nameRe } = await import('../src/compcheck.js');
  const primal = nameRe('Primal Malaysia');
  expect(primal.test('primal malaysia sdn bhd, kuala lumpur')).toBe(true);
  expect(primal.test('primal-malaysia digital')).toBe(true);
  expect(primal.test('the liver king and the primal diet')).toBe(false);
  expect(primal.test('fashion stylists in cyprus: primal studio')).toBe(false);
  expect(nameRe('Locus-T Sdn Bhd').test('locus-t is an agency')).toBe(true);
});

test('earlier automatic results are replaced; a person\'s finds and #REF! are handled', async () => {
  const g = tab();
  g[4][14] = 'Exabytes'; g[4][15] = '1 Nov 2026 · auto check'; g[4][16] = 'Exabytes: https://wrong.example/x'; // auto: replaced
  g[5][14] = '#REF!'; g[5][15] = '#REF!'; g[5][16] = '';                                                      // broken: ignored
  await run('MYSense');
  expect(g[4][14]).toBe('Locus-T, Primal Malaysia');
  expect(g[4][16]).not.toContain('wrong.example');
  expect(g[5][14]).toBe('Locus-T, Primal Malaysia');
  expect(g[6][14]).toBe('Locus-T, Primal Malaysia'); // row 7 had a person's find (Locus-T), kept with its evidence
  expect(g[6][16]).toContain('Locus-T: https://example.com/locus');
});

async function view(email = STAFF) {
  const ctx = await pwRequest.newContext();
  const t = await (await ctx.get(st.appUrl + '/links?tab=MYSense', { headers: { Cookie: cookie(email) } })).text();
  await ctx.dispose();
  return t;
}

test('the page shows this month\'s searches and what a check will cost', async () => {
  const sites = tab().slice(4).filter((x) => x[0]).length;
  const before = await view();
  expect(before).toContain('<b>Searches this month:</b> 0 used of 1,000, <b>1,000 left</b> (Tavily Researcher plan).');
  expect(before).toContain(`A check of MYSense now would use about <b>${sites}</b> searches.`);
  expect(before).toContain('This crawl is free and has no quota.');
  await run('MYSense');
  const after = await view();
  expect(after).toContain(`<b>Searches this month:</b> ${sites} used of 1,000, <b>${1000 - sites} left</b>`);
  // Everything was just checked, so another run now would search nothing.
  expect(after).toContain(`would use about <b>0</b> searches (${sites} sites checked in the last 7 days are skipped)`);
});

test('a check that would not fit in the searches left is refused before searching', async () => {
  st.upstream.tavilyUsedBefore = 995;
  const r = await run('MYSense');
  expect(r.text).toMatch(/This check needs about \d+ searches but only 5 of this month&#39;s 1,000 are left\. Nothing was searched\./);
  expect(st.upstream.tavily).toEqual([]);
});
