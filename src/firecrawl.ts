import type { Config } from './config.js';
import { ToolError, retryAfter } from './errors.js';

export const MAX_LIMIT = 10;

// Proxies the page's search to Firecrawl's search endpoint. The response is passed
// through as-is: the page walks it for anything with a url/title/description.
export async function search(cfg: Config, query: string, limit: number) {
  if (!cfg.firecrawlKey) throw new ToolError('server_not_connected', 'Firecrawl is not configured', 503);
  let res: globalThis.Response;
  try {
    res = await fetch(cfg.firecrawlBase + '/v2/search', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.firecrawlKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: Math.min(Math.max(1, limit), MAX_LIMIT), sources: ['web'] }),
    });
  } catch {
    throw new ToolError('upstream_error', 'Could not reach Firecrawl', 502, true, 1500);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (res.ok) return data;
  // Keep Firecrawl's own wording, so "Insufficient credits" still reads as out of credits.
  const msg = String(data?.error || data?.message || `HTTP ${res.status}`);
  if (res.status === 429) throw new ToolError('server_unavailable', msg, 503, true, retryAfter(res.headers.get('retry-after'), 2000));
  if (res.status >= 500) throw new ToolError('upstream_error', msg, 502, true, 1500);
  throw new ToolError('tool_error', msg, 422);
}
