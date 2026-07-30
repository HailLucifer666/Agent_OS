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

## ACTIVE BUILD — start here every session

**The MYTHOS × IRIS Pro-Plus parity build is in progress. It is tracked in git as
two documents that must be read together:**

> **`mythos/Plans/MYTHOS-IRIS-Synthesis-Plan.md`** — the roadmap/delta. Start here.
> **`mythos/Plans/MYTHOS-IRIS-Synthesis-Plan-V2-spine.md`** — the V2 spine (1,570
> lines): Anti-Drift Contract AD-1…AD-10, the frozen Gemini Live wire protocol
> (§3), the 23 frozen MYTHOS seams with line numbers (§4), full source for
> `live-session.js`/`live-tools.js`, the persona table, §7.1–§7.7, Electron.

Read the roadmap's **RESUME HERE** block first — it names the current position in
the merged execution order, the next action, and anything blocking. Do the next
unchecked `- [ ]` step, tick it only when **live-verified**, add a row to its
Progress log with the commit SHA, rewrite RESUME HERE, then commit and **push**.
A tick that isn't pushed does not exist as far as the next machine is concerned.
Do not start a third plan document. Precedence: the spine owns anything it
specifies at source level; the roadmap wins where it is more concrete or more
recent; V2 §18 breaks ties.

**Plans can hide outside the repo.** Claude Code plan-mode files live in
`~/.claude/plans/` under auto-generated names that match no sensible search
pattern — the V2 spine sat there as `deep-compare-this-floofy-heron.md` and a
rigorous repo-scoped search (`git log --all`, `git stash`, filename sweeps)
concluded it was lost. Check that directory before declaring any plan missing,
and copy anything load-bearing into the repo.

Two standing corrections that live in the roadmap: `/council` cannot convene on
this machine (`~/.claude/agents/` has 39 agents, zero `council-*.md`) — report
that, never synthesize a verdict. And the "two real test failures" the plan
predicts are **unconfirmed** — the pre-commit hook reports 0 failures over its
~140-file subset, so reproduce with a full `node --test` before fixing anything.

**Licensing gate before any release, paid or free (merged-order step 6.5):**
The operator confirmed on **2026-07-30 that MYTHOS will be sold later**, possibly
alongside a free basic demo tier — so this gate is live, not hypothetical, and a
free demo does not rescue it if it shares a codebase with the paid product.
`providers/edge-tts.js` and `services/edge-tts-server.py` label edge-tts
personal/hobby only; `THIRD_PARTY_NOTICES.md` records the openWakeWord **weights**
as CC BY-NC-SA 4.0 non-commercial. Planned fix: swap to Piper (MIT, local) and
train an own `hey_mythos` model with openWakeWord's Apache-2.0 tooling.

**Two corrections a fresh session must not re-derive wrongly.** First, those
edge-tts warnings are **self-authored in this repo** (`git blame` → `532106d8`),
not licence text from Microsoft or upstream — there is no Microsoft licence for
that endpoint at all, so the real exposure is Terms-of-Use and business risk,
plus the upstream Python package's own (still **unverified**) code licence.
openWakeWord's NC weights, by contrast, are a genuine upstream licence. Second,
this gate blocks **shipping, not building**: step 7's Electron work distributes
nothing until a release is published, so it may proceed in parallel. Full
analysis, the wider audit surface (Hermes-Agent, cua-driver, MediaPipe model
assets, provider ToS for resale) and the three decisions still needed from the
operator live in the roadmap's "Step 6.5" section. This never surfaces in
testing. Do not write a confident legal conclusion into any tracked file — that
is a lawyer's call, not a session's.

## Previous session update (2026-07-27, commit `30385d7`)

This is a single, overwritten-in-place note (not an accumulating log — see
Wave 1's deletion of stale point-in-time handoff docs below for why). It
reflects the state as of commit `30385d7` (2026-07-27). Superseded as the
starting point by the ACTIVE BUILD section above, but the gotchas and the open
`focus_window` bug it records are still live.

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
- Baseline (reproduced 2026-07-30 at commit `34659d8`, full `cd mythos &&
  node --test`): **1735 tests, 1734 pass, 0 fail, 1 skip, 0 todo.** The 1 skip
  is `test/sensors-file.test.js` honestly skipping via `t.skip()` — an
  environment-specific `fs.watch` crash on this Node/Windows build, not a real
  failure. There are currently no known deterministic failures — anything
  failing is a regression.
  - **The old "1197" baseline in this file was stale for days.** Until
    `42c2b48` (2026-07-30) all three gates — `sync-test-count.js`, the
    pre-commit hook and CI — globbed `test/*.test.js` **non-recursively**, so
    the 14 files under `test/assistant/` and `test/engagements/` (~188 tests)
    were invisible to every gate that had ever run here. All three now run a
    bare recursive `node --test`. Trust the number `sync-test-count.js` emits,
    not a hand-typed one.
  - The default reporter is **spec, not TAP**: grepping `^# tests` / `^# fail`
    silently matches nothing and looks like a clean run. The real summary lines
    are `ℹ tests` / `ℹ pass` / `ℹ fail`.
  - `wakeword.test.js` has shown a Windows `EPERM` directory-rename race under
    full-suite load. **It does NOT reliably self-resolve** (an earlier revision
    of this file claimed it does): it can strand the ONNX models in a
    gitignored `wakeword.test-backup/`, which silently kills wake word and is
    invisible to git. If you hit it, restore the models directory before
    trusting anything else.
  - A suite that exits 127 with no summary, or whose failures wander between
    files run to run, is Windows fork/commit-limit exhaustion from orphaned
    `node.exe` processes — not a regression. Count them
    (`@(Get-Process node -ErrorAction SilentlyContinue).Count`), kill strays,
    rerun.
- README.md/ROADMAP.md test-count mentions are kept in sync with the real
  suite by `mythos/scripts/sync-test-count.js` (`--check` to verify, `--write`
  to fix) — run `--write` and commit the result whenever the test count
  changes, instead of hand-editing numbers in those files.
- CI workflow (`.github/workflows/ci.yml`) runs on push/PR to main and also
  gates on `sync-test-count.js --check`. Pre-commit hook
  (`.githooks/pre-commit`) blocks commits that raise test failures above
  baseline (0) or leave test-count docs stale — activate once per clone with
  `git config core.hooksPath .githooks`.
