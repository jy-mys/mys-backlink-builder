import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { serviceAccount, type TokenSource } from './serviceaccount.js';

export const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
export const INDEX_PATH = path.join(PUBLIC_DIR, 'index.html');

export interface Config {
  port: number;
  appOrigin: string;
  secureCookies: boolean;
  sheetId: string;
  googleClientId: string;
  googleClientSecret: string;
  sa: TokenSource;
  sessionSecret: string;
  allowedEmails: Set<string>;
  allowedDomains: Set<string>;
  firecrawlKey: string;
  searchesPerHour: number;
  // Upstream base URLs. Only the tests override these, to point at local mocks.
  googleAuthUrl: string;
  googleTokenUrl: string;
  sheetsBase: string;
  firecrawlBase: string;
}

function list(v: string | undefined): Set<string> {
  return new Set(String(v || '').split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean));
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = (env[name] || '').trim();
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

// Fails closed: the server refuses to start if anything security-relevant is missing.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sheetId = required(env, 'SHEET_ID');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(sheetId)) throw new Error('SHEET_ID looks malformed');
  const html = readFileSync(INDEX_PATH, 'utf8');
  if (!html.includes(`var SHEET_ID = '${sheetId}';`)) {
    throw new Error('SHEET_ID does not match the spreadsheet ID embedded in public/index.html');
  }

  const appOrigin = new URL(required(env, 'APP_ORIGIN')).origin;
  const sessionSecret = required(env, 'SESSION_SECRET');
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');

  const allowedEmails = list(env.ALLOWED_EMAILS);
  const allowedDomains = new Set([...list(env.ALLOWED_DOMAINS)].map((d) => d.replace(/^@/, '')));
  if (!allowedEmails.size && !allowedDomains.size) {
    throw new Error('Set ALLOWED_EMAILS and/or ALLOWED_DOMAINS, otherwise nobody could sign in');
  }

  const hostname = new URL(appOrigin).hostname;
  const local = hostname === 'localhost' || hostname === '127.0.0.1';
  if (!local && !appOrigin.startsWith('https://')) throw new Error('APP_ORIGIN must be https outside localhost');

  return {
    port: parseInt(env.PORT || '8080', 10),
    appOrigin,
    secureCookies: !local,
    sheetId,
    googleClientId: required(env, 'GOOGLE_CLIENT_ID'),
    googleClientSecret: required(env, 'GOOGLE_CLIENT_SECRET'),
    sa: serviceAccount(env),
    sessionSecret,
    allowedEmails,
    allowedDomains,
    firecrawlKey: (env.FIRECRAWL_API_KEY || '').trim(),
    searchesPerHour: Math.max(1, parseInt(env.SEARCHES_PER_HOUR || '30', 10) || 30),
    googleAuthUrl: env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    googleTokenUrl: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    sheetsBase: (env.SHEETS_API_BASE || 'https://sheets.googleapis.com').replace(/\/$/, ''),
    firecrawlBase: (env.FIRECRAWL_API_BASE || 'https://api.firecrawl.dev').replace(/\/$/, ''),
  };
}

export function isAllowed(cfg: Config, email: string): boolean {
  const e = email.trim().toLowerCase();
  const domain = e.split('@')[1] || '';
  return cfg.allowedEmails.has(e) || (!!domain && cfg.allowedDomains.has(domain));
}
