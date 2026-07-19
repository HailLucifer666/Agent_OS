# Google OAuth setup (Gmail + Calendar)

MYTHOS's Gmail adapter and Calendar reminder sensor talk to Google via a single
long-lived **refresh token** minted by a one-time OAuth 2.0 Desktop-app flow.
This doc walks you through creating the Google Cloud project, enabling the right
APIs, and running the included `scripts/google-auth.js` to mint the token.

Once set up, MYTHOS degrades honestly without ever crashing:
- no `GOOGLE_REFRESH_TOKEN` → Gmail tools return OFFLINE, the reminder sensor never starts
- token revoked or expired → Gmail/Calendar calls surface the upstream error, other subsystems unaffected

> **Prerequisite**: this is operator-hardware work. You need a desktop browser
> on a machine that can reach `console.cloud.google.com` and
> `accounts.google.com`, plus a Google account. ~5 minutes end-to-end.

---

## 1. Create a Google Cloud project

1. Open <https://console.cloud.google.com/> and sign in.
2. Click the project picker (top bar) → **New Project**.
3. Name it (e.g. `mythos-personal`) → **Create**.
4. Make sure the new project is selected in the top-bar picker before continuing.

## 2. Enable the APIs

Both APIs must be enabled *in this project* or the OAuth consent + token exchange
will fail later.

1. **APIs & Services → Library**.
2. Search **Gmail API** → click into it → **Enable**.
3. Back to Library. Search **Google Calendar API** → **Enable**.

## 3. Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. User type: **External** → **Create**. (A "Testing" external app is fine for
   personal use — Google shows a "Google hasn't verified this app" warning the
   first time you sign in; click *Advanced → Go to app* to proceed.)
3. Fill the required fields (app name, your email under *User support email*
   and *Developer contact information*). The other fields can stay default.
4. **Scopes** step → *Add or Remove Scopes* → add:
   - `.../auth/gmail.readonly`
   - `.../auth/gmail.compose` *(gmail.send works too; compose covers drafts + send)*
   - `.../auth/calendar.readonly`
5. **Test users** step → *Add users* → add your own Google account email.
6. Save and continue through to the Summary. The consent screen stays in
   **Testing** status — that's fine for personal use.

## 4. Create the Desktop-app credential

1. **APIs & Services → Credentials** → **Create Credentials** → **OAuth client ID**.
2. Application type: **Desktop app** *(NOT Web app — the redirect is
   `http://localhost:4848`, which Google only permits for Desktop/Installed apps)*.
3. Name it (e.g. `mythos-cli`) → **Create**.
4. Copy the **Client ID** and **Client secret** shown. You'll need them in step 5.

## 5. Mint the refresh token

From the `mythos/` directory:

```bash
GOOGLE_CLIENT_ID=<paste-client-id> \
GOOGLE_CLIENT_SECRET=<paste-client-secret> \
node scripts/google-auth.js
```

What happens:
- The script opens your default browser at Google's consent URL.
- Sign in with the Google account you added as a test user in step 3.
- Approve the Gmail + Calendar scopes.
- Google redirects to `http://localhost:4848/?code=...`. The script's local
  HTTP server catches it, exchanges the code for tokens, and prints three
  lines to stdout:

  ```
  GOOGLE_CLIENT_ID=<...>
  GOOGLE_CLIENT_SECRET=<...>
  GOOGLE_REFRESH_TOKEN=<...>
  ```

If your browser doesn't auto-open, the script prints the consent URL — copy
it into a browser manually.

## 6. Copy the three values into `.env`

Append (or uncomment + fill) the three keys in `mythos/.env.example`-derived
`.env`:

```
GOOGLE_CLIENT_ID=<...>
GOOGLE_CLIENT_SECRET=<...>
GOOGLE_REFRESH_TOKEN=<...>
```

Restart MYTHOS. On boot you should see:
- `sensors.gmail.started` (only if you also set `GMAIL_TRIAGE_ENABLED=true`,
  default true) — unread-mail polling at `GMAIL_TRIAGE_POLL_MS` (5 min default)
- `engagement.reminder.sensor.started` (only if `GOOGLE_REFRESH_TOKEN` is set)
  — Calendar reminder polling at 30s

## 7. Verify

- Say (or type) "do I have any unread email?" → the gmail sensor / gmail_unread
  tool returns real messages.
- Add a Calendar event in the next 5 minutes with a reminder → within 30s of
  its start, MYTHOS speaks the reminder via the proactive-speech path.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `redirect_uri_mismatch` at consent | Wrong OAuth client type (Web instead of Desktop) | Recreate as **Desktop app** (step 4) |
| `access_denied` at consent | Your Google account isn't in the test-users list | Add it under OAuth consent screen → Test users (step 3.5) |
| `invalid_client` at token exchange | Typo in Client ID / Secret | Re-copy from the credential page |
| Gmail works but Calendar reads 403 / `insufficient authentication scopes` | Refresh token was minted BEFORE this Phase 3 fix added the calendar scope | Re-run `scripts/google-auth.js`; replace the old `GOOGLE_REFRESH_TOKEN` |
| Token expired (401 on Gmail/Calendar) | You revoked it, or Google expired it after 7 days of inactivity on a "Testing" app | Re-run the script to mint a fresh one |
| Browser didn't auto-open | No default-browser handler registered | The script prints the URL — copy-paste it |
| Port 4848 already in use | Another process is holding it | Stop it, or change `REDIRECT_PORT` in `scripts/google-auth.js` |

## Security notes

- The refresh token is a long-lived credential with the scopes you approved.
  Treat it like a password — never commit it to git. `.env` is gitignored.
- All three values (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_REFRESH_TOKEN`) are scrubbed from `run_command`'s child-process env
  by the Phase 3 effector's env-scrub layer (`from-runner.js:scrubEnv`).
- The leash's credential scanner denies any T3+ tool call whose args contain
  the token shape, so the entity can't exfiltrate it via `run_command` /
  `hermes_task` / `compose_email`.
- To revoke: <https://myaccount.google.com/permissions> → find the app →
  *Remove access*. The next Gmail/Calendar call will return 401 and degrade
  honestly.

## Where this is wired in the code

- `mythos/scripts/google-auth.js` — the OAuth flow (this doc's step 5).
- `mythos/adapters/google/index.js` — Gmail adapter (uses the refresh token
  to mint short-lived access tokens).
- `mythos/src/core/sensors/gmail-sensor.js` — unread-mail polling.
- `mythos/src/core/sensors/reminder-sensor.js` — Calendar reminder polling.
- `mythos/src/core/config/schema.js` — the `GOOGLE_*` schema entries.
- `mythos/.env.example` — the documented config keys.
