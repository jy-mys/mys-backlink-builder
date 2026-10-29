import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ORIGINAL_HTML, ROOT } from './fixtures/sheet.js';

// public/index.html must be the original fragment, byte for byte, apart from the skeleton,
// the shim tag, the dropped claude.ai viewport meta and the six reworded errMsg() strings.

const REWORDED: [string, string][] = [
  ["Connect Google Sheets in claude.ai Settings → Connectors, then click Retry. Until then you can browse the list, but progress won\\'t load or save.",
    "Google Sheets isn\\'t set up for this app yet. Ask an admin to finish setup, then click Retry. Until then you can browse the list, but progress won\\'t load or save."],
  ['Your Google Sheets connection has expired. Reconnect it in claude.ai Settings → Connectors, then click Retry.',
    'Your Google sign-in has expired. Reload the page to sign in again, then click Retry.'],
  ['You have more than one Google Sheets connection. Choose one when Claude asks, then click Retry.',
    'More than one Google account is signed in. Sign out, sign in with one account, then click Retry.'],
  ['Google Sheets is turned off for this page. Allow it when Claude asks, then click Retry.',
    "Google Sheets isn\\'t allowed for this app. Ask an admin to check the setup, then click Retry."],
  ["Live progress isn\\'t available in this view. Open the page from claude.ai to load clients from the sheet.",
    "You\\'re not signed in. Reload the page to sign in with Google and load clients from the sheet."],
  // Sheets is accessed by the app's service account now, not the person's own Google account.
  ['Check you can open the Backlink Tracker sheet with this Google account.',
    'Check the Backlink Tracker sheet is shared with this app.'],
];

test('index.html differs from the original only where allowed', () => {
  const lines = ORIGINAL_HTML.split('\n');
  let expected = ['<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    lines[0], ...lines.slice(2, 267), '</head>', '<body>', ...lines.slice(267, 376),
    '<script src="/shim.js"></script>', ...lines.slice(376), '</body>', '</html>', ''].join('\n');
  for (const [from, to] of REWORDED) {
    expect(expected.split(from).length, from).toBe(2);
    expected = expected.replace(from, to);
  }
  const actual = readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  expect(actual).toBe(expected);
  expect(actual).not.toMatch(/claude\.ai/);
});
