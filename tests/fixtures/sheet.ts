import { readFileSync } from 'node:fs';
import path from 'node:path';

// Fixture copy of the "Backlink Tracker" spreadsheet, built from the page's own embedded data
// so the Sites tab overlay has realistic rows.

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const ORIGINAL_HTML = readFileSync(path.join(ROOT, 'malaysia-backlink-builder.html'), 'utf8');
export const SHEET_ID = '1KcJjTGJpxOQVsfkdMFpZ6sIfEWGWtMj0kcm8eWyLkZ0';
// The ID embedded in the original claude.ai page, which the parity tests still load.
export const ORIGINAL_SHEET_ID = '18D9suxsJQY4L5LEbl2URVZP8jSvJPHwQPKbWoioyECQ';

const dataJson = ORIGINAL_HTML.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/)![1];
export const DATA = JSON.parse(dataJson) as { industries: string[]; sites: any[] };

const WHO = { intern: 'Intern: do now', client: 'Needs client info', qualify: 'Client must qualify', manager: 'Needs manager OK', avoid: 'Avoid' } as Record<string, string>;
const LT = { listing: 'Listing / directory', guest: 'Guest post / sponsored', pr: 'PR / news', forum: 'Forum / community', avoid: 'Avoid pattern' } as Record<string, string>;
const TR = { 5: '1M+', 4: '100k–1M', 3: '10k–100k', 2: '1k–10k', 1: 'Under 1k', 0: '' } as Record<number, string>;
const PR = { 1: '1 - Must have', 2: '2 - Recommended', 3: '3 - Optional' } as Record<number, string>;

function verdict(s: any): string {
  if (s.lt === 'avoid') return 'Avoid';
  return (s.da || 0) >= 30 && s.tr >= 2 && s.spam === 'Low' ? 'Build this' : 'Low priority';
}

function siteRow(s: any): string[] {
  const keys = Object.keys(s.inds);
  const ind = keys.includes('core') ? 'Core' : keys.includes('all') ? 'All industries' : keys.join('; ');
  const p = Math.min(...keys.map((k) => s.inds[k].p));
  return [s.sid, s.name, s.url, ind, verdict(s), WHO[s.who], s.next, PR[p], LT[s.lt], s.cost, s.price || '', s.link, s.da == null ? '' : String(s.da), TR[s.tr] || '', s.spam, s.inds[keys[0]].n];
}

export const BUILD_SITES = DATA.sites.filter((s) => verdict(s) === 'Build this' && s.dom);
// Row 69 of the MYSense tab, used by the competitor-check flow (matches the brief's 'MYSense'!O69:Q69).
export const ROW69_SID: string = BUILD_SITES[64].sid;
export const ROW70_SID: string = BUILD_SITES[65].sid;

export type Grid = string[][];

function clientTab(name: string, industry: string, comps: string, kit: string, web: string, sids: string[], extra: Record<number, string[]> = {}): Grid {
  const g: Grid = [
    ['Client', name, '', '', '', '', '', '', '', '', '', 'Competitors', comps],
    ['Industry', industry, '', '', '', '', '', '', '', '', '', 'Client kit', kit],
    ['', '', '', '', '', '', '', '', '', '', '', 'Website', web],
    ['Site ID', 'Site', 'Who', 'Next step', 'Priority', 'Cost', 'Link value', 'URL', 'Status', 'Live URL', 'Link checked', 'Done by', 'Date live', 'Blocker', 'Competitors found', 'Checked on', 'Evidence'],
  ];
  sids.forEach((sid, i) => {
    const row = 5 + i;
    const base = [sid, '', '', '', '', '', '', '', 'Not started', '', '', '', '', '', '', '', ''];
    g.push(extra[row] ? base.map((v, j) => (extra[row][j] !== undefined ? extra[row][j] : v)) : base);
  });
  return g;
}

export function buildStore(): { sheets: Map<string, Grid>; gids: Map<string, number> } {
  const sheets = new Map<string, Grid>();
  sheets.set('Summary', [
    ['Backlink Tracker'], [''], [''], ['Tab', 'Client', 'Industry'],
    ['MYSense', 'MYSense', 'Professional & B2B Services'],
    ["Dr Tan's Clinic", "Dr Tan's Clinic", 'Healthcare'],
  ]);
  sheets.set('Sites', [
    ['Site ID', 'Name', 'URL', 'Industries', 'Verdict', 'Who', 'Next step', 'Priority', 'Link type', 'Cost', 'Price', 'Link value', 'Est. DA', 'MY traffic', 'Spam risk', 'Notes'],
    ...DATA.sites.map(siteRow),
  ]);
  const mysenseSids = BUILD_SITES.slice(0, 66).map((s) => s.sid);
  sheets.set('MYSense', clientTab('MYSense', 'Professional & B2B Services',
    'Locus-T (locus-t.com.my), Primal Malaysia (primal.com.my)',
    'Exact business name; +60 phone number', 'mysense.com.my', mysenseSids, {
      5: [, , , , , , , , 'Live', 'https://example.com/mysense', 'Nofollow', 'Aina', '3 Oct 2026', ''] as string[],
      6: [, , , , , , , , 'Submitted', '', '', 'Aina', '', 'Waiting for client to share access'] as string[],
      7: [, , , , , , , , 'Not started', '', '', '', '', '', 'Locus-T', '20 Oct 2026 · Aina', 'Locus-T: https://example.com/locus'] as string[],
      69: [, , , , , , , , 'Submitted', '', '', 'Aina'] as string[],
    }));
  sheets.set("Dr Tan's Clinic", clientTab("Dr Tan's Clinic", 'Healthcare', '', '', '', BUILD_SITES.slice(0, 3).map((s) => s.sid)));
  sheets.set('Client template', clientTab('', '', '', '', '', []));
  sheets.set('Competitor gap', [
    ['Client', 'Domain', 'Competitors linking', 'Which', 'Authority', 'Source', 'Date', '', 'Decision', 'Reviewed by', 'Notes'],
    ['MYSense', 'marketing-interactive.com', '2', 'Locus-T, Primal Malaysia', '48', 'Semrush export', '12 Oct 2026', '', 'New', '', ''],
    ['MYSense', 'digitalnewsasia.com', '2', 'Locus-T, Primal Malaysia', '52', 'Semrush export', '12 Oct 2026', '', 'New', '', ''],
    ["Dr Tan's Clinic", 'healthline.com', '1', 'X', '90', 'Semrush export', '12 Oct 2026', '', 'New', '', ''],
    ['MYSense', 'mmaglobal.com', '1', 'Locus-T', '60', 'Semrush export', '12 Oct 2026', '', 'Ignore', 'Lee', ''],
  ]);
  const gids = new Map<string, number>();
  [...sheets.keys()].forEach((t, i) => gids.set(t, 1000 + i));
  return { sheets, gids };
}
