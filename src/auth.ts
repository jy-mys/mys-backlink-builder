import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { AccessList } from './access.js';
import type { Config } from './config.js';
import { escapeHtml, page } from './html.js';
import { clearOAuthState, clearSession, getOAuthState, setOAuthState, setSession } from './session.js';
import { checkOrigin } from './security.js';

// Google sign-in is for identity only: who you are, checked against staff domains and the intern list.
// Sheets access goes through the app's service account (see serviceaccount.ts).
export const SCOPES = 'openid email profile';

function redirectUri(cfg: Config): string {
  return cfg.appOrigin + '/auth/callback';
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  // The ID token comes straight from Google's token endpoint over TLS, so its
  // signature need not be re-verified (OpenID Connect Core 3.1.3.7, step 6).
  const part = jwt.split('.')[1] || '';
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

export function authRouter(cfg: Config, access: AccessList): Router {
  const r = Router();

  r.get('/login', (_req, res) => {
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    setOAuthState(cfg, res, { state, verifier, t: Date.now() });
    const u = new URL(cfg.googleAuthUrl);
    u.search = new URLSearchParams({
      client_id: cfg.googleClientId,
      redirect_uri: redirectUri(cfg),
      response_type: 'code',
      scope: SCOPES,
      prompt: 'select_account',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    res.redirect(302, u.toString());
  });

  r.get('/callback', async (req: Request, res: Response) => {
    const saved = getOAuthState(cfg, req);
    clearOAuthState(cfg, res);
    const again = '<p><a href="/auth/login">Sign in again</a></p>';
    if (typeof req.query.error === 'string') return page(res, 400, 'Sign-in cancelled', `<p>Google sign-in didn't finish.</p>${again}`);
    if (!saved || typeof req.query.state !== 'string' || req.query.state !== saved.state || typeof req.query.code !== 'string') {
      return page(res, 400, 'Sign-in expired', `<p>That sign-in link is no longer valid.</p>${again}`);
    }
    let t: { ok: boolean; body: Record<string, any> };
    try {
      const res2 = await fetch(cfg.googleTokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cfg.googleClientId,
          client_secret: cfg.googleClientSecret,
          grant_type: 'authorization_code',
          code: req.query.code,
          code_verifier: saved.verifier,
          redirect_uri: redirectUri(cfg),
        }),
      });
      t = { ok: res2.ok, body: (await res2.json().catch(() => ({}))) as Record<string, any> };
    } catch {
      return page(res, 502, 'Google is unavailable', `<p>Couldn't reach Google. Try again in a moment.</p>${again}`);
    }
    if (!t.ok || !t.body.id_token) return page(res, 400, 'Sign-in failed', `<p>Google didn't accept the sign-in.</p>${again}`);
    const claims = decodeJwtPayload(t.body.id_token);
    const email = String(claims.email || '');
    if (claims.aud !== cfg.googleClientId || !email || claims.email_verified !== true) {
      return page(res, 400, 'Sign-in failed', `<p>Google didn't confirm this account's email address.</p>${again}`);
    }
    let role;
    try {
      role = await access.role(email);
    } catch {
      return page(res, 503, 'Try again', `<p>Couldn't check the access list just now. Try again in a moment.</p>${again}`);
    }
    if (!role) {
      return page(res, 403, 'Account not allowed', `<p>${escapeHtml(email)} isn't on the list for the Backlink Builder. Staff sign in with their @mysense.com.my account; interns need a lead to add their Gmail address.</p>${again}`);
    }
    setSession(cfg, res, { email, name: String(claims.name || claims.given_name || email.split('@')[0]), iat: Date.now() });
    res.redirect(302, '/');
  });

  r.get('/logout', (_req, res) => {
    page(res, 200, 'Sign out', '<form method="post" action="/auth/logout"><button type="submit">Sign out of the Backlink Builder</button></form>');
  });

  r.post('/logout', (req, res) => {
    if (!checkOrigin(cfg, req)) return page(res, 403, 'Not allowed', '<p>Cross-site request blocked.</p>');
    clearSession(cfg, res);
    page(res, 200, 'Signed out', '<p>You are signed out.</p><p><a href="/auth/login">Sign in</a></p>');
  });

  return r;
}
