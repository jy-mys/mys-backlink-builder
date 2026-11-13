import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import express, { type Request, type Response } from 'express';
import { AccessList } from './access.js';
import { INDEX_PATH, PUBLIC_DIR, loadConfig, type Config } from './config.js';
import { authRouter } from './auth.js';
import { ToolError } from './errors.js';
import { RateLimiter } from './ratelimit.js';
import { checkOrigin, inlineScriptHash, securityHeaders } from './security.js';
import { clearSession, getSession, type Session } from './session.js';
import { staffRouter } from './staff.js';
import { runTool } from './tools.js';

function sendError(cfg: Config, res: Response, err: unknown): void {
  const e = err instanceof ToolError ? err : new ToolError('upstream_error', 'Unexpected server error', 500, true, 1500);
  if (!(err instanceof ToolError)) console.error(err);
  res.status(e.status).json(e.toJSON());
}

export function createApp(cfg: Config, access = new AccessList(cfg)) {
  const html = readFileSync(INDEX_PATH, 'utf8');
  const limiter = new RateLimiter(cfg.searchesPerHour, 3600_000);

  // A session plus a fresh check that the person is still allowed in, so removing an intern
  // takes effect within the access list's cache time. Throws if the list can't be read.
  async function signedIn(req: Request, res: Response): Promise<Session | null> {
    const s = getSession(cfg, req);
    if (!s) return null;
    if (await access.role(s.email)) return s;
    clearSession(cfg, res);
    return null;
  }
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(securityHeaders(cfg, inlineScriptHash(html)));

  app.get('/healthz', (_req, res) => { res.type('text').send('ok'); });
  app.use('/auth', authRouter(cfg, access));
  app.use('/staff', staffRouter(cfg, access));

  app.get(['/', '/index.html'], async (req, res) => {
    // If the list can't be read, still serve the page: it shows the sheet error itself.
    const s = await signedIn(req, res).catch(() => getSession(cfg, req));
    if (!s) return res.redirect(302, '/auth/login');
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(html);
  });
  app.get('/shim.js', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile('shim.js', { root: PUBLIC_DIR });
  });

  app.get('/api/me', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const s = await signedIn(req, res);
      if (!s) return sendError(cfg, res, new ToolError('not_granted', 'Not signed in', 401));
      res.json({ name: s.name });
    } catch (err) {
      sendError(cfg, res, err);
    }
  });

  app.post('/api/tool', express.json({ limit: '2mb' }), async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!checkOrigin(cfg, req)) return sendError(cfg, res, new ToolError('blocked_by_policy', 'Cross-site request blocked', 403));
    if (!req.is('application/json')) return sendError(cfg, res, new ToolError('blocked_by_policy', 'Expected JSON', 415));
    try {
      const s = await signedIn(req, res);
      if (!s) return sendError(cfg, res, new ToolError('not_granted', 'Not signed in', 401));
      res.json({ payload: await runTool(cfg, req.body, { email: s.email, limiter, sa: cfg.sa }) });
    } catch (err) {
      sendError(cfg, res, err);
    }
  });

  // Malformed JSON bodies and anything else unexpected.
  app.use((err: any, _req: Request, res: Response, _next: express.NextFunction) => {
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      return sendError(cfg, res, new ToolError('blocked_by_policy', 'Invalid request body', 400));
    }
    sendError(cfg, res, err);
  });
  app.use((_req, res) => { res.status(404).type('text').send('Not found'); });
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const cfg = loadConfig();
  createApp(cfg).listen(cfg.port, () => console.log(`Backlink Builder on :${cfg.port} (${cfg.appOrigin})`));
  cfg.sa.email().then(
    (email) => console.log(`Sheets service account (${cfg.sa.kind}): ${email}. Share the Backlink Tracker with it as Editor.`),
    () => console.error('Could not determine the Sheets service account email. Sheets calls will fail until credentials work.'),
  );
}
