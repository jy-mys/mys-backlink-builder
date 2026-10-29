import type { Config } from './config.js';
import { ToolError, retryAfter } from './errors.js';
import type { TokenSource } from './serviceaccount.js';

// Thin client for the three Sheets REST v4 calls the page makes, authenticated as the
// app's service account. A 401 drops the cached token and retries once.

export type Cell = string | number | boolean | null;

class Unauthorized extends Error {}

async function once(cfg: Config, token: string, sa: TokenSource, method: string, path: string, query: Record<string, string>, body?: unknown) {
  const u = new URL(cfg.sheetsBase + path);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  let res: globalThis.Response;
  try {
    res = await fetch(u, {
      method,
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ToolError('upstream_error', 'Could not reach Google Sheets', 502, true, 1500);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (res.ok) return data;
  const msg = String(data?.error?.message || `HTTP ${res.status}`);
  if (res.status === 401) throw new Unauthorized(msg);
  if (res.status === 403) {
    throw new ToolError('tool_error', `The sheet must be shared with the app's service account ${await sa.email()} as Editor. Google said: ${msg}`, 422);
  }
  if (res.status === 429) throw new ToolError('server_unavailable', msg, 503, true, retryAfter(res.headers.get('retry-after'), 2000));
  if (res.status >= 500) throw new ToolError('upstream_error', msg, 502, true, retryAfter(res.headers.get('retry-after'), 1500));
  throw new ToolError('tool_error', msg, 422);
}

async function call(cfg: Config, sa: TokenSource, method: string, path: string, query: Record<string, string>, body?: unknown) {
  try {
    return await once(cfg, await sa.token(), sa, method, path, query, body);
  } catch (e) {
    if (!(e instanceof Unauthorized)) throw e;
    sa.invalidate();
    try {
      return await once(cfg, await sa.token(), sa, method, path, query, body);
    } catch (e2) {
      if (e2 instanceof Unauthorized) throw new ToolError('upstream_error', 'Google rejected the service account token', 502, true, 1500);
      throw e2;
    }
  }
}

const base = (id: string) => '/v4/spreadsheets/' + encodeURIComponent(id);

export async function getValues(cfg: Config, sa: TokenSource, range: string) {
  const d = await call(cfg, sa, 'GET', base(cfg.sheetId) + '/values/' + encodeURIComponent(range), {});
  // An empty range has no `values` key at all; the page expects an empty array.
  return { range: d.range ?? range, majorDimension: d.majorDimension ?? 'ROWS', values: Array.isArray(d.values) ? d.values : [] };
}

export async function updateValues(cfg: Config, sa: TokenSource, range: string, values: Cell[][]) {
  return call(cfg, sa, 'PUT', base(cfg.sheetId) + '/values/' + encodeURIComponent(range), { valueInputOption: 'USER_ENTERED' }, {
    range,
    majorDimension: 'ROWS',
    values,
  });
}

export async function getSpreadsheet(cfg: Config, sa: TokenSource, fields: string[]) {
  return call(cfg, sa, 'GET', base(cfg.sheetId), { fields: fields.join(',') });
}
