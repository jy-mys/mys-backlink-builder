import type { Response } from 'express';
import { page } from './html.js';

// Public privacy notice, linked from the Google sign-in consent screen. No sign-in needed.

export function privacyPage(res: Response): void {
  page(res, 200, 'Backlink Builder privacy notice',
    '<p>The Backlink Builder is an internal tool for the MYSense SEO team.</p>' +
    '<h2 style="font-size:16px">What it uses</h2>' +
    '<p>When you sign in with Google, the app receives only your name and email address. It uses them to check that you are ' +
    'allowed in and to fill in names such as "Done by" and "Reviewed by". It does not get access to your Gmail, Drive or any other Google data.</p>' +
    '<h2 style="font-size:16px">What it stores</h2>' +
    '<p>Your name and email are kept in an encrypted sign-in cookie in your browser. Work you record in the app, including your name ' +
    'where the page fills it in, is saved to the team\'s Backlink Tracker Google Sheet. Interns\' Gmail addresses are kept in that sheet ' +
    'so staff can grant and remove access. Nothing is sold or shared with anyone else.</p>' +
    '<h2 style="font-size:16px">Removing your data</h2>' +
    '<p>Sign out to delete the cookie. To have your name or email removed from the sheet, ask the MYSense SEO team.</p>' +
    '<p><a href="/">Back to the Backlink Builder</a></p>');
}
