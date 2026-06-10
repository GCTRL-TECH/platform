# Google Drive Connector — Self-Serve Setup

GCTRL lets each deployment configure its own Google OAuth client through the
Settings UI. There is **no shared OAuth app**, no hardcoded client ID, and no
required environment variable. You stand up the local stack, paste your own
client credentials once, and you're done.

This guide walks an admin through wiring Google Drive end-to-end in ~5 minutes.

---

## TL;DR

```
1. console.cloud.google.com → APIs & Services → Credentials → Create OAuth client ID
2. Application type: Web application
3. Authorized redirect URI: http://localhost:4000/api/connectors/google/callback
4. Copy Client ID + Client Secret
5. GCTRL → Settings → Integrations → Google → Setup → paste both → Save
6. Open /drive in GCTRL → Connect → authorize → sync
```

---

## 1. Create the OAuth client in Google Cloud Console

You need an admin Google account (any Google account works for personal use —
no Workspace required).

1. Open <https://console.cloud.google.com/>.
2. Pick or create a project. The free tier is fine — Drive read API has no cost.
3. Sidebar → **APIs & Services** → **Library**. Search for **Google Drive API**
   and click **Enable**. (Without this, OAuth will succeed but `/drive/v3/files`
   will return 403.)
4. Sidebar → **APIs & Services** → **OAuth consent screen**.
   - User type: **External** (works for any Google account; if you're paying for
     Workspace, **Internal** is fine and skips the verification banner).
   - App name: anything (e.g. `GCTRL Local`).
   - Support email: your address.
   - Add scope: `.../auth/drive.readonly` and `.../auth/userinfo.email`.
   - Save. You don't need to publish — leaving in Testing mode and adding your
     own email as a test user is enough for self-hosted use.
5. Sidebar → **APIs & Services** → **Credentials** → **Create credentials** →
   **OAuth client ID**.
   - Application type: **Web application**.
   - Name: anything (e.g. `GCTRL Web Client`).
   - **Authorized redirect URIs** — add **exactly** this:

     ```
     http://localhost:4000/api/connectors/google/callback
     ```

     (For prod deployments, swap `localhost:4000` for your API host. The URI
     must match byte-for-byte what GCTRL sends to Google or the callback fails
     with `redirect_uri_mismatch`.)
   - Click **Create**.
6. Copy the **Client ID** and **Client secret** that pop up. Treat the secret
   like a password.

> **Tip — where to find the right redirect URI:** Inside GCTRL, the Settings →
> Integrations → Google → Setup panel shows the exact redirect URI the running
> deployment expects, with a copy-to-clipboard input. Paste from there if your
> deployment is not on `localhost:4000`.

---

## 2. Paste the credentials into GCTRL

1. Sign in to GCTRL as a user with the **admin** role. (Connector config is
   admin-managed per deployment — it's not a per-end-user setting.)
2. Click your avatar → **Settings** → **Integrations**.
3. Find the **Google Workspace** row. If credentials are not configured yet it
   will say **Needs Setup**.
4. Click **Setup**. The inline form drops down.
5. Paste the **Client ID** and **Client Secret** into the two fields.
6. Click **Save**.

The row now says **Configured** and the **Connect** button is enabled.

Behind the scenes this hits:

```
PUT /api/connectors/config/google
{ "clientId": "...", "clientSecret": "..." }
```

Both values land in the `connector_configs` table. They override any
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` env vars — env vars only act as a
dev-mode fallback when the row is missing.

---

## 3. Connect your Google account

This step is per end-user (each user can connect their own Drive account
against the deployment's shared OAuth client):

1. Sidebar → **Drive** (or click **Connect** on the Google row in Settings).
2. A popup window opens to Google's consent screen.
3. Sign in and approve the Drive read-only scope.
4. The popup closes; the GoogleDrivePage loads your files.

The OAuth tokens are stored in the `oauth_connectors` table, keyed by `user_id`.
Each user keeps their own access + refresh tokens — only the *client*
credentials are shared.

---

## 4. Browse and sync

- Navigate folders, search, select files, click **Extract Selected** to enqueue
  KEX jobs.
- Use **Sync Entire Folder** to recursively pull everything extractable under a
  folder (up to 10 levels deep).
- Jobs land in the same KEX queue as direct uploads. Watch them complete in the
  **Extractions** view.

---

## Security notes

- The **client secret** is stored plaintext in `connector_configs` for v1.
  This is acceptable for self-hosted single-tenant use. **Before any managed
  / multi-tenant offering**, switch it to `pgp_sym_encrypt()` via `pgcrypto`
  (the extension is already enabled in migration `001_users.sql`).
- **OAuth state nonces** are stored in Redis with a 10-minute TTL and consumed
  atomically — the implementation is CSRF-safe.
- The **Drive scope is `drive.readonly`**. GCTRL cannot delete, move, or modify
  any file in the user's Drive. Add additional scopes via the
  `DEFAULT_SCOPES` constant in `connector_configs.rs` if you need them.
- **Disconnecting** from Settings → Integrations → Disconnect revokes the local
  copy of the tokens but does **not** revoke them at Google. Users who want a
  full revocation should also remove GCTRL from
  <https://myaccount.google.com/permissions>.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Click Connect → 400 with "OAuth not configured for 'google'" | No row in `connector_configs`, no env vars | Run step 2 above. |
| Google consent page shows `Error 400: redirect_uri_mismatch` | Redirect URI in console doesn't match what GCTRL sends | Copy the exact URI from Settings → Integrations → Google → Setup and paste it into the console. |
| Consent succeeds but `/drive` is empty | Drive API not enabled on the GCP project | Step 1.3 above. |
| `403 access_denied` on consent | App is in Testing mode and your email is not a test user | Add yourself in OAuth consent screen → Test users. |
| Token refresh keeps failing after the admin rotates the secret | Old secret cached on a long-running connector | Have the user click Disconnect + Reconnect once. The connector row re-resolves credentials on every refresh, but if Google has already invalidated the refresh token, only re-consent fixes it. |

---

## API reference (for SDK / CLI users)

All routes are mounted under `/api/connectors`.

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `GET` | `/config/providers` | admin | List supported providers + redirect URIs + setup state |
| `GET` | `/config/:provider` | admin | Read one provider's `clientId` (secret masked) |
| `PUT` | `/config/:provider` | admin | Upsert `{ clientId, clientSecret }` |
| `DELETE` | `/config/:provider` | admin | Clear that provider's row |
| `GET` | `/auth/:provider` | user | Returns `{ authUrl }` for the consent popup |
| `GET` | `/google/auth` | user | 302 redirect to Google consent (alternate entrypoint) |
| `GET` | `/google/callback` | public | OAuth callback handler — closes the popup, redirects to `/drive` |
| `GET` | `/` | user | List the caller's connected accounts |
| `DELETE` | `/:id` | user | Disconnect one of the caller's accounts |
| `GET` | `/google/drive/files` | user | Browse Drive |
| `POST` | `/google/drive/sync` | user | Sync selected files to KEX |
| `POST` | `/google/drive/sync/folder` | user | Recursively sync a folder to KEX |
