# Agent OS / MYTHOS — repo rules for AI sessions

## Open-source portability (binding for all code changes)

This is an open-source project. Anyone who supplies their own API keys
(brain/coding LLMs, STT, TTS — see `mythos/.env.example`) must be able to run
it on their machine. Therefore:

- **Never hardcode user-specific or machine-specific absolute paths** in
  tracked files. Derive everything from the environment:
  `%LOCALAPPDATA%`/`%USERPROFILE%`/`$env:TEMP` (PowerShell/batch),
  `os.homedir()`/`os.tmpdir()`/`process.env.*` (Node), `%~dp0`-relative
  paths (batch).
- **External binaries are optional**: cua-driver (and anything similar) must
  degrade gracefully when absent — spawn ENOENT → adapter stays OFFLINE →
  fallback paths take over. Never make boot or a core feature depend on an
  uninstalled binary.
- **All secrets and provider keys live in `mythos/.env`** (gitignored), with
  every supported key documented in `mythos/.env.example`. No key, no
  hardcoded default — features degrade honestly instead.
- Keep personal identifiers (usernames, local folder names) out of code
  comments, docs, and examples — use generic placeholders.

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
- Baseline (reproduced 2026-07-27, `node scripts/sync-test-count.js --check` /
  `mythos/scripts/sync-test-count.js`): **1197 tests, 1196 pass, 0 fail, 1
  skip.** The 1 skip is `test/sensors-file.test.js` honestly skipping via
  `t.skip()` — an environment-specific `fs.watch` crash on this Node/Windows
  build, not a real failure. There are currently no known deterministic
  failures — anything failing is a regression. (`wakeword.test.js` has shown
  one transient Windows `EPERM` directory-rename race under full-suite load;
  it self-resolves on rerun and is a test-fixture timing issue, not a code
  defect — rerun before assuming a regression, don't inflate the baseline to
  cover it.)
- README.md/ROADMAP.md test-count mentions are kept in sync with the real
  suite by `mythos/scripts/sync-test-count.js` (`--check` to verify, `--write`
  to fix) — run `--write` and commit the result whenever the test count
  changes, instead of hand-editing numbers in those files.
- CI workflow (`.github/workflows/ci.yml`) runs on push/PR to main and also
  gates on `sync-test-count.js --check`. Pre-commit hook
  (`.githooks/pre-commit`) blocks commits that raise test failures above
  baseline (0) or leave test-count docs stale — activate once per clone with
  `git config core.hooksPath .githooks`.
