# Malaysia Backlink Builder (web app)

The claude.ai artifact `malaysia-backlink-builder.html`, served as a small web app.
The page is unchanged apart from a page skeleton, five error messages that mentioned claude.ai, and the
sheet-access error (it now says the sheet must be shared with the app, not with your own Google account).
`public/shim.js` provides the `window.claude.use('mcp' | 'user')` runtime the page expects, and backs it
with this server:

| Route | What it does |
|---|---|
| `GET /` | The page. Redirects to Google sign-in when there is no session. |
| `GET /auth/login`, `/auth/callback` | Google sign-in (OAuth 2.0 with PKCE), identity only: `openid email profile`. |
| `GET/POST /auth/logout` | Sign out. |
| `GET /api/me` | `{ name }` of the signed-in person (fills "Done by", "Reviewed by", "Checked on"). |
| `POST /api/tool` | The page's tool calls. Only `get_values`, `update_values`, `get_spreadsheet` on the Backlink Tracker sheet, and `firecrawl_search`. Everything else is refused. |
| `GET /staff` | Staff only: add and remove interns' Gmail addresses (see "Who can sign in"). |
| `GET /healthz` | Liveness check. |

**How access works.** People sign in with Google only to prove who they are. Staff get in by
`ALLOWED_DOMAINS` / `ALLOWED_EMAILS`; interns get in with a Gmail address staff have listed on `/staff`. The server then reads and writes the sheet
as the app's own **service account**, so the Backlink Tracker only has to be shared with that one account.
The Google Sheet is the only store. Sessions are an AES-256-GCM sealed, httpOnly cookie holding just the
person's email and name. No Google token, key or Firecrawl key reaches the browser.

## 1. Google Cloud setup (company project)

Everything on the Google side lives in the company's Google Cloud project, under the mysense.com.my
Workspace organisation. Use your **company** Google account for every `gcloud` command and console step,
not a personal one:

```bash
gcloud auth login                       # sign in with your @mysense.com.my account
gcloud auth list                        # the active account must be @mysense.com.my
PROJECT=your-company-project-id
REGION=asia-southeast1
gcloud config set project $PROJECT
gcloud config set run/region $REGION
```

### Org policies to expect

The mysense.com.my organisation may enforce these. The setup below works with both.

- **Service account key creation is blocked** (`iam.disableServiceAccountKeyCreation`).
  Don't create JSON keys. The app uses **Workload Identity only**: Cloud Run runs as the service account and
  gets tokens from the metadata server. As a result, you can't run the app locally against the real sheet.
  Use `npm test` (full mocks) locally and the deployed service for real data.
