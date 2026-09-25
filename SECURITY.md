# Security Policy

MYTHOS is a local-first assistant that can run tools with real side effects
on the machine it's installed on (files, apps, the browser, calendar/email
integrations). Please report vulnerabilities privately rather than opening a
public issue.

## Reporting a vulnerability

Use **GitHub's private vulnerability reporting** for this repository:
"Security" tab → "Report a vulnerability". This opens a private advisory
that only the maintainer and you can see, and lets you attach a PoC without
exposing it before a fix ships.

If GitHub private reporting is unavailable to you, contact:

`<< PLACEHOLDER: operator to fill in a security contact address >>`

There is no bug-bounty program. We do ask that you give us a reasonable
window to ship a fix before any public disclosure.

## What's actually in scope

- Anything that lets a remote party reach the tool surface without the
  bearer token (see "Network access" below).
- Anything that lets a web page — any site open in a browser on this machine —
  drive the local API (see "Local access" below).
- Injection (prompt, command, SQL-shaped, path) reachable through any
  effector or adapter.
- Secrets/credentials leaking into logs, audit trails, or model context.
- Supply-chain issues in `package.json` dependencies (see also
  `.github/dependabot.yml`).

Denial-of-service against your own machine from your own misconfiguration
(e.g. running with `MYTHOS_DRY_RUN` off and a very permissive
`AUTONOMOUS_MAX_TIER`) is a config/docs issue, not a vulnerability — but tell
us anyway if the defaults are unsafe.

## Current security posture (so a report can reference the real design)

- **Network surface**: `MYTHOS_AUTH_TOKEN` gates every HTTP/WS request once
  the server binds to anything other than loopback. Boot **refuses to start**
  if `MYTHOS_BIND` is non-loopback and no token is set — this is enforced in
  `mythos/server/index.js`, not just documented, so an unauthenticated
  non-loopback bind is not a runtime state that can happen silently.
- **Local access**: there is no PIN. It was removed on 2026-09-23 — MYTHOS is
  a single-user desktop app and opens straight into the HUD. On a loopback
  bind with no token the server trusts this machine: any local process can
  call the API, which is the deliberate trade. What it refuses is a web page:
  a request carrying a foreign `Origin`, or a browser `Sec-Fetch-Site` other
  than `same-origin`/`none`, is rejected before any handler runs
  (`mythos/src/core/server/boot-guards.js`), and a DNS-rebound hostname is
  rejected by the Host check (BUG-337).
- **Remote browsers** (token configured): signing in exchanges the token for a
  random session id; the server stores only its SHA-256 and a fingerprint of
  the token, outside the vault, and the cookie never carries the token
  (`mythos/server/auth-sessions.js`, BUG-444). Sessions expire after 30 days,
  one browser can sign out alone, and rotating the token ends all of them.
- **Secrets**: every provider key is BYO, lives in `mythos/.env`
  (gitignored), and is documented — with no hardcoded default — in
  `mythos/.env.example`. There is no first-party key baked into the repo to
  leak.
- **Autonomy gating**: every tool call passes through a tiered leash
  (`mythos/src/core/leash/index.js`) before it can execute; T3/T4 actions
  require operator confirmation and are audited even when denied. Credential
  patterns in tool arguments are scanned and blocked before any T3/T4
  effector runs.

## Supported versions

This project does not yet cut numbered releases; security fixes land on
`main`. Track the commit history for fixes if you're pinned to an older
checkout.
