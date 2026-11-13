import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

// Fetches a public web page the way a browser would, without any third-party service.
// Refuses anything that resolves to a private, loopback or link-local address, on every
// redirect hop, so a URL typed into the sheet can't make the server reach internal hosts.

export interface PageResult { status?: number; finalUrl?: string; html?: string; error?: string }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 MYSenseLinkCheck/1.0';

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  const v = ip.toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
}

function guardedLookup(allowPrivate: boolean): net.LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, cb: (...a: any[]) => void) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs: any) => {
      if (err) return cb(err);
      const list = addrs as dns.LookupAddress[];
      if (!allowPrivate && list.some((a) => isPrivateIp(a.address))) return cb(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
      if ((options as any).all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
  }) as net.LookupFunction;
}

function once(url: URL, allowPrivate: boolean, timeoutMs: number, maxBytes: number): Promise<{ status: number; location?: string; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !allowPrivate && isPrivateIp(host)) return reject(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'GET',
      lookup: guardedLookup(allowPrivate),
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'en-MY,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br' },
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      const type = String(res.headers['content-type'] || '');
      if (status >= 300 && status < 400) { res.resume(); return resolve({ status, location, body: '', type }); }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const stream: NodeJS.ReadableStream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate())
        : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
      const chunks: Buffer[] = []; let size = 0; let done = false;
      const finish = () => { if (done) return; done = true; resolve({ status, body: Buffer.concat(chunks).toString('utf8'), type }); };
      stream.on('data', (c: Buffer) => { size += c.length; if (size <= maxBytes) chunks.push(c); else { finish(); req.destroy(); } });
      stream.on('end', finish);
      stream.on('error', (e) => (done ? undefined : reject(e)));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

export async function fetchPage(raw: string, opts: { allowPrivate?: boolean; timeoutMs?: number; maxBytes?: number } = {}): Promise<PageResult> {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return { error: "isn't a valid web address" }; }
  for (let hop = 0; hop <= 5; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: "isn't a web page address" };
    if (url.port && !['80', '443'].includes(url.port) && !opts.allowPrivate) return { error: 'uses an unusual port' };
    let r;
    try { r = await once(url, !!opts.allowPrivate, opts.timeoutMs ?? 20_000, opts.maxBytes ?? 3_000_000); } catch (e: any) {
      const code = e?.code;
      return { error: code === 'EBLOCKED' ? 'points to a private address' : code === 'ETIMEDOUT' ? 'took too long to respond'
        : code === 'ENOTFOUND' ? "domain doesn't exist" : 'could not connect' };
    }
    if (r.location && r.status >= 300 && r.status < 400) {
      try { url = new URL(r.location, url); } catch { return { status: r.status, error: 'redirects to a bad address' }; }
      continue;
    }
    return { status: r.status, finalUrl: url.toString(), html: /html|xml|text\/plain/i.test(r.type) || !r.type ? r.body : '' };
  }
  return { error: 'redirects too many times' };
}

export type Rel = 'Dofollow' | 'Nofollow' | 'Sponsored' | 'UGC';
export interface Findings { links: { href: string; rel: Rel }[]; mentioned: boolean }

const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
};
const decode = (s: string) => s.replace(/&amp;/gi, '&').replace(/&#x2f;/gi, '/').replace(/&#47;/g, '/').replace(/&quot;/gi, '"');
export const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');

// Links on the page that point at the client's domain (or a subdomain), with their rel= type.
export function findLinks(html: string, pageUrl: string, domain: string, name: string): Findings {
  const want = bareHost(domain);
  const metaNofollow = /<meta[^>]+name\s*=\s*["']?robots["']?[^>]*content\s*=\s*["'][^"']*nofollow/i.test(html);
  const links: Findings['links'] = [];
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(m[0], 'href');
    if (!href) continue;
    let u: URL;
    try { u = new URL(decode(href), pageUrl); } catch { continue; }
    const h = bareHost(u.hostname);
    if (!/^https?:$/.test(u.protocol) || !(h === want || h.endsWith('.' + want))) continue;
    const rel = (attr(m[0], 'rel') || '').toLowerCase().split(/\s+/);
    links.push({ href: u.toString(), rel: rel.includes('sponsored') ? 'Sponsored' : rel.includes('ugc') ? 'UGC' : rel.includes('nofollow') || metaNofollow ? 'Nofollow' : 'Dofollow' });
  }
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').toLowerCase();
  const core = name.replace(/\b(sdn\.? bhd\.?|berhad|bhd|plc|ltd|limited)\b/gi, '').trim().toLowerCase();
  const mentioned = text.includes(want) || (core.length >= 3 && text.includes(core));
  return { links, mentioned };
}

export function bestRel(links: Findings['links']): Rel | null {
  for (const r of ['Dofollow', 'Sponsored', 'UGC', 'Nofollow'] as Rel[]) if (links.some((l) => l.rel === r)) return r;
  return null;
}
