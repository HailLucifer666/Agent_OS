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
- **External binaries are optional** — with one deliberate exception. cua-driver
  (and anything similar) must degrade gracefully when absent: spawn ENOENT →
  adapter stays OFFLINE → fallback paths take over.
  **Hermes-Agent is the exception**: since 2026-07-29 it is the only
  build-content engine (build-runner, the engagement build stage, and Forge all
  route through `src/core/effectors/build-engine.js`), and there is no
  brain.think fallback by design — a build with no engine FAILS with an install
  hint instead of shipping a plausible-but-wrong artifact. Boot still succeeds
  without it; only builds stop. It installs project-local into
  `<repo>/Hermes Agent/` (gitignored) via
  `node mythos/scripts/setup-hermes.js --install`, which clones from git and
  runs that clone's own installer — never `curl | bash` / `iex (irm …)`.
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

## Latest session update — read after pulling, then replace this section next session

This is a single, overwritten-in-place note (not an accumulating log — see
Wave 1's deletion of stale point-in-time handoff docs below for why). It
reflects the state as of commit `30385d7` (2026-07-27). Whoever picks this up
next should replace this whole section with their own summary rather than
appending to it.

**What shipped this session (24 commits, `f02a668`..`30385d7`, all on `main`,
already pushed to `origin/main`):**
1. **Test-truth fix** (`f02a668`): the pre-commit/CI gate was silently
   parsing the wrong `node --test` reporter format and would have blocked
   every commit had it ever been activated. Fixed; real baseline confirmed
   1197/1196/0/1 (see Testing discipline above). New
   `mythos/scripts/sync-test-count.js` keeps README/ROADMAP counts honest.
2. **Dead-code removal** (`91ae8b2`): deleted `app/` (31.6K LOC undeployed
   dead twin of the live UI), ~290 lines of dead code/config, the `dotenv`
   dependency (replaced with `process.loadEnvFile()`).
3. **HUD UI/UX overhaul** (`2eb79e0` .. `338d292`, 8 phases): CSS
   token-layer restructure, new `mythos/ui/public/js/dom.js` keyed-
   reconciliation primitive, focus-trap + modal fixes, a canvas
   text-alternative + 2 new aria-live regions, kanban keyboard navigation,
   responsive breakpoint consolidation, and a follow-up fix for a focus-drop
   regression the closing sweep itself found. All client-side — no wiring
   needed, loads automatically.
4. **pc-child fix** (`30385d7`): `launch_app` was returning a dead/wrong pid
   for Windows 11's MSIX-packaged Notepad (and any similarly-packaged app) —
   the activation stub exits within ~1s, or (single-instance apps) the new
   process never gets its own window at all. Fixed by resolving the real
   windowed process after launch instead of trusting `Start-Process`'s raw
   pid. **Still open, not fixed**: `focus_window` was reproducibly denied by
   Windows' foreground-lock in headless/no-app-focused test conditions, even
   with the existing `AttachThreadInput` workaround — unconfirmed whether
   this reproduces in real voice-driven usage where some app is normally
   already focused. If typing into a launched app still silently fails,
   re-test starting from a real app (not the bare desktop) having focus —
   that's the next thing to chase.

**Wiring needed on a fresh clone/pull:** `git config core.hooksPath
.githooks` (once per clone) — nothing else; no new deps, no build step.

**In flight, NOT in this push:** a background workflow was mid-run on the
originating machine live-verifying BUGS.md's ~16 previously-🔧-CODED bugs
and triaging ROADMAP.md's ~57 drift items. Its output (updated BUGS.md/
ROADMAP.md status lines, new `scripts/verify-live.js`/`scripts/
triage-drift.js`) was NOT part of this push and will land in a later commit.
If you see uncommitted changes to ROADMAP.md or new `verify-*.js` scripts in
`mythos/scripts/` on the originating machine, that's this in-progress work —
don't discard it.

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
