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
