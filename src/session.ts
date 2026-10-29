import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Config } from './config.js';

// Sessions live entirely in an AES-256-GCM sealed, httpOnly cookie (no database).
// Google sign-in is for identity only, so the session holds no Google tokens.

export interface Session {
  email: string;
  name: string;
  iat: number;  // session start, ms since epoch
}

export const SESSION_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const OAUTH_MAX_AGE_MS = 10 * 60 * 1000;

function key(cfg: Config, purpose: string): Buffer {
  return crypto.createHmac('sha256', cfg.sessionSecret).update('mbb:' + purpose).digest();
}

export function seal(cfg: Config, purpose: string, data: unknown): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(cfg, purpose), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

export function unseal<T>(cfg: Config, purpose: string, token: string | undefined): T | null {
  if (!token) return null;
  try {
    const buf = Buffer.from(token, 'base64url');
    if (buf.length < 29) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key(cfg, purpose), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function cookieName(cfg: Config, base: string): string {
  return cfg.secureCookies ? '__Host-' + base : base;
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

function writeCookie(cfg: Config, res: Response, name: string, value: string, maxAgeMs: number): void {
  const attrs = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (cfg.secureCookies) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

export function getSession(cfg: Config, req: Request): Session | null {
  const s = unseal<Session>(cfg, 'session', readCookie(req, cookieName(cfg, 'mbb')));
  if (!s || typeof s.email !== 'string' || typeof s.iat !== 'number') return null;
  if (Date.now() - s.iat > SESSION_MAX_AGE_MS) return null;
  return s;
}

export function setSession(cfg: Config, res: Response, s: Session): void {
  const left = SESSION_MAX_AGE_MS - (Date.now() - s.iat);
  writeCookie(cfg, res, cookieName(cfg, 'mbb'), seal(cfg, 'session', s), Math.max(left, 0));
}

export function clearSession(cfg: Config, res: Response): void {
  writeCookie(cfg, res, cookieName(cfg, 'mbb'), '', 0);
}

export interface OAuthState { state: string; verifier: string; t: number }

export function getOAuthState(cfg: Config, req: Request): OAuthState | null {
  const s = unseal<OAuthState>(cfg, 'oauth', readCookie(req, cookieName(cfg, 'mbb_oauth')));
  if (!s || Date.now() - s.t > OAUTH_MAX_AGE_MS) return null;
  return s;
}

export function setOAuthState(cfg: Config, res: Response, s: OAuthState): void {
  writeCookie(cfg, res, cookieName(cfg, 'mbb_oauth'), seal(cfg, 'oauth', s), OAUTH_MAX_AGE_MS);
}

export function clearOAuthState(cfg: Config, res: Response): void {
  writeCookie(cfg, res, cookieName(cfg, 'mbb_oauth'), '', 0);
}
