import { isStaff, type Config } from './config.js';
import { ToolError } from './errors.js';
import * as sheets from './sheets.js';

// Who may sign in:
//   - staff: ALLOWED_DOMAINS (mysense.com.my) or ALLOWED_EMAILS, from the environment;
//   - interns: @gmail.com addresses that staff add on the /staff page.
// The intern list lives in a hidden "App access" tab of the Backlink Tracker sheet, so it survives
// redeploys without a database. The page's own tool calls can't touch that tab (see tools.ts).

export const ACCESS_TAB = 'App access';
export const INTERN_DOMAIN = 'gmail.com';
const RANGE = `'${ACCESS_TAB}'!A1:E`;
const HEADER = ['Intern Gmail', 'Name', 'Access', 'Changed by', 'Changed on'];
const ACTIVE = 'Active', REMOVED = 'Removed';
const TTL_MS = 60_000;

export interface Intern { email: string; name: string; active: boolean; changedBy: string; changedOn: string; row: number }
export type Role = 'staff' | 'intern';

export function normEmail(e: string): string {
  return e.trim().toLowerCase();
}

export function isInternAddress(email: string): boolean {
  return /^[a-z0-9.+_-]+@gmail\.com$/.test(normEmail(email));
}

function today(): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());
}

export class AccessList {
  private cache: { at: number; interns: Intern[]; exists: boolean } | null = null;
  constructor(private cfg: Config) {}

  private async load(fresh = false): Promise<{ interns: Intern[]; exists: boolean }> {
    if (!fresh && this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache;
    let values: string[][] = [], exists = true;
    try {
      values = (await sheets.getValues(this.cfg, this.cfg.sa, RANGE)).values as string[][];
    } catch (e) {
      // Google answers a range on a tab that doesn't exist yet with "Unable to parse range".
      if (!(e instanceof ToolError && e.code === 'tool_error' && /Unable to parse range/i.test(e.message))) throw e;
      exists = false;
    }
    const interns = values.slice(1).map((r, i) => ({
      email: normEmail(String(r[0] || '')),
      name: String(r[1] || ''),
      active: String(r[2] || '').trim().toLowerCase() === ACTIVE.toLowerCase(),
      changedBy: String(r[3] || ''),
      changedOn: String(r[4] || ''),
      row: i + 2,
    })).filter((x) => x.email);
    this.cache = { at: Date.now(), interns, exists };
    return this.cache;
  }

  async interns(): Promise<Intern[]> {
    return (await this.load(true)).interns;
  }

  // null = not allowed in. Throws (a ToolError) if the list can't be read.
  async role(email: string): Promise<Role | null> {
    if (isStaff(this.cfg, email)) return 'staff';
    if (!isInternAddress(email)) return null;
    const e = normEmail(email);
    return (await this.load()).interns.some((x) => x.email === e && x.active) ? 'intern' : null;
  }

  async add(email: string, name: string, by: string): Promise<void> {
    await this.write(normEmail(email), name.trim(), ACTIVE, by);
  }

  async remove(email: string, by: string): Promise<void> {
    await this.write(normEmail(email), null, REMOVED, by);
  }

  private async write(email: string, name: string | null, access: string, by: string): Promise<void> {
    const { interns, exists } = await this.load(true);
    if (!exists) {
      await sheets.addSheet(this.cfg, this.cfg.sa, ACCESS_TAB, true);
      await sheets.updateValues(this.cfg, this.cfg.sa, `'${ACCESS_TAB}'!A1:E1`, [HEADER], 'RAW');
    }
    const found = interns.find((x) => x.email === email);
    const row = found ? found.row : Math.max(1, ...interns.map((x) => x.row)) + 1;
    const values = [[email, name ?? found?.name ?? '', access, by, today()]];
    await sheets.updateValues(this.cfg, this.cfg.sa, `'${ACCESS_TAB}'!A${row}:E${row}`, values, 'RAW');
    this.cache = null;
  }
}
