import crypto from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import type { AccessList } from './access.js';
import type { Config } from './config.js';
import { bareHost, bestRel, fetchPage, findLinks } from './crawl.js';
import { escapeHtml, page } from './html.js';
import { checkOrigin } from './security.js';
import { getSession } from './session.js';
import * as sheets from './sheets.js';

// Live-link crawl: for one client tab, open every row marked Live and check the page still
// links to the client's website. Writes the rel type to "Link checked" (K) and a plain-English
// result to "Crawl result" (R) and "Crawled on" (S). No third-party crawler is used.

const FIRST_ROW = 5;
const RESULT_HEADER = ['Crawl result', 'Crawled on'];
const NEED_COLS = 19; // A..S
const CONCURRENCY = 4;

export interface RowResult { row: number; sid: string; site: string; url: string; linkChecked: string; result: string; ok: boolean }
export interface CrawlSummary { tab: string; checked: number; ok: number; problems: number; rows: RowResult[]; message?: string }

const today = () => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());
export const tabRef = (tab: string) => "'" + tab.replace(/'/g, "''") + "'";

// Client tabs are the ones listed on Summary (A5:A34). Only those can be crawled or written.
export async function clientTabs(cfg: Config): Promise<string[]> {
  const v = (await sheets.getValues(cfg, cfg.sa, 'Summary!A5:A34')).values as string[][];
  return v.map((r) => String(r[0] || '').trim()).filter(Boolean);
}

async function ensureColumns(cfg: Config, tab: string) {
  const meta: any = await sheets.getSpreadsheet(cfg, cfg.sa, ['sheets.properties.title', 'sheets.properties.sheetId', 'sheets.properties.gridProperties.columnCount']);
  const p = (meta.sheets || []).map((s: any) => s.properties).find((x: any) => x?.title === tab);
  const have = p?.gridProperties?.columnCount;
  if (p && typeof have === 'number' && have < NEED_COLS) await sheets.appendColumns(cfg, cfg.sa, p.sheetId, NEED_COLS - have);
}

async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

export async function crawlClient(cfg: Config, tab: string): Promise<CrawlSummary> {
  const ref = tabRef(tab);
  const vals = (await sheets.getValues(cfg, cfg.sa, ref + '!A1:S')).values as string[][];
  const name = String(vals[0]?.[1] || tab).trim();
  const website = String(vals[2]?.[12] || '').trim();
  const domain = bareHost(website.replace(/^https?:\/\//i, '').split('/')[0] || '');
  if (!domain) return { tab, checked: 0, ok: 0, problems: 0, rows: [], message: `Add ${name}'s website in cell M3 of their tab first, so the crawler knows which links to look for.` };

  const siteNames: Record<string, string> = {};
  const linkValue: Record<string, string> = {};
  for (const r of (await sheets.getValues(cfg, cfg.sa, 'Sites!A2:L')).values as string[][]) {
    if (r[0]) { siteNames[r[0]] = r[1] || r[0]; linkValue[r[0]] = r[11] || ''; }
  }
  const live = vals.map((r, i) => ({ r: r || [], row: i + 1 })).filter((x) => x.row >= FIRST_ROW && x.r[0] && /^live$/i.test(String(x.r[8] || '').trim()));
  const allow = !!cfg.crawlAllowPrivate;

  const rows = await mapLimit(live, CONCURRENCY, async ({ r, row }): Promise<RowResult> => {
    const sid = String(r[0]), url = String(r[9] || '').trim();
    const base = { row, sid, site: String(r[1] || siteNames[sid] || sid), url, linkChecked: String(r[10] || '') };
    if (!url) return { ...base, result: 'No live URL in column J to check.', ok: false };
    const p = await fetchPage(url, { allowPrivate: allow });
    if (p.error) return { ...base, result: `Couldn't open the page: it ${p.error}.`, ok: false };
    if (p.status! >= 400) {
      const blocked = [401, 403, 429, 503].includes(p.status!);
      return { ...base, result: blocked ? `The site blocked the crawler (HTTP ${p.status}). Open the link yourself to check.` : `Page error (HTTP ${p.status}). The listing may have been removed.`, ok: false };
    }
    const f = findLinks(p.html || '', p.finalUrl || url, domain, name);
    const rel = bestRel(f.links);
    if (rel) return { ...base, linkChecked: rel, result: `OK: ${rel.toLowerCase()} link to ${domain}.`, ok: true };
    if (f.mentioned && /citation|no link/i.test(linkValue[sid] || '')) return { ...base, linkChecked: 'Citation (no link)', result: `OK: ${name} is listed (citation, no link expected).`, ok: true };
    if (f.mentioned) return { ...base, result: `Listed, but no link to ${domain} found. Add the website to the listing if the site allows it.`, ok: false };
    return { ...base, result: `${name} / ${domain} not found on the page. It may load by script or need a login; open it to check.`, ok: false };
  });

  if (rows.length) {
    await ensureColumns(cfg, tab);
    const date = today();
    if (!vals[3]?.[17]) await sheets.updateValues(cfg, cfg.sa, `${ref}!R4:S4`, [RESULT_HEADER], 'RAW');
    // Re-read column A so a row that moved since the crawl started is never written to.
    const ids = ((await sheets.getValues(cfg, cfg.sa, `${ref}!A1:A`)).values as string[][]).map((x) => String(x?.[0] || ''));
    const data: { range: string; values: string[][] }[] = [];
    for (const x of rows) {
      if (ids[x.row - 1] !== x.sid) continue;
      data.push({ range: `${ref}!R${x.row}:S${x.row}`, values: [[x.result, date]] });
      if (x.linkChecked && x.linkChecked !== String(vals[x.row - 1]?.[10] || '')) data.push({ range: `${ref}!K${x.row}`, values: [[x.linkChecked]] });
    }
    if (data.length) await sheets.batchUpdateValues(cfg, cfg.sa, data, 'RAW');
  }
  const ok = rows.filter((x) => x.ok).length;
  return { tab, checked: rows.length, ok, problems: rows.length - ok, rows };
}

const running = new Set<string>();
async function crawlOnce(cfg: Config, tab: string) {
  if (running.has(tab)) return { tab, checked: 0, ok: 0, problems: 0, rows: [], message: 'A crawl of this client is already running. Wait a minute and reload.' } as CrawlSummary;
  running.add(tab);
  try { return await crawlClient(cfg, tab); } finally { running.delete(tab); }
}

export function linksRouter(cfg: Config, access: AccessList): Router {
  const r = Router();
  r.use(express.urlencoded({ extended: false, limit: '10kb' }));

  async function who(req: Request, res: Response): Promise<boolean> {
    const s = getSession(cfg, req);
    if (!s) { res.redirect(302, '/auth/login'); return false; }
    let role = null;
    try { role = await access.role(s.email); } catch { page(res, 503, 'Try again', "<p>Couldn't check your access just now. Reload in a moment.</p>"); return false; }
    if (!role) { res.redirect(302, '/auth/login'); return false; }
    return true;
  }

  async function render(res: Response, status: number, tab: string, tabs: string[], note = '', err = false) {
    let body = '';
    if (tab) {
      try {
        const v = (await sheets.getValues(cfg, cfg.sa, tabRef(tab) + '!A1:S')).values as string[][];
        const live = v.map((row, i) => ({ row: row || [], n: i + 1 })).filter((x) => x.n >= FIRST_ROW && x.row[0] && /^live$/i.test(String(x.row[8] || '').trim()));
        body = live.length
          ? `<table><thead><tr><th>Site</th><th>Link checked</th><th>Crawl result</th><th>Crawled on</th></tr></thead><tbody>` +
            live.map(({ row }) => {
              const url = String(row[9] || '');
              const site = escapeHtml(String(row[1] || row[0]));
              return `<tr><td>${/^https?:\/\//i.test(url) ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${site} ↗</a>` : site}</td>` +
                `<td>${escapeHtml(String(row[10] || '')) || '<span class="note">-</span>'}</td><td>${escapeHtml(String(row[17] || '')) || '<span class="note">Not crawled yet</span>'}</td>` +
                `<td class="note">${escapeHtml(String(row[18] || ''))}</td></tr>`;
            }).join('') + '</tbody></table>'
          : `<p class="note">No sites are marked Live on ${escapeHtml(tab)}'s tab yet.</p>`;
      } catch { note = "Couldn't read that client's tab from the sheet. Try again in a moment."; err = true; }
    }
    page(res, status, 'Live link check',
      (note ? `<p class="msg${err ? ' err' : ''}">${escapeHtml(note)}</p>` : '') +
      `<p>Opens every site marked <b>Live</b> on a client's tab and checks the page still links to the client's website. ` +
      `Results go into the client's tab: <b>Link checked</b> (column K), <b>Crawl result</b> (R) and <b>Crawled on</b> (S). It also runs by itself every week.</p>` +
      `<form method="get" action="/links" class="add" style="grid-template-columns:1fr auto"><div><label for="tab">Client</label>` +
      `<select id="tab" name="tab" style="font:inherit;padding:6px 8px;border:1px solid #bbb;border-radius:6px;width:100%">` +
      tabs.map((t) => `<option value="${escapeHtml(t)}"${t === tab ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('') +
      `</select></div><div><button type="submit">Show</button></div></form>` +
      (tab ? `<form method="post" action="/links/crawl" style="margin:16px 0"><input type="hidden" name="tab" value="${escapeHtml(tab)}">` +
        `<button type="submit" class="primary">Crawl ${escapeHtml(tab)}'s live links now</button> <span class="note">Takes up to a minute.</span></form>` : '') +
      body + `<p style="margin-top:32px"><a href="/">Back to the Backlink Builder</a></p>`, true);
  }

  r.get('/', async (req, res) => {
    if (!(await who(req, res))) return;
    let tabs: string[] = [];
    try { tabs = await clientTabs(cfg); } catch { return page(res, 502, 'Live link check', "<p>Couldn't read the client list from the sheet. Try again in a moment.</p>"); }
    const want = String(req.query.tab || '');
    await render(res, 200, tabs.includes(want) ? want : tabs[0] || '', tabs);
  });

  r.post('/crawl', async (req, res) => {
    if (!checkOrigin(cfg, req)) return page(res, 403, 'Not allowed', '<p>Cross-site request blocked.</p>');
    if (!(await who(req, res))) return;
    let tabs: string[] = [];
    try { tabs = await clientTabs(cfg); } catch { return page(res, 502, 'Live link check', "<p>Couldn't read the client list from the sheet. Try again in a moment.</p>"); }
    const tab = String(req.body?.tab || '');
    if (!tabs.includes(tab)) return render(res, 400, tabs[0] || '', tabs, 'Pick a client from the list.', true);
    try {
      const s = await crawlOnce(cfg, tab);
      const msg = s.message || (s.checked ? `Checked ${s.checked} live link${s.checked === 1 ? '' : 's'}: ${s.ok} OK, ${s.problems} need a look.` : 'No sites are marked Live yet, so there was nothing to crawl.');
      await render(res, 200, tab, tabs, msg, !!s.message);
    } catch {
      await render(res, 502, tab, tabs, "The crawl couldn't save to the sheet. Nothing may have changed; try again.", true);
    }
  });
  return r;
}

// POST /api/cron/linkcheck with "Authorization: Bearer <CRON_SECRET>": crawl every client.
// Called weekly by .github/workflows/weekly-link-check.yml. Off unless CRON_SECRET is set.
export function cronRouter(cfg: Config): Router {
  const r = Router();
  r.post('/linkcheck', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!cfg.cronSecret) return res.status(404).json({ error: 'not configured' });
    const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(cfg.cronSecret);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.status(401).json({ error: 'unauthorized' });
    try {
      const out = [];
      for (const tab of await clientTabs(cfg)) {
        try { const s = await crawlOnce(cfg, tab); out.push({ tab, checked: s.checked, ok: s.ok, problems: s.problems, message: s.message }); }
        catch (e) { out.push({ tab, error: (e as Error).message }); }
      }
      res.json({ clients: out });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });
  return r;
}
