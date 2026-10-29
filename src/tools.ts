import type { Config } from './config.js';
import { ToolError } from './errors.js';
import * as firecrawl from './firecrawl.js';
import * as sheets from './sheets.js';
import type { RateLimiter } from './ratelimit.js';
import type { TokenSource } from './serviceaccount.js';

// The only tool calls the page makes. Anything else is refused before it reaches Google or Firecrawl.
const ALLOWED: Record<string, string[]> = {
  'Google Sheets': ['get_values', 'update_values', 'get_spreadsheet'],
  Firecrawl: ['firecrawl_search'],
};
const SPREADSHEET_FIELDS = ['sheets.properties.title', 'sheets.properties.sheetId'];
const MAX_ROWS = 2000;
const MAX_COLS = 26;
const MAX_CELL = 50_000;

export interface ToolContext {
  email: string;
  limiter: RateLimiter;
  sa: TokenSource;
}

function refuse(message: string): never {
  throw new ToolError('blocked_by_policy', message, 403);
}

function onlyKeys(input: Record<string, unknown>, keys: string[], optional: string[] = []): void {
  for (const k of Object.keys(input)) if (!keys.includes(k) && !optional.includes(k)) refuse(`Unexpected input field: ${k}`);
  for (const k of keys) if (!(k in input)) refuse(`Missing input field: ${k}`);
}

function range(v: unknown): string {
  if (typeof v !== 'string' || !v.length || v.length > 200 || /[\u0000-\u001f]/.test(v)) refuse('Invalid range');
  return v;
}

function values(v: unknown): sheets.Cell[][] {
  if (!Array.isArray(v) || !v.length || v.length > MAX_ROWS) refuse('Invalid values');
  return v.map((row) => {
    if (!Array.isArray(row) || row.length > MAX_COLS) refuse('Invalid values');
    return row.map((c) => {
      if (c === null || typeof c === 'number' || typeof c === 'boolean') return c;
      if (typeof c === 'string' && c.length <= MAX_CELL) return c;
      refuse('Invalid cell value');
    });
  });
}

export function validate(cfg: Config, body: unknown): { server: string; tool: string; input: Record<string, unknown> } {
  if (!body || typeof body !== 'object') refuse('Invalid request');
  const { server, tool, input } = body as Record<string, unknown>;
  if (typeof server !== 'string' || typeof tool !== 'string' || !Object.hasOwn(ALLOWED, server) || !ALLOWED[server].includes(tool)) {
    refuse('That tool is not allowed');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('Invalid input');
  const inp = input as Record<string, unknown>;
  if (server === 'Google Sheets' && inp.spreadsheetId !== cfg.sheetId) refuse('Only the Backlink Tracker sheet can be used');
  return { server, tool, input: inp };
}

export async function runTool(cfg: Config, body: unknown, ctx: ToolContext): Promise<unknown> {
  const { tool, input } = validate(cfg, body);
  switch (tool) {
    case 'get_values': {
      onlyKeys(input, ['spreadsheetId', 'range']);
      const r = range(input.range);
      return sheets.getValues(cfg, ctx.sa, r);
    }
    case 'update_values': {
      onlyKeys(input, ['spreadsheetId', 'range', 'values']);
      const r = range(input.range), v = values(input.values);
      return sheets.updateValues(cfg, ctx.sa, r, v);
    }
    case 'get_spreadsheet': {
      onlyKeys(input, ['spreadsheetId', 'fields']);
      const f = input.fields;
      if (!Array.isArray(f) || f.length !== SPREADSHEET_FIELDS.length || !SPREADSHEET_FIELDS.every((x) => f.includes(x))) refuse('Invalid fields');
      return sheets.getSpreadsheet(cfg, ctx.sa, SPREADSHEET_FIELDS);
    }
    case 'firecrawl_search': {
      onlyKeys(input, ['query'], ['objective', 'limit']);
      const q = input.query;
      if (typeof q !== 'string' || !q.trim() || q.length > 2000) refuse('Invalid query');
      const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.floor(input.limit) : firecrawl.MAX_LIMIT;
      if (!cfg.firecrawlKey) throw new ToolError('server_not_connected', 'Firecrawl is not configured', 503);
      if (!ctx.limiter.take(ctx.email)) {
        throw new ToolError('rate_limited', `Search limit reached (${cfg.searchesPerHour} an hour). Try again later.`, 429);
      }
      return firecrawl.search(cfg, q, limit);
    }
  }
  refuse('That tool is not allowed');
}
