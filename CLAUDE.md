# Agent OS / MYTHOS — repo rules for AI sessions

## Concurrent-session safety (BUG-037)

A concurrent session once silently reverted live-verified fixes in
`mythos/adapters/pc-child/ps-automation.ps1` via a clean `git pull --ff-only`
(no conflict, no warning — its commit branched from an older snapshot).
Rules to prevent a repeat:

1. **Before editing any file listed in BUGS.md as recently fixed/verified**
   (especially `ps-automation.ps1`, `adapters/*/index.js`,
   `src/core/effectors/from-spotify.js`): run `git pull`, then diff the file
   against what BUGS.md claims is in it. If they disagree, STOP and reconcile
   before writing.
2. **Commit verified fixes immediately** — never leave live-verified work
   sitting uncommitted while other sessions may be running.
3. **After any `git pull` that touches `ps-automation.ps1`**, re-check that
   these load-bearing pieces still exist before trusting the file:
   UTF-8 console encoding block, `Await-WinRTOperation` (explicit
   `[type]$ResultType` param), `$TargetPid` parameters (NEVER `$pid` — it is a
   read-only PowerShell automatic variable; a `$pid` parameter throws at
   binding time and the handler returns null), DPI-awareness block, `click_at`
   command, command-id echo in `Write-Response`.

## Hard-won platform gotchas (do not re-learn these)

- **PowerShell 5.1 + pipes**: stdout defaults to the OEM codepage, which
  best-fits curly quotes (U+201C/D) into ASCII `"`, corrupting JSON in
  transit. `ps-automation.ps1` sets UTF-8 console encoding AND escapes
  non-ASCII as `\uXXXX` in `Write-Response`. Keep both.
- **`$pid`, `$PID` are reserved** in PowerShell — never use as a parameter or
  variable name.
- **WinRT COM objects** (`System.__ComObject`) cannot be reflected —
  `.GetType().GetInterfaces()` returns empty. Pass expected result types
  explicitly (see `Await-WinRTOperation`).
- **Chromium/Electron apps (Spotify)**: accessibility tree builds lazily on
  first UIA query; background/posted clicks are silently dropped (cua-driver
  reports `verified:false`) — escalate to `delivery_mode:'foreground'`.
- **pc-child protocol**: every command carries an `id`, echoed in the
  response; node drops mismatched ids as stale. Do not remove.

## Testing discipline

- No fix is "done" until live-verified against the running system (or the
  relevant oracle: `media_status` for playback, window title for Spotify).
  Plausible theories have been wrong 3+ times in this repo's history.
- Baseline: `node --test test/*.test.js` from `mythos/` — 2 known pre-existing
  failures (boot SIGINT-on-Windows, event-name allowlist). Anything else
  failing is a regression.
