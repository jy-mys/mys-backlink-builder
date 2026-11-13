import type { Response } from 'express';

// Small server-rendered pages (sign-in messages, the staff page). No scripts, so the CSP needs no changes.

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function page(res: Response, status: number, title: string, body: string, wide = false): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).type('html').send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:${wide ? 760 : 520}px;margin:64px auto;padding:0 16px;color:#1d2228;background:#f6f6f4}` +
    `a,button{color:#2b63c9}button{font:inherit;background:none;border:0;padding:0;text-decoration:underline;cursor:pointer}` +
    `table{width:100%;border-collapse:collapse;margin:16px 0}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #ddd;vertical-align:top}` +
    `th{font-size:13px;color:#5b636b;font-weight:600}input{font:inherit;padding:6px 8px;border:1px solid #bbb;border-radius:6px;width:100%;box-sizing:border-box}` +
    `.add{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end}.add label{font-size:13px;color:#5b636b}` +
    `.primary{background:#1d2228;color:#fff;border-radius:6px;padding:7px 14px;text-decoration:none}.note{color:#5b636b;font-size:13px}` +
    `.msg{padding:8px 12px;border-radius:6px;background:#e8f1e4}.err{background:#f8e3e1}` +
    `@media (max-width:560px){.add{grid-template-columns:1fr}}</style></head>` +
    `<body><h1 style="font-size:20px">${title}</h1>${body}</body></html>`,
  );
}
