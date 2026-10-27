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

`npm run dist` builds the packaged app (`electron-builder --win --publish never`)
and then scans what it built (`mythos/scripts/verify-package-contents.js`, below),
writing the scan receipt `dist/package-scan.json` only if the scan is clean.
Because
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

### The package scan: what may never ship

electron-builder packages the **working directory**, not the git tree, so a file
git ignores can still land in an installer. On 2026-09-23 a local build carried
four `.env` backups (`.env.bak-*`, `.env.pre-*.bak`) because `build.files`
excluded only the literal `mythos/.env`.

The rules now live in one place, `electron/package-policy.js`. At any depth and
in any case: every name containing `.env` (`.env`, `.env.bak-*`, `.env~`,
`.env - Copy`, `Nvidia NIM.env`), and `.pfx`/`.p12` certificates. At the app root
only: `config*.json*`, `keys*.json*`, `auth-sessions*.json*` and
`mythos-settings*.json*` (each file and the copies people make of it),
`.browser-agent.pid`, `vault/`, `vault_test_audit_*/` and `.tmp-*/`. A copy that
drops the name entirely (`env.txt`) is not caught, and neither is a secret pasted
into an ordinary file: the rules read names, not contents. `build.files` and
`mythos/.dockerignore` end with patterns generated from the policy, and
`test/package-policy.test.js` fails if either drifts.

`mythos/scripts/verify-package-contents.js` then reads the finished artifact:
`app.asar`, `app.asar.unpacked`, `extraResources` and the NSIS installer itself
(`--installer <file>` alone reads a published installer). Exit 0 means clean; 1
names each forbidden file and the rule it broke; 2 means something could not be
read, so nothing is proven. It reports names only. The only thing it extracts is
the `app.asar` container, to read its file list; it never opens a listed file.
If it names a file of yours, move it out of `mythos/` and build again. Do not add
a waiver to make a release go through.

### One command: `npm run release`

`scripts/release.js <patch|minor|major|x.y.z>` does the whole sequence below in
order, and refuses to start it unless every precondition holds — a dirty tree,
the wrong branch, an unpushed or un-pulled commit, an existing tag, a missing
`GH_TOKEN`, or a `build.publish` with no GitHub provider are all **blockers**,
reported together rather than one failed attempt at a time. Half a release (a
tag with no artifacts, artifacts with a stale version) is worse than none.

It is a **dry run** until you pass `--yes`; without it, it prints the exact
commands it would run. `--no-publish` builds and tags without uploading.

The order is **build, scan, re-check origin, commit and tag, push, upload**. The
build never uploads by itself. The scan must pass before anything is committed,
so a red scan leaves only the bumped version line in `package.json`
(`git checkout -- package.json` undoes it). origin/main is checked again after
the build, because the build takes minutes and another machine may push. The
upload (`scripts/publish-scanned-release.js`) sends only the files the scan's
receipt (`dist/package-scan.json`) names. It re-hashes each file first, then
reads GitHub's own SHA-256 for every uploaded file back. It **never replaces a
file on a published release**: onto an existing release it adds only the files
that are missing, succeeds without uploading if the release already holds the
scanned bytes, and refuses if any file there differs — to change a published
file, cut a new version. Each step that can fail prints its own recovery.

**The route that needs no personal token: `--ci`.**

```
node scripts/release.js patch --yes --ci
```

This bumps, builds and scans locally as a smoke test, commits, tags, and pushes
the branch and the tag — then `.github/workflows/release.yml` does the upload on the tag
push, using the `GITHUB_TOKEN` that GitHub scopes to this repository
automatically. Nothing to mint, store, or rotate, and no dependency on which
account the local `gh` happens to be logged in as. With `--ci`, a missing
`GH_TOKEN` is a warning rather than a blocker.

That workflow refuses a tag that disagrees with `package.json`'s version (such a
release is one electron-updater would never offer, since it compares semver) and
fails if `latest.yml` was not produced. It does not sign: no `CSC_*` is wired
into repository secrets, deliberately, until that decision is actually made.

Two things it warns about without blocking, because neither is fatal and both
have bitten this project: an **unsigned** build (no `CSC_LINK`), and a `gh` CLI
logged in as an account other than `build.publish`'s owner. `GH_TOKEN` is what
actually authorizes the upload, so a mismatched `gh` login is only a problem if
the token belongs to that same account — but discovering that after a full
build is how an evening gets lost.

### Publishing a release that the update check can actually see

1. **Tag the release, and upload only what was scanned.** Every build route
   passes `--publish never`. Without that flag electron-builder decides for
   itself, and it decides to upload under `npm run release` and on any CI run
   that can see a tag, which skips the scan. Never run
   `electron-builder --publish always`. The upload is
   `node scripts/publish-scanned-release.js <tag>`, after a clean scan.
   `GH_TOKEN` comes from the environment, never from a tracked file. The
   installer, its `.blockmap` and `latest.yml` are uploaded together, under the
   names `latest.yml` tells the updater to fetch; keep
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
3. **Signing is still worth buying, but it is no longer what gates updates.**
   Since 2026-08-11 the packaged app downloads a newer release in the background
   and installs it when the operator clicks (`autoDownload` is `true`,
   `autoInstallOnAppQuit` stays `false`, and `quitAndInstall` runs only from a
   `showMessageBox` choice or the HUD's Update button). This reverses the earlier
   "never auto-download while unsigned" rule, which rested on a wrong premise:
   `NsisUpdater.verifySignature()` returns `null` — i.e. passes — when
   `app-update.yml` carries no `publisherName`, so on an unsigned build the
   signature check is **skipped, not failed**. Refusing to download bought no
   verification; it only made every fix a manual reinstall. Integrity is still
   enforced by the `sha512` in `latest.yml`, which electron-updater checks against
   the downloaded file. What signing *would* add is protection against a
   compromised release host serving a validly-hashed installer — accepted here
   because anyone who can publish a release on this public repo can already
   publish its source. Set `MYTHOS_AUTO_UPDATE=off` to disable the whole thing.

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
