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
| `GET /healthz` | Liveness check. |

**How access works.** People sign in with Google only to prove who they are. The allow-list
(`ALLOWED_DOMAINS`, `ALLOWED_EMAILS`) decides who gets in. The server then reads and writes the sheet
as the app's own **service account**, so the Backlink Tracker only has to be shared with that one account.
The Google Sheet is the only store. Sessions are an AES-256-GCM sealed, httpOnly cookie holding just the
person's email and name. No Google token, key or Firecrawl key reaches the browser.

## 1. Google Cloud setup

Do this once, in the Google Cloud project you'll deploy to.

### Service account (Sheets access)

```bash
PROJECT=your-gcp-project
gcloud config set project $PROJECT
gcloud services enable sheets.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
gcloud iam service-accounts create backlink-builder --display-name "Backlink Builder"
SA=backlink-builder@$PROJECT.iam.gserviceaccount.com
```

Open the **Backlink Tracker** sheet → **Share** → add `$SA` (for example
`backlink-builder@your-gcp-project.iam.gserviceaccount.com`) as **Editor**, and untick "Notify people".
The server prints the email it's using at startup:
`Sheets service account (metadata): backlink-builder@…`.
If the sheet isn't shared with it, the page shows "Google Sheets refused the request…" and the message names the email to share with.

On Cloud Run no key file is needed. The service runs *as* this service account (Workload Identity),
and tokens come from the metadata server. Only create a JSON key if you want to run locally against the real sheet (see step 3).

### OAuth client (sign-in)

1. **APIs & Services → OAuth consent screen**: choose **External** and click **Publish app** (**In production**).
   The app only asks for `openid`, `email` and `profile`, which are non-sensitive scopes, so Google verification isn't needed,
   there's no test-user list, and sign-ins don't expire after 7 days. (**Internal** also works if everyone uses mysense.com.my Workspace accounts.)
2. **Credentials → Create credentials → OAuth client ID**, type **Web application**.
   - Authorized redirect URIs: `https://<your-cloud-run-url>/auth/callback`, plus `http://localhost:8080/auth/callback` for local use.
3. Keep the client ID and secret for the env vars below.

Anyone with a Google account can reach the Google consent screen, but only allow-listed emails get a session.

## 2. Environment variables

See `.env.example`.

| Var | Required | Notes |
|---|---|---|
| `APP_ORIGIN` | yes | Public origin, e.g. `https://backlink-builder-xyz.a.run.app`. Must be https outside localhost. Used for the redirect URI and the CSRF Origin check. |
| `SHEET_ID` | yes | `18D9suxsJQY4L5LEbl2URVZP8jSvJPHwQPKbWoioyECQ`. The server won't start if it's missing or doesn't match the ID in `public/index.html`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | yes | The OAuth client from step 1. |
| `SESSION_SECRET` | yes | 32+ random characters (`openssl rand -base64 48`). Changing it signs everyone out. |
| `ALLOWED_DOMAINS` | one of these | Comma-separated, e.g. `mysense.com.my`. |
| `ALLOWED_EMAILS` | one of these | Comma-separated, e.g. `someone@gmail.com`. Use this for gmail.com addresses (never allow the whole gmail.com domain). |
| `GOOGLE_APPLICATION_CREDENTIALS` | local only | Path to a service account JSON key. Leave unset on Cloud Run, where the attached service account is used. |
| `FIRECRAWL_API_KEY` | no | Without it, the Check panel shows its "use the Google links" fallback. |
| `SEARCHES_PER_HOUR` | no | Per-person Firecrawl limit, default 30. |
| `PORT` | no | Default 8080. Cloud Run sets it. |

`GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`, `GCE_METADATA_HOST`, `SHEETS_API_BASE` and `FIRECRAWL_API_BASE` exist only so the tests can point at local mocks. Don't set them in production.

## 3. Run locally

Needs Node 20 or later.

```bash
npm ci
cp .env.example .env   # then fill it in
npm run dev            # http://localhost:8080
```

