import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Config } from './config.js';

// Hash of the page's one executable inline <script>. The JSON data block is not
// executed, so CSP doesn't apply to it.
export function inlineScriptHash(html: string): string {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (blocks.length !== 1) throw new Error(`Expected exactly one inline <script> in index.html, found ${blocks.length}`);
  return 'sha256-' + crypto.createHash('sha256').update(blocks[0][1], 'utf8').digest('base64');
}

export function securityHeaders(cfg: Config, scriptHash: string) {
  const csp = [
    "default-src 'none'",
    `script-src 'self' '${scriptHash}'`,
    // style="" attributes in the page (including runtime bar widths) can't be hashed.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (cfg.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

// CSRF: cookies are SameSite=Lax, and state-changing requests must carry our own Origin.
export function checkOrigin(cfg: Config, req: Request): boolean {
  return req.headers.origin === cfg.appOrigin;
}
