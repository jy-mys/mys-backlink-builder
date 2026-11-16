import type { Config } from './config.js';
import { ToolError } from './errors.js';
import * as sheets from './sheets.js';

// Bulk competitor check: for every in-scope site on a client's tab, one Tavily search limited
// to that site's domain, looking for the client's competitors (cell M1). Results go into the
// columns the page already uses: Competitors found (O), Checked on (P), Evidence (Q).
// Tavily's free plan gives 1,000 searches a month; sites checked in the last 7 days are skipped.

const FIRST_ROW = 5;
const SKIP_DAYS = 7;
const CONCURRENCY = 2;

export interface CompSummary { tab: string; searched: number; skipped: number; withHits: number; message?: string; stoppedEarly?: string }

interface Comp { name: string; dom: string }
interface Hit { url: string; text: string }

const low = (s: unknown) => String(s ?? '').trim().toLowerCase();
const normDom = (x: string) => low(x).replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#\s]/)[0].replace(/\.$/, '');
const isDom = (x: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(x);
const today = () => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());
const tabRef = (tab: string) => "'" + tab.replace(/'/g, "''") + "'";

export function parseComps(raw: string): Comp[] {
  return String(raw || '').split(',').map((x) => x.trim()).filter(Boolean).map((item) => {
    const m = item.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (m) return { name: m[1].trim() || m[2].trim(), dom: normDom(m[2]) };
    const d = normDom(item);
    return isDom(d) ? { name: item, dom: d } : { name: item, dom: '' };
  });
}

// The competitor's full name (legal suffixes like Sdn Bhd optional). Words like "Malaysia" stay
// in: dropping them made "Primal Malaysia" match any page saying "primal".
export function nameRe(name: string) {
  const core = name.replace(/\b(sdn\.? bhd\.?|berhad|bhd|plc|ltd|limited)\b\.?/gi, '').trim() || name;
  return new RegExp('(^|[^a-z0-9])' + core.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]*') + '([^a-z0-9]|$)', 'i');
}
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

export async function tavilySearch(cfg: Config, query: string, host: string): Promise<Hit[]> {
  for (let attempt = 0; ; attempt++) {
    let res: globalThis.Response;
    try {
      res = await fetch(cfg.tavilyBase + '/search', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cfg.tavilyKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, search_depth: 'basic', max_results: 10, include_domains: [host] }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ToolError('upstream_error', "Couldn't reach Tavily", 502, true);
    }
    if (res.status === 429 && attempt < 2) { await new Promise((r) => setTimeout(r, 5000)); continue; }
    if (res.status === 401) throw new ToolError('not_granted', 'The Tavily API key is wrong or expired. Check TAVILY_API_KEY in Render.', 401);
    if (res.status === 432 || res.status === 433) throw new ToolError('rate_limited', "This month's free Tavily searches are used up. The check carries on next month.", 429);
    if (!res.ok) throw new ToolError('upstream_error', `Tavily answered HTTP ${res.status}`, 502, true);
    const d = (await res.json().catch(() => ({}))) as { results?: { url?: string; title?: string; content?: string }[] };
    return (d.results || []).filter((r) => typeof r.url === 'string' && /^https?:\/\//.test(r.url))
      .map((r) => ({ url: r.url!, text: [r.title, r.content, r.url].filter(Boolean).join(' ') }));
  }
}

export const AUTO = 'auto check';

export async function checkCompetitors(cfg: Config, tab: string, opts: { skipDays?: number } = {}): Promise<CompSummary> {
  const skipDays = opts.skipDays ?? SKIP_DAYS;
  const ref = tabRef(tab);
  const vals = (await sheets.getValues(cfg, cfg.sa, ref + '!A1:Q')).values as string[][];
  const name = String(vals[0]?.[1] || tab).trim();
  const comps = parseComps(String(vals[0]?.[12] || ''));
  if (!comps.length) return { tab, searched: 0, skipped: 0, withHits: 0, message: `Add ${name}'s competitors in cell M1 of their tab first, as Name (domain), separated by commas.` };

  const hostBySid: Record<string, string> = {};
  for (const r of (await sheets.getValues(cfg, cfg.sa, 'Sites!A2:C')).values as string[][]) {
    if (r[0] && r[2]) hostBySid[r[0]] = normDom(r[2]).replace(/^business\./, '');
  }
  const cutoff = Date.now() - skipDays * 86_400_000;
  const rows: { row: number; sid: string; host: string; r: string[] }[] = [];
  let skipped = 0;
  vals.forEach((r, i) => {
    const row = i + 1, sid = String(r?.[0] || '');
    if (row < FIRST_ROW || !sid || !hostBySid[sid]) return;
    if (low(r[2]) === 'no' || /not applicable/i.test(String(r[8] || ''))) return;
    const last = Date.parse(String(r[15] || '').split(' · ')[0]);
    if (skipDays > 0 && !isNaN(last) && last >= cutoff) { skipped++; return; }
    rows.push({ row, sid, host: hostBySid[sid], r: r || [] });
  });

  const terms = comps.flatMap((c) => [`"${c.name}"`, ...(c.dom ? [`"${c.dom}"`] : [])]).join(' OR ');
  const when = today() + ' · ' + AUTO;
  const data: { range: string; values: string[][] }[] = [];
  let stoppedEarly: string | undefined, searched = 0, withHits = 0, next = 0;

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    while (next < rows.length && !stoppedEarly) {
      const x = rows[next++];
      let hits: Hit[];
      try { hits = await tavilySearch(cfg, terms, x.host); } catch (e) {
        if (e instanceof ToolError && (e.code === 'rate_limited' || e.code === 'not_granted')) { stoppedEarly = e.message; return; }
        continue; // one failed search shouldn't stop the rest
      }
      searched++;
      hits = hits.filter((h) => { const hh = hostOf(h.url); return hh === x.host || hh.endsWith('.' + x.host); });
      // Keep a person's earlier finds and add anything new. Earlier automatic results are replaced,
      // so a wrong match doesn't stick. Error values like #REF! count as empty.
      const prevFound = String(x.r[14] || '').trim();
      const manual = !String(x.r[15] || '').endsWith('· ' + AUTO);
      const keep = manual && prevFound && !/^none/i.test(prevFound) && !prevFound.startsWith('#');
      const found = keep ? prevFound.split(/\s*[,;]\s*/).filter(Boolean) : [];
      const ev: Record<string, string> = {};
      if (keep) String(x.r[16] || '').split(/\s*;\s*|\n/).forEach((p) => { const m = p.match(/^(.+?):\s*(https?:\/\/\S+)\s*$/); if (m) ev[m[1].trim()] = m[2]; });
      for (const c of comps) {
        const re = nameRe(c.name), d = c.dom.toLowerCase();
        const m = hits.find((h) => re.test(h.text.toLowerCase()) || (d && h.text.toLowerCase().includes(d)));
        if (m) { if (!found.some((f) => low(f) === low(c.name))) found.push(c.name); if (!ev[c.name]) ev[c.name] = m.url; }
      }
      if (found.length) withHits++;
      const evText = found.filter((n) => ev[n]).map((n) => `${n}: ${ev[n]}`).join('; ');
      data.push({ range: `${ref}!O${x.row}:Q${x.row}`, values: [[found.length ? found.join(', ') : 'None found', when, evText]] });
    }
  }));

  if (data.length) {
    // Only write rows whose Site ID hasn't moved since the check started.
    const ids = ((await sheets.getValues(cfg, cfg.sa, `${ref}!A1:A`)).values as string[][]).map((x) => String(x?.[0] || ''));
    const bySid = new Map(rows.map((x) => [x.row, x.sid]));
    const safe = data.filter((d) => { const row = Number(d.range.match(/O(\d+):/)![1]); return ids[row - 1] === bySid.get(row); });
    if (safe.length) await sheets.batchUpdateValues(cfg, cfg.sa, safe, 'RAW');
  }
  return { tab, searched, skipped, withHits, stoppedEarly };
}
