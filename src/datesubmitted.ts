import type { Config } from './config.js';
import { clientTabs, tabRef } from './linkcheck.js';
import * as sheets from './sheets.js';

// "Date submitted" (column V of a client tab): when the page saves a row with status Submitted
// (an update_values to 'Tab'!I<row>:N<row>), fill V<row> with today's date if it's empty.
// Done on the server so the page itself stays the original artifact.

export const DATE_COL = 'V';
const NEED_COLS = 22; // A..V

const today = () => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());

export function submittedRow(range: unknown, values: unknown): { tab: string; row: number } | null {
  const m = String(range || '').match(/^'((?:[^']|'')+)'!I(\d+):N(\d+)$/);
  if (!m || m[2] !== m[3]) return null;
  const v = Array.isArray(values) && Array.isArray(values[0]) ? values[0][0] : null;
  if (String(v || '').trim().toLowerCase() !== 'submitted') return null;
  return { tab: m[1].replace(/''/g, "'"), row: Number(m[2]) };
}

async function ensureColumn(cfg: Config, tab: string) {
  const meta: any = await sheets.getSpreadsheet(cfg, cfg.sa, ['sheets.properties.title', 'sheets.properties.sheetId', 'sheets.properties.gridProperties.columnCount']);
  const p = (meta.sheets || []).map((s: any) => s.properties).find((x: any) => x?.title === tab);
  const have = p?.gridProperties?.columnCount;
  if (p && typeof have === 'number' && have < NEED_COLS) await sheets.appendColumns(cfg, cfg.sa, p.sheetId, NEED_COLS - have);
}

export async function stampSubmitted(cfg: Config, hit: { tab: string; row: number }): Promise<void> {
  if (hit.row < 5 || !(await clientTabs(cfg)).includes(hit.tab)) return;
  const ref = tabRef(hit.tab);
  const cur = (await sheets.getValues(cfg, cfg.sa, `${ref}!${DATE_COL}${hit.row}`)).values as string[][];
  if (String(cur[0]?.[0] || '').trim()) return;
  await ensureColumn(cfg, hit.tab);
  await sheets.updateValues(cfg, cfg.sa, `${ref}!${DATE_COL}${hit.row}`, [[today()]], 'RAW');
}