- **Domain-restricted sharing** applies to two things:
  - **Drive sharing.** The service account's address ends in `iam.gserviceaccount.com`, which Workspace treats as outside
    mysense.com.my. A Workspace admin must allow sharing the Backlink Tracker with it (Admin console →
    Apps → Google Workspace → Drive and Docs → Sharing settings: allow external sharing for the Backlink Tracker's
    owner or organisational unit, or add a trust rule for the service account's address). Until then, the Share dialog refuses the address.
  - **Public Cloud Run access** (`iam.allowedPolicyMemberDomains`). That policy also blocks `allUsers`, so
    `--allow-unauthenticated` fails. The plan is an admin exception scoped to this one service: an org-policy
    exception that lets `allUsers` hold `roles/run.invoker` on `backlink-builder` only. Once it's in place, grant it with
    `gcloud run services add-iam-policy-binding backlink-builder --region $REGION --member allUsers --role roles/run.invoker`.
    Public access only reaches the sign-in page; the app's own Google sign-in and allow-list still gate everything.

### Service account (Sheets access)

```bash
gcloud services enable sheets.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
gcloud iam service-accounts create backlink-builder --display-name "Backlink Builder"
SA=backlink-builder@$PROJECT.iam.gserviceaccount.com
```

Open the **Backlink Tracker** sheet → **Share** → add `$SA` as **Editor** and untick "Notify people".
If the dialog refuses the address, see "Domain-restricted sharing" above.
The server prints the address it uses at startup (`Sheets service account (metadata): backlink-builder@…`).
If the sheet isn't shared with it, the page shows "Google Sheets refused the request…" and names the address.

### OAuth client (sign-in)

1. **APIs & Services → OAuth consent screen**: choose **Internal**. Only mysense.com.my accounts can sign in,
   and no Google verification or test-user list is needed. The app asks only for `openid`, `email` and `profile`.
2. **Credentials → Create credentials → OAuth client ID**, type **Web application**, name "Backlink Builder".
   You add the redirect URI after the first deploy, once the URL is known (step 5).
3. Keep the client ID and secret for step 5.

With an Internal consent screen, Google itself only lets mysense.com.my accounts through. The app's
`ALLOWED_DOMAINS=mysense.com.my` check is a second gate.

## 2. Environment variables

See `.env.example`.

| Var | Required | Notes |
|---|---|---|
| `APP_ORIGIN` | yes | Public origin, e.g. `https://backlink-builder-xyz.a.run.app`. Must be https outside localhost. Used for the redirect URI and the CSRF Origin check. |
| `SHEET_ID` | yes | `1KcJjTGJpxOQVsfkdMFpZ6sIfEWGWtMj0kcm8eWyLkZ0`. The server won't start if it's missing or doesn't match the ID in `public/index.html`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | yes | The OAuth client from step 1. |
| `SESSION_SECRET` | yes | 32+ random characters (`openssl rand -base64 48`). Changing it signs everyone out. |
| `ALLOWED_DOMAINS` | yes | `mysense.com.my`. |
| `ALLOWED_EMAILS` | no | Extra individual addresses. With an Internal consent screen these must still be mysense.com.my accounts. |
| `GOOGLE_APPLICATION_CREDENTIALS` | no | Path to a service account JSON key, for running outside Cloud Run. Not used in the company project (key creation is blocked); leave unset. |
| `FIRECRAWL_API_KEY` | no | Without it, the Check panel shows its "use the Google links" fallback. |
| `SEARCHES_PER_HOUR` | no | Per-person Firecrawl limit, default 30. |
| `PORT` | no | Default 8080. Cloud Run sets it. |

`GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`, `GCE_METADATA_HOST`, `SHEETS_API_BASE` and `FIRECRAWL_API_BASE` exist only so the tests can point at local mocks. Don't set them in production.

## 3. Run locally

Needs Node 20.6 or later.

```bash
npm ci
npx playwright install chromium
npm test
```

In the company project, local runs use the mocks only (see "Org policies"). The app needs a service account key to
reach the real sheet from a laptop, and key creation is blocked. `npm run dev` with a filled-in `.env` still starts the
server and the sign-in flow, but Sheets calls fail with "Google Sheets isn't set up for this app yet".

## 4. Tests

```bash
npx playwright install chromium
npm test
```

Everything runs against local mocks of Google sign-in, the service-account token endpoint, the Cloud Run metadata server,
Sheets and Firecrawl (`tests/mocks/upstream.ts`), using the fixture sheet in `tests/fixtures/sheet.ts`.

- `copy.spec.ts`: `public/index.html` equals the original fragment plus the skeleton, the shim tag and the six reworded messages, and nothing else.
- `visual.spec.ts`: the original (with a mock `window.claude`) and the app, at 1500 px and 390 px, with no client, with a client, and with SEO details on. The screenshots must be pixel-identical. Both sets are saved to `test-results/parity/`.
- `behaviour.spec.ts`: the seven flows, run on both the original and the app. Asserts the exact ranges and values written, and that both write the same.
- `errors.spec.ts`: an expired service-account token (refreshed silently), credentials unavailable, sheet not shared with the service account, Sheets 429, Firecrawl out of credits, Firecrawl not configured, and an expired or missing session.
- `staff.spec.ts`: only staff open `/staff`; adding an intern creates the hidden tab and lets that Gmail sign in; removing one ends their session; non-Gmail addresses and cross-site posts are refused; the page's tool calls can't reach the tab.
- `security.spec.ts`: other spreadsheet IDs, other tools, no or forged session, cross-origin and missing Origin, the Firecrawl cap and rate limit, the sign-in allow-list and identity-only scopes, Workload Identity tokens, and that no token, key or secret reaches the browser.

## 5. Deploy to Cloud Run

No local Docker needed: `gcloud run deploy --source .` builds the `Dockerfile` with Cloud Build.
Run these as your company account (step 1), with `PROJECT`, `REGION` and `SA` set.

```bash
# Secrets. `read -rs` takes the value without echoing it or saving it to shell history.
read -rs V && printf '%s' "$V" | gcloud secrets create bb-google-client-secret --data-file=- && unset V   # paste the OAuth client secret, Enter
openssl rand -base64 48 | tr -d '\n' | gcloud secrets create bb-session-secret --data-file=-
read -rs V && printf '%s' "$V" | gcloud secrets create bb-firecrawl-key --data-file=- && unset V          # paste the Firecrawl key, Enter
for s in bb-google-client-secret bb-session-secret bb-firecrawl-key; do
  gcloud secrets add-iam-policy-binding $s --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor
done

# First deploy. APP_ORIGIN is a placeholder until the URL is known.
gcloud run deploy backlink-builder \
  --source . \
  --region $REGION \
  --service-account $SA \
  --max-instances=1 \
  --memory 256Mi \
  --allow-unauthenticated \
  --set-env-vars "SHEET_ID=1KcJjTGJpxOQVsfkdMFpZ6sIfEWGWtMj0kcm8eWyLkZ0,GOOGLE_CLIENT_ID=<client-id>,ALLOWED_DOMAINS=mysense.com.my,APP_ORIGIN=https://placeholder.invalid" \
  --set-secrets "GOOGLE_CLIENT_SECRET=bb-google-client-secret:latest,SESSION_SECRET=bb-session-secret:latest,FIRECRAWL_API_KEY=bb-firecrawl-key:latest"

# Set the real origin.
URL=$(gcloud run services describe backlink-builder --region $REGION --format 'value(status.url)')
gcloud run services update backlink-builder --region $REGION --update-env-vars "APP_ORIGIN=$URL"
```

Then, in the console, add `<URL>/auth/callback` to the OAuth client's **Authorized redirect URIs**, and check the startup log:

```bash
gcloud run services logs read backlink-builder --region $REGION --limit 20
```

Look for `Sheets service account (metadata): backlink-builder@…`.

If `--allow-unauthenticated` fails with a policy error, that's domain-restricted sharing (see "Org policies").
Stop there and wait for the admin exception. Don't switch to another access method. Once the exception is in place,
grant `allUsers` the invoker role on this service (the command is under "Org policies") and carry on.

Redeploys are just `gcloud run deploy backlink-builder --source . --region $REGION`. The settings above are kept.

- `--service-account $SA`: the service runs as the Backlink Builder account (Workload Identity, no key file).
- `--allow-unauthenticated`: intended. The app does its own Google sign-in and allow-list.
- `--max-instances=1`: the Firecrawl rate limit is held in memory per instance (there's no database). One instance is plenty for a team tool.

## Who can sign in

- **Permanent staff:** any account in `ALLOWED_DOMAINS` (`mysense.com.my`), plus anyone in `ALLOWED_EMAILS`.
  Staff can open `/staff`.
- **Interns:** an `@gmail.com` address that staff have added on `/staff`. Interns can use the Backlink Builder
  but not `/staff`.

`/staff` keeps the list in a hidden **App access** tab in the Backlink Tracker sheet (Intern Gmail · Name ·
Access · Changed by · Changed on), created the first time someone is added. Removing an intern marks the row
"Removed", and their open session stops working on its next request. The server caches the list for a minute,
so an edit made directly in the tab can take up to a minute to apply. The page's own tool calls can't read,
write or list that tab, or write formulas that point at it (`INDIRECT`/`IMPORTRANGE` formulas are refused too).

## Security notes

- CSP: `script-src 'self' 'sha256-…'` (hash of the page's inline script, computed at startup), `frame-ancestors 'none'`, `connect-src 'self'`, fonts only from Google Fonts.
  `style-src` needs `'unsafe-inline'`, because the page uses `style=""` attributes, including bar widths set at runtime, and those can't be hashed.
- CSRF: cookies are `SameSite=Lax`, and `POST /api/tool`, `POST /auth/logout` and the `/staff` forms require `Origin` to equal `APP_ORIGIN`.
- Cookies use the `__Host-` prefix and `Secure` outside localhost.
- Sessions last 7 days, then the person signs in again. Removing an intern on `/staff` cuts them off straight away; removing staff from `ALLOWED_*` takes effect at their next request after a redeploy. To cut everyone off at once, rotate `SESSION_SECRET`.
- Service-account tokens are cached in memory and refreshed before they expire. A 401 from Sheets drops the cached token and retries once.
- Every write is made by the service account, so the sheet's version history shows the service account as the editor. Who did what is still recorded in the "Done by", "Reviewed by" and "Checked on" columns.
- `/api/tool` checks the spreadsheet ID, tool name, input keys, `fields` mask, range length and value sizes before anything reaches Google.
