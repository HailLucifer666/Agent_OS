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
Do not start a **fourth** plan document. There are now three, deliberately, and
that is the ceiling:

> **`MYTHOS-IRIS-Synthesis-Plan.md`** — the roadmap/delta for the active build.
> **`MYTHOS-IRIS-Synthesis-Plan-V2-spine.md`** — source-level detail for it.
> **`MYTHOS-Post-Parity-Plan.md`** — added 2026-07-31: everything that starts
> only *after* merged-order step 7 (social platforms, the multi-agent business
> layer, phone/multi-device control surfaces, multi-device wake-word
> arbitration). Downstream by construction; the roadmap wins on any overlap.

The original "no third document" rule existed to stop planning from living in
**untracked** files — that is how the V2 spine was nearly lost. All three are
tracked, cross-linked from each other, and none of them is a point-in-time
handoff note. Adding scope to an existing one is still preferred over creating a
new file.

Precedence: the spine owns anything it specifies at source level; the roadmap
wins where it is more concrete or more recent; V2 §18 breaks ties; the
post-parity plan never overrides either.

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

**Licensing gate before any release, paid or free (merged-order step 6.5 + 6.6):**
The operator confirmed on **2026-07-30 that MYTHOS will be sold later**, possibly
alongside a free basic demo tier — so the gate is live, not hypothetical, and a
free demo does not rescue it if it shares a codebase with the paid product.
`providers/edge-tts.js` and `services/edge-tts-server.py` label edge-tts
personal/hobby only; `THIRD_PARTY_NOTICES.md` records the openWakeWord **weights**
as CC BY-NC-SA 4.0 non-commercial. **Both labels are self-authored in this repo**
(`git blame` → `532106d8`/`29e9891`), NOT licence text from upstream.

**Licences VERIFIED 2026-07-30 against real upstream sources** (not this repo's
comments): the upstream `edge-tts` Python package (`github.com/rany2/edge-tts`,
PyPI `edge-tts` 7.2.8) is **LGPLv3** (LICENSE file + PyPI classifier); it is NOT
vendored anywhere tracked (`services/edge-tts-server.py` does `import edge_tts`
with no requirements.txt), so the repo ships a Combined Work expecting the user to
supply the library. openWakeWord's pretrained `.onnx` weights are **CC BY-NC-SA
4.0** (GitHub README + HuggingFace `davidscripka/openwakeword`, verbatim) while
the code/tooling is Apache-2.0 — the weights are a separate artefact under
separate terms, so reading only the code LICENSE and concluding "Apache for
everything" is a known trap.

