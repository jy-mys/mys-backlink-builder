import express, { Router, type Request, type Response } from 'express';
import { INTERN_DOMAIN, isInternAddress, normEmail, type AccessList } from './access.js';
import { isStaff, type Config } from './config.js';
import { escapeHtml, page } from './html.js';
import { checkOrigin } from './security.js';
import { getSession } from './session.js';

// /staff: permanent staff add and remove the interns' Gmail addresses. Plain HTML forms, no scripts.

const MAX_NAME = 100;

export function staffRouter(cfg: Config, access: AccessList): Router {
  const r = Router();
  r.use(express.urlencoded({ extended: false, limit: '10kb' }));

  const staffOnly = (req: Request, res: Response): string | null => {
    const s = getSession(cfg, req);
    if (!s) { res.redirect(302, '/auth/login'); return null; }
    if (!isStaff(cfg, s.email)) {
      page(res, 403, 'Staff only', '<p>Only staff with a @mysense.com.my account can manage intern access.</p><p><a href="/">Back to the Backlink Builder</a></p>');
      return null;
    }
    return s.email;
  };

  async function render(res: Response, status: number, note = '', err = false) {
    let rows = '';
    try {
      const all = await access.interns();
      const active = all.filter((x) => x.active), removed = all.filter((x) => !x.active);
      const row = (x: (typeof all)[number], action: string) =>
        `<tr><td>${escapeHtml(x.email)}</td><td>${escapeHtml(x.name)}</td><td class="note">${escapeHtml(x.changedBy)}<br>${escapeHtml(x.changedOn)}</td>` +
        `<td><form method="post" action="/staff/${action}"><input type="hidden" name="email" value="${escapeHtml(x.email)}">` +
        `<input type="hidden" name="name" value="${escapeHtml(x.name)}"><button type="submit">${action === 'remove' ? 'Remove' : 'Add back'}</button></form></td></tr>`;
      rows =
        `<h2 style="font-size:16px;margin-top:32px">Interns who can sign in (${active.length})</h2>` +
        (active.length
          ? `<table><thead><tr><th>Gmail</th><th>Name</th><th>Added by</th><th></th></tr></thead><tbody>${active.map((x) => row(x, 'remove')).join('')}</tbody></table>`
          : '<p class="note">No interns yet.</p>') +
        (removed.length
          ? `<h2 style="font-size:16px;margin-top:32px">Removed</h2><table><thead><tr><th>Gmail</th><th>Name</th><th>Removed by</th><th></th></tr></thead><tbody>${removed.map((x) => row(x, 'add')).join('')}</tbody></table>`
          : '');
    } catch {
      note = "Couldn't read the intern list from the Backlink Tracker sheet. Try again in a moment.";
      err = true;
    }
    page(res, status, 'Intern access',
      (note ? `<p class="msg${err ? ' err' : ''}">${escapeHtml(note)}</p>` : '') +
      `<p>Staff sign in with their @mysense.com.my account. Interns sign in with a Gmail address listed here. Removing someone signs them out within a minute.</p>` +
      `<form method="post" action="/staff/add" class="add">` +
      `<div><label for="email">Intern's Gmail</label><input id="email" name="email" type="email" required placeholder="name@gmail.com" autocomplete="off"></div>` +
      `<div><label for="name">Name</label><input id="name" name="name" maxlength="${MAX_NAME}" placeholder="e.g. Aina Rahman" autocomplete="off"></div>` +
      `<div><button type="submit" class="primary">Add intern</button></div></form>` +
      rows +
      `<p style="margin-top:32px"><a href="/">Back to the Backlink Builder</a></p>`,
      true);
  }

  r.get('/', async (req, res) => {
    if (!staffOnly(req, res)) return;
    await render(res, 200);
  });

  r.post('/:action(add|remove)', async (req, res) => {
    if (!checkOrigin(cfg, req)) return page(res, 403, 'Not allowed', '<p>Cross-site request blocked.</p>');
    const by = staffOnly(req, res);
    if (!by) return;
    const email = normEmail(String(req.body?.email || ''));
    const name = String(req.body?.name || '').trim().slice(0, MAX_NAME);
    if (!isInternAddress(email)) return render(res, 400, `Interns need a @${INTERN_DOMAIN} address. "${email || '(blank)'}" isn't one.`, true);
    try {
      if (req.params.action === 'add') await access.add(email, name, by);
      else await access.remove(email, by);
    } catch {
      return render(res, 502, "Couldn't save to the Backlink Tracker sheet. Nothing changed; try again.", true);
    }
    await render(res, 200, req.params.action === 'add' ? `${email} can now sign in.` : `${email} can no longer sign in.`);
  });

  return r;
}
