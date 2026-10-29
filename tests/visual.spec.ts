import { test, expect, type Browser } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startStack, signIn, prepare, settle, pickClient, type Stack } from './helpers.js';
import { ROOT } from './fixtures/sheet.js';

// Original artifact (mock window.claude) vs web app (real backend), same fixture data.
// Full-page screenshots must be identical pixel for pixel. Both are saved to
// test-results/parity/ for side-by-side review.

let st: Stack;
test.beforeAll(async () => { st = await startStack(); });
test.afterAll(async () => { await st.close(); });

const OUT = path.join(ROOT, 'test-results', 'parity');
const WIDTHS = [{ w: 1500, h: 1000 }, { w: 390, h: 844 }];
const STATES = ['no-client', 'client', 'client-seo'] as const;

async function shot(browser: Browser, target: 'original' | 'app', vp: { w: number; h: number }, state: (typeof STATES)[number]) {
  st.upstream.reset();
  const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
  await signIn(context, st);
  const page = await context.newPage();
  await prepare(page);
  await page.goto(target === 'app' ? st.appUrl : st.originalUrl);
  await settle(page);
  if (state !== 'no-client') await pickClient(page, 'MYSense');
  if (state === 'client-seo') await page.check('#seoCk');
  await page.mouse.move(0, 0);
  // Native <select> text can keep the fallback font's metrics if Google Fonts swaps in
  // mid-layout (a timing race, same code on both pages). Load every face, then force one
  // relayout, identically on both targets, so the capture is deterministic.
  await page.evaluate(async () => {
    await Promise.all([...document.fonts].map((f) => f.load().catch(() => null)));
    await document.fonts.ready;
    document.body.style.display = 'none';
    void document.body.offsetHeight;
    document.body.style.display = '';
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  const png = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
  await context.close();
  return png;
}

for (const vp of WIDTHS) {
  for (const state of STATES) {
    test(`parity ${vp.w}px ${state}`, async ({ browser }) => {
      const original = await shot(browser, 'original', vp, state);
      const app = await shot(browser, 'app', vp, state);
      mkdirSync(OUT, { recursive: true });
      writeFileSync(path.join(OUT, `${vp.w}-${state}-original.png`), original);
      writeFileSync(path.join(OUT, `${vp.w}-${state}-app.png`), app);
      // Same Chromium encoder, so identical pixels give identical PNG bytes.
      expect(app.equals(original), 'screenshots are pixel-identical').toBe(true);
    });
  }
}