To reach the real sheet locally, create a key for the service account and point `GOOGLE_APPLICATION_CREDENTIALS` at it.
Keep the key file outside the repo, and delete the key when you're done:

```bash
gcloud iam service-accounts keys create ~/backlink-builder-key.json --iam-account $SA
```

`npm run build && npm start` runs the compiled server (load the env vars yourself; `npm start` doesn't read `.env`).

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
- `security.spec.ts`: other spreadsheet IDs, other tools, no or forged session, cross-origin and missing Origin, the Firecrawl cap and rate limit, the sign-in allow-list and identity-only scopes, Workload Identity tokens, and that no token, key or secret reaches the browser.

## 5. Deploy to Cloud Run

No local Docker needed: `gcloud run deploy --source .` builds the `Dockerfile` with Cloud Build.

```bash
REGION=asia-southeast1

# Secrets
printf '%s' "$GOOGLE_CLIENT_SECRET" | gcloud secrets create bb-google-client-secret --data-file=-
openssl rand -base64 48 | tr -d '\n' | gcloud secrets create bb-session-secret --data-file=-
printf '%s' "$FIRECRAWL_API_KEY" | gcloud secrets create bb-firecrawl-key --data-file=-
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
  --set-env-vars "SHEET_ID=18D9suxsJQY4L5LEbl2URVZP8jSvJPHwQPKbWoioyECQ,GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID,ALLOWED_DOMAINS=mysense.com.my,APP_ORIGIN=https://placeholder.invalid" \
  --set-secrets "GOOGLE_CLIENT_SECRET=bb-google-client-secret:latest,SESSION_SECRET=bb-session-secret:latest,FIRECRAWL_API_KEY=bb-firecrawl-key:latest"

# Set the real origin, then add <URL>/auth/callback to the OAuth client's redirect URIs.
URL=$(gcloud run services describe backlink-builder --region $REGION --format 'value(status.url)')
gcloud run services update backlink-builder --region $REGION --update-env-vars "APP_ORIGIN=$URL"

# Check the startup log for the service account line.
gcloud run services logs read backlink-builder --region $REGION --limit 20
```

To allow gmail.com teammates, add `ALLOWED_EMAILS=a@gmail.com,b@gmail.com` to `--set-env-vars`, or set it later with
`--update-env-vars` (use `^;^ALLOWED_EMAILS=a@gmail.com,b@gmail.com` so the commas aren't read as separators).

Redeploys are just `gcloud run deploy backlink-builder --source . --region $REGION` (the settings above are kept).

- `--service-account $SA`: the service runs as the Backlink Builder account, which is how it gets Sheets tokens (Workload Identity, no key file).
- `--allow-unauthenticated`: intended. The app does its own Google sign-in and allow-list. For a second layer, you can put it behind Identity-Aware Proxy.
- `--max-instances=1`: the Firecrawl rate limit is held in memory per instance (there's no database). One instance is plenty for a team tool.

## Security notes

- CSP: `script-src 'self' 'sha256-…'` (hash of the page's inline script, computed at startup), `frame-ancestors 'none'`, `connect-src 'self'`, fonts only from Google Fonts.
  `style-src` needs `'unsafe-inline'`, because the page uses `style=""` attributes, including bar widths set at runtime, and those can't be hashed.
- CSRF: cookies are `SameSite=Lax`, and `POST /api/tool` and `POST /auth/logout` require `Origin` to equal `APP_ORIGIN`.
- Cookies use the `__Host-` prefix and `Secure` outside localhost.
- Sessions last 7 days, then the person signs in again. Removing someone from the allow-list takes effect at their next sign-in. To cut everyone off at once, rotate `SESSION_SECRET`.
- Service-account tokens are cached in memory and refreshed before they expire. A 401 from Sheets drops the cached token and retries once.
- Every write is made by the service account, so the sheet's version history shows the service account as the editor. Who did what is still recorded in the "Done by", "Reviewed by" and "Checked on" columns.
- `/api/tool` checks the spreadsheet ID, tool name, input keys, `fields` mask, range length and value sizes before anything reaches Google.
