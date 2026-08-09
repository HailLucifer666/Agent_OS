# Contributing to Agent OS / MYTHOS

Thanks for considering a contribution. This project is open source and also
has a commercial track (see the root `CLAUDE.md`), so the workflow below is
enforced by CI and a pre-commit hook, not just a suggestion.

## One-time setup

```
git config core.hooksPath .githooks
```

Do this once per clone. It activates the pre-commit hook that runs the test
suite and the test-count/AD-7 checks below before every commit.

## Bring your own API keys

MYTHOS ships with no first-party keys. Copy `mythos/.env.example` to
`mythos/.env` and fill in whichever providers you have (brain/coding LLMs,
STT, TTS). `mythos/.env` is gitignored — never commit it. Features you don't
configure a key for degrade honestly (an install hint or an OFFLINE status),
they do not crash boot.

## Running the tests

Run the full suite from inside `mythos/`:

```
node --test
```

**The baseline is 0 test failures.** Do not open a PR that lowers it.

The default reporter is **spec, not TAP**. Do not grep for `^# tests` or
`^# fail` — those are TAP-format lines and silently match nothing here, which
looks like a clean run even when it isn't. The real summary lines look like:

```
ℹ tests 2488
ℹ pass 2487
ℹ fail 0
```

Before committing, also run:

```
node scripts/sync-test-count.js --check
```

This verifies README.md/ROADMAP.md's test-count mentions match the real
suite. If it fails, run it again with `--write` and commit the result instead
of hand-editing the numbers.

If a full run behaves strangely (exits 127 with no summary, or failures
that wander between files run to run), that is very likely Windows
fork/process-limit exhaustion from orphaned `node.exe` processes on your
machine, not a real regression — check your process count and kill strays
before assuming you broke something.

## AD-7: no machine-specific absolute paths

`test/anti-drift-no-absolute-paths.test.js` is an **enforced test**, not a
style guideline. It fails the build on any git-tracked file containing a
Windows drive-rooted path with two or more segments (a personal profile path,
a custom install directory, anything specific to one machine) or a Unix
`/home/<user>/...` path. Derive paths from the environment instead:
`process.env.LOCALAPPDATA`/`os.homedir()`/`os.tmpdir()` in Node,
`%LOCALAPPDATA%`/`%USERPROFILE%`/`$env:TEMP` in PowerShell/batch, `%~dp0`-
relative paths in batch. Run it directly with:

```
node --test test/anti-drift-no-absolute-paths.test.js
```

before opening a PR that touches docs or scripts — it's cheap to run in
isolation and catches this class of mistake before CI does.

## Building the desktop installer

`npm run dist` (electron-builder --win) builds the packaged app. Because
`build.publish` points at GitHub Releases, a build also produces the
**`latest.yml`** metadata and `.blockmap` that electron-updater polls, and
embeds `app-update.yml` in the packaged app — so the update check is live by
default: a packaged app polls GitHub Releases for this repo
(`HailLucifer666/Agent_OS`) and logs the outcome. Auto-update never
auto-installs; it only checks and logs (`electron/main.js`'s
`checkForUpdates()`), so a stale version is *reported*, never silently
replaced.

One thing is opt-in via an environment variable — **never** via a tracked file:

- **Code signing** — set `CSC_LINK` (path or URL to a `.pfx`/`.p12`
  certificate) and `CSC_KEY_PASSWORD` (its passphrase) before running
  `npm run dist`. These are electron-builder's own standard env var names; no
  package.json change is needed to use them. With neither set, the build
  produces an **unsigned** installer — that is the default, working case, not
  an error (`build.win.forceCodeSigning` is `false` on purpose). An unsigned
  build still *checks* for updates (a read against the releases API); what it
  cannot do is verify a downloaded installer (see below).

### Publishing a release that the update check can actually see

1. **Tag the release.** electron-builder's default publish policy is
   `onTagOrDraft`: a plain `npm run dist` on an untagged commit builds the
   artifacts and never attempts an upload. Publishing happens when the build
   runs on a tagged commit with `GH_TOKEN` set, or explicitly with
   `npx electron-builder --win --publish always`. `GH_TOKEN` comes from the
   environment — never from a tracked file. The GitHub provider uploads the
   installer, its `.blockmap`, and `latest.yml` together as a release; keep
   them together, because a `latest.yml` naming a file that is not beside it
   is how an update check "succeeds" and then fails at download time.
2. **Bump `version` in package.json** for each release. electron-updater
   compares semver: an installed app reports `update available — <new>`
   whenever the newest release is newer than what it runs, and
   `update not available` when it is not. (Live-verified 2026-08-10: a 0.1.0
   build against a 0.1.1 feed logged `update available — 0.1.1`; the same
   build against a same-version feed logged `already on the latest version`;
   and with no `MYTHOS_UPDATE_URL` it polled the embedded GitHub config and
   honestly reported no published versions.)
3. **Sign the release build if you want the signature check to mean anything.**
   On Windows, electron-updater verifies a downloaded installer against the
   installed app's publisher name; an unsigned build has nothing to verify
   against, so a compromised update host would be free to serve any executable.
   Today the exposure is nil only because nothing downloads or installs
   automatically (`autoDownload` is `false`, `quitAndInstall` is never called).
   Do not enable automatic download before the build is signed.

### Self-hosting instead of GitHub

`MYTHOS_UPDATE_URL` is a **client-side override** for anyone who wants a
self-hosted generic feed: the URL is read at runtime, so an already-installed
app needs no rebuild to start checking it. Set it, and the packaged app polls
`<url>/latest.yml` instead of the embedded GitHub config. That is client-side
only — it does not change what the release side must publish, which is still
the installer, its `.blockmap`, and `latest.yml` together on whatever host
serves the URL.

Neither variable is documented in `mythos/.env.example` — that file is for
the MYTHOS *server's* provider keys (brain/STT/TTS), which are a different
layer from the electron-builder/shell build-time config here.

## Directory-scoped rules

Some areas of the codebase have their own `CLAUDE.md` with rules specific to
that directory (PowerShell/WinRT adapters, the HUD, the core bus/leash).
Read the one next to whatever you're changing in addition to the root one.

## Pull requests

- Keep changes surgical — match existing style, don't reformat adjacent code.
- No hardcoded secrets, no new absolute paths (see AD-7 above).
- If you touch an effector or adapter, keep the evidence contract: return an
  oracle-backed `evidence` field or set `unverified: true` — never a bare
  `ok: true` for an action that changed the world.
- Describe what you tested and how in the PR description.
