import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { loadConfig, type Config } from '../src/config.js';
import { createApp } from '../src/server.js';
import { seal, type Session } from '../src/session.js';
import { CLIENT_ID, FIRECRAWL_KEY, Upstream } from './mocks/upstream.js';
import { SHEET_ID } from './fixtures/sheet.js';

export const SESSION_SECRET = 'test-session-secret-0123456789-abcdefghijkl';
export const CLIENT_SECRET = 'GOCSPX-test-client-SECRET';
// 29 Oct 2026, 10:00 in Kuala Lumpur. Both pages run on this frozen clock.
export const NOW = new Date('2026-10-29T10:00:00+08:00');

export interface Stack {
  upstream: Upstream;
  cfg: Config;
  appUrl: string;
  originalUrl: string;
  close(): Promise<void>;
}

// credentials: 'key-file' uses GOOGLE_APPLICATION_CREDENTIALS; 'metadata' uses the
// Cloud Run metadata server (Workload Identity), mocked via GCE_METADATA_HOST.
export async function startStack(opts: { firecrawlKey?: string; credentials?: 'key-file' | 'metadata' } = {}): Promise<Stack> {
  const upstream = await new Upstream().start();
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const creds: Record<string, string> = {};
  if ((opts.credentials ?? 'key-file') === 'key-file') {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'mbb-sa-')), 'key.json');
    writeFileSync(file, JSON.stringify(upstream.saKeyFile()));
    creds.GOOGLE_APPLICATION_CREDENTIALS = file;
  } else creds.GCE_METADATA_HOST = upstream.metadataHost;
  const cfg = loadConfig({
    ...creds,
    PORT: String(port),
    APP_ORIGIN: `http://localhost:${port}`,
    SHEET_ID,
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    SESSION_SECRET,
    ALLOWED_DOMAINS: 'mysense.com.my',
    ALLOWED_EMAILS: 'friend.of.mysense@gmail.com',
    FIRECRAWL_API_KEY: opts.firecrawlKey ?? FIRECRAWL_KEY,
    GOOGLE_AUTH_URL: upstream.url + '/o/oauth2/auth',
    GOOGLE_TOKEN_URL: upstream.url + '/token',
    SHEETS_API_BASE: upstream.url,
    FIRECRAWL_API_BASE: upstream.url,
  });
  server.on('request', createApp(cfg));
  return {
    upstream,
    cfg,
    appUrl: cfg.appOrigin,
    originalUrl: upstream.url + '/original',
    async close() {
      await new Promise((r) => server.close(r));
      await upstream.close();
    },
  };
}

export function sessionCookie(stack: Stack, over: Partial<Session> = {}): string {
  const s: Session = {
    email: 'intern@mysense.com.my',
    name: 'Test Intern',
    iat: Date.now(),
    ...over,
  };
  return seal(stack.cfg, 'session', s);
}

export async function signIn(context: BrowserContext, stack: Stack, over: Partial<Session> = {}) {
  await context.addCookies([{ name: 'mbb', value: sessionCookie(stack, over), url: stack.appUrl, httpOnly: true, sameSite: 'Lax' }]);
}

export async function prepare(page: Page) {
  await page.clock.setFixedTime(NOW);
}

// Waits until the sheet has loaded (or failed), fonts are ready and no request is in flight.
export async function settle(page: Page) {
  await page.waitForFunction(() => !/Connecting to the Backlink Tracker|Loading /.test(document.getElementById('sheetBar')!.textContent || ''));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

export async function pickClient(page: Page, tab: string) {
  await page.selectOption('#clientSel', tab);
  await page.waitForFunction(() => /Connected to the Backlink Tracker sheet/.test(document.getElementById('sheetBar')!.textContent || ''));
  await page.waitForFunction(() => !/Loading the competitor gap/.test(document.getElementById('gapBody')!.textContent || ''));
  await page.waitForLoadState('networkidle');
}