**Three operator decisions answered 2026-07-30** (see the roadmap's 6.5 section):
(1) TTS stays **BYO** like the API keys — removes the LGPL exposure *without* a
Piper swap, so the planned swap is no longer required for TTS; the constraint
becomes "step-7 installer never bundles the LGPL package" + BYO docs, not a 6.5
code task; (2) free demo deferred; (3) the wider licence audit (Hermes-Agent,
cua-driver, MediaPipe assets, provider ToS for resale) split into its own tracked
**step 6.6**. One decision still deferred: how the paid product handles the NC
wake-word weights. This gate blocks **shipping, not building** — step 7 is
buildable in parallel. This never surfaces in testing. Do not write a confident
legal conclusion into any tracked file — that is a lawyer's call, not a session's.

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
   pid. **`focus_window`'s foreground-lock: question CLOSED 2026-08-17, and the
   answer is yes.** This entry used to ask whether the denial reproduces in
   real voice-driven usage with an app already focused. It does — the
   2026-08-17 session hit it on pid 17996 under exactly those conditions
   (BUG-272 T3), with all three ladder rungs already run and the error string
   saying so. **Ladder exhausted; do not add a 4th rung** — Windows is refusing
   deliberately and the alternatives are unreliable or user-hostile. It now
   fails honestly, and `focus_window`'s stale-pid failure names `list_windows`
   as the recovery step. Details in `mythos/adapters/CLAUDE.md`.

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

## Directory-scoped rules (spine §13)

Some hard-won operational knowledge now lives next to the code it describes
instead of here — read the relevant one before editing in these areas:

- `mythos/adapters/CLAUDE.md` — PowerShell/WinRT/pc-child gotchas (OEM
  codepage JSON corruption, `$pid` being reserved, WinRT reflection,
  Chromium/Electron click delivery, the command-id-echo protocol, MSIX
  SendInput blocking, caret-vs-foreground-window, foreground-lock).
- `mythos/ui/CLAUDE.md` — HUD rules (no build step, audio worklets, canvas).
- `mythos/src/core/CLAUDE.md` — bus/leash/dispatch invariants.

This root file keeps only what's genuinely global: open-source portability,
concurrent-session safety, the ACTIVE BUILD pointer, the licensing gate, and
testing discipline (below).

## Testing discipline

- No fix is "done" until live-verified against the running system (or the
  relevant oracle: `media_status` for playback, window title for Spotify).
  Plausible theories have been wrong 3+ times in this repo's history.
- **Baseline: 0 failures, 0 skips. The test COUNT is deliberately not written
  here.** Three different numbers have sat in this paragraph and every one of
  them went stale — 1197, then 1735, then 2488, each presented as current while
  the real suite had moved on by hundreds of tests. A number a human types is a
  number nobody updates, and this file is read at the start of every session, so
  a stale one here misleads more effectively than it informs. Removed 2026-08-19
  rather than corrected for a fourth time.
  - Get the real figures from the thing that measures them:
    `cd mythos && node scripts/sync-test-count.js --check`. It prints
    `tests=… pass=… fail=… skipped=…` plus the effector/provider/sensor counts,
    and it is the same code the pre-commit hook and CI run. Trust its output
    over any number written in prose, here or in a plan document.
  - What IS stable, and what this baseline actually asserts: **fail=0 and
    skipped=0.** There are no known deterministic failures — anything failing is
    a regression. A run that reports 1 skip is almost always the short-`TEMP`
    artefact described below (`test/sensors-file.test.js`), not a real skip.
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
  - `wakeword.test.js`'s Windows `EPERM` directory-rename race is **FIXED as of
    2026-08-04, at the root rather than worked around.** Historical shape, kept
    because the failure mode generalises: the test used to arrange
    "models present" vs "models absent" by `renameSync`-ing the operator's real
    `ui/public/models/wakeword/` aside and back, because the
    `/api/config/wakeword` route `statSync`ed a hardcoded path with no seam.
    Under full-suite load that rename lost an EPERM race and stranded the real
    `.onnx` weights in a gitignored `wakeword.test-backup/` — wake word silently
    dead, and **invisible to git because both directories are ignored.** It did
    NOT self-resolve (an even earlier revision of this file claimed it did,
    which is how it survived as a known issue instead of being fixed).
    `routes/config.js` now takes an injectable `wakewordModelsDir`, so the test
    points at a temp directory and cannot touch real models at all; a guard test
    pins that production still resolves the real path, so the seam cannot
    silently break the feature it was added to protect. **The general lesson
    stands: a test that mutates real, gitignored user data to fake a state can
    destroy that data invisibly. Inject the path instead.**
  - **A green suite cannot tell you the Electron app boots. Proven 2026-08-04.**
    Slice 5 (cursor overlay) shipped with 16 passing tests, a walked installer
    artifact and 2598 green tests — and the shell would not start at all:
    `Error: The 'screen' module can't be used before the app 'ready' event`.
    Two rules came out of it, both cheap and both now test-pinned:
    - **Electron APIs gated on `app.ready` (notably `screen`, `powerMonitor`,
      `session`) must not be *property-accessed* before `whenReady` — and a
      defensive `typeof x.method !== 'function'` check counts as access.** Those
      exports are lazy getters that throw. In this case the guard *was* the
      crash. `electron/main.js` requires such APIs lazily at their use site
      (`session`, `desktopCapturer`, and now `screen`); follow that, never a
      module-scope destructure.
    - **An opt-in flag protects nothing that runs before the flag is read.** The
      overlay was gated behind `MYTHOS_CURSOR_OVERLAY_ENABLED` (default off), but
      the controller was constructed unconditionally *above* where the flag was
      parsed — so the app died for everyone, including with the feature disabled.
      Construct optional subsystems inside the `if (FLAG)`, not before it.
    Why no test caught it: unit tests inject a fake `screen`, so they are blind
    to load order, and one of them actively *required* the eager property read.
    Source-shape assertions on `main.js` are the only automated guard available
    (see `test/electron-cursor-overlay.test.js`) — **a slice is not verified
    until the app actually starts.**
  - **The full suite cannot run clean while a MYTHOS instance is running, and it
    looks exactly like a regression.** Two tests bind the REAL default ports
    rather than ephemeral ones: `test/boot.test.js` spawns `src/main.js` (port
    **4478**) and `test/proactive-speak-live-routing.test.js`'s legacy path needs
    the edge-tts server (port **5050**) — the same two ports the desktop launcher
    frees on start. With the app open they fail as `EADDRINUSE ... 127.0.0.1:4478`
    and "the legacy (no Live session) path must still complete a proactive turn",
    which reads like broken code and is not. Run the suite (and any commit, since
    the pre-commit hook runs it too) with overrides instead of killing the
    operator's session:
    `MYTHOS_PORT=4999 EDGE_TTS_PORT=5099 EDGE_TTS_URL=http://127.0.0.1:5099`.
    Note `MYTHOS_PORT=0` is NOT valid — the schema enforces min 1024, so it fails
    as a config error rather than picking an ephemeral port. Distinct from the
    fork-exhaustion entry below: here the failures are the SAME two files every
    time, not wandering.
  - A suite that exits 127 with no summary, or whose failures wander between
    files run to run, is Windows fork/commit-limit exhaustion from orphaned
    `node.exe` processes — not a regression. Count them
    (`@(Get-Process node -ErrorAction SilentlyContinue).Count`), kill strays,
    rerun.
  - **A short (8.3) `TEMP` kills any test that spawns a server with a temp
    vault, and it looks like a dead server. Seen 2026-08-08.** Some shells —
    notably an agent/tool shell — export `TEMP`/`TMP` in Windows' 8.3 short
    form, i.e. with the profile folder written as `<NAME>~1` rather than the
    full account name. `os.tmpdir()` inherits that short
    form, so `fs.mkdtempSync()` hands the server a short-name vault path, and
    the watcher over it trips a libuv bug: the child aborts with
    `Assertion failed: !_wcsnicmp(filename, dir, dirlen), file
    src\win\fs-event.c, line 72` and exit code 3221226505
    (`0xC0000409`). The test then reports only the symptom —
    `connect ECONNREFUSED 127.0.0.1:<port>` after its full timeout — because
    the spawned child's stderr is captured and never printed
    (`deploy-config-conformance.test.js`'s "real boot" test is the one that
    bites). Same libuv fault as `sensors-file.test.js`'s honest `t.skip()` —
    and that skip is the same artefact: with a long-form `TEMP` the file does
    not skip at all, so the truthful baseline on this machine is **0 skipped**,
    not 1. A committed test count that carries a skip was measured in a shell
    with the short form.
    Confirm by re-running with `TEMP` and `TMP` both set to the long-form
    equivalent of `%LOCALAPPDATA%\Temp` (spell the profile folder out in full,
    no `~1`) before `node --test` — and only then start looking for a
    regression.
- README.md/ROADMAP.md test-count mentions are kept in sync with the real
  suite by `mythos/scripts/sync-test-count.js` (`--check` to verify, `--write`
  to fix) — run `--write` and commit the result whenever the test count
  changes, instead of hand-editing numbers in those files.
- CI workflow (`.github/workflows/ci.yml`) runs on push/PR to main and also
  gates on `sync-test-count.js --check`. Pre-commit hook
  (`.githooks/pre-commit`) blocks commits that raise test failures above
  baseline (0) or leave test-count docs stale — activate once per clone with
  `git config core.hooksPath .githooks`.
