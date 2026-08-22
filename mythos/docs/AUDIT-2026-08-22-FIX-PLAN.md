# Fix all fifteen — handoff plan

## Context

A two-pass `/kee` audit of MYTHOS on 2026-08-22 found fifteen problems: one real
security hole, several places where the system reports success it hasn't earned,
some missing safety nets, and a few pieces of housekeeping. They are written up
in `mythos/docs/AUDIT-2026-08-22-defect-classes.md` (committed as `138ac46`).

Nothing has been fixed yet. That document is the diagnosis; this is the
treatment. The operator's instruction is that all fifteen get fixed properly
before any new feature work starts.

**Two things every agent picking this up must know.**

First, the operator is a vibe coder. Explain what you did in plain English in
every message and every commit body. "The guard checked one address and
connected to a different one" beats "TOCTOU in the SSRF predicate". Write the
code however the codebase demands; write the *explanation* like you're telling a
smart person who doesn't work in this file.

Second, this repo's prime rule: **a fix without a test is not a fix, it is a
claim.** Every item below ships a test that fails on the old code and passes on
the new one. Write the test first, watch it go red, then fix. If a test is
genuinely impossible, say so in the commit message and state what proof replaces
it. Never silently skip one.

---

## Ground rules for the whole job

**Running the tests.** The suite is unreliable unless you set these first. Two
things matter and both have cost real hours here:

```bash
export TEMP="<long-form %LOCALAPPDATA%>/Temp" TMP="<long-form %LOCALAPPDATA%>/Temp" MYTHOS_PORT=4997 EDGE_TTS_PORT=5097 EDGE_TTS_URL=http://127.0.0.1:5097
```

Spell the profile folder out in full. Windows exposes the same folder under two
names — a readable one and an abbreviated `NAME~1` form — and some agent shells
export the abbreviated one. Node's file watcher has a bug that is triggered only
by the abbreviated spelling, which makes three unrelated tests fail in a way
that looks exactly like a real regression. `echo $TEMP`; if you see a `~1` in
it, rewrite it before running anything.

The full suite takes 2–5 minutes depending on machine load. Run it in the
background — a foreground run will hit the 10-minute tool ceiling when the
machine is busy.

**Another session shares this checkout.** A second Claude session was
committing into this same folder during the audit. Symptoms: files changing
under you, the suite failing differently on every run, wall-clock doubling. If
you see that, it is not your bug. Check `git log --oneline -3` and
`git status --short` before concluding anything.

**Landing the work.** Make a new branch off current HEAD. Commit each finding
separately, naming only the files you touched, so a later problem can be traced
to the one fix that caused it. Open one pull request per phase, not one for all
fifteen. Never push straight to `main`; never use `--no-verify`; never commit
past a red test run.

**Bug numbers.** BUG-301 and BUG-302 are taken. Start new ones at **BUG-303**
and check with `grep -rhoE "BUG-3[0-9]{2}" --include=*.js --include=*.md .`
before claiming one — the numbers live in code and test filenames, not just
`BUGS.md`.

**Order matters.** Phase 0 comes first because everything after it depends on
being able to trust a green test run. Phase 1 is the security hole and is next
because security work is never deferred for scoring low. After that the phases
are independent and can be reordered if something blocks.

---

## Phase 0 — make the test gate trustworthy

*One item. Do this before anything else.*

**STATUS: DONE — commit `df85fff`.** The plan predicted three faults; there were
four. The fourth was line endings: `core.autocrlf` is on here and `.githooks`
carried no attribute, so a fresh clone would have received a hook whose shebang
ended in a carriage return and therefore never ran at all, while
`git config core.hooksPath .githooks` still reported success. `.gitattributes`
now pins `.githooks` and `*.sh` to LF.

The temp-path fault was also worse than described. Git does not pass the
invoking shell's `TEMP` to a hook — it sets `TEMP=/tmp`, which contains no
`~1`, so the check the plan proposed would have been inert in the only place it
mattered. (It was written that way first, and it was.) Git Bash's `/tmp` maps to
the short-name temp folder, so the suite has been receiving the broken path on
**every gated commit this repo has ever run**. The hook now asks node what temp
directory the suite will use and expands it, unconditionally. Measured:
`deploy-config-conformance.test.js`'s real-boot test dies at 30,138ms under the
short path and passes 9/9 under the expanded one — a failure that had been
written off as flakiness.

### Item 15 — the suite lies to you under the wrong conditions

**Plain English.** Three separate things make the test suite report failures
that aren't real: a Windows temp-folder quirk, the MYTHOS app being open and
holding the ports the tests want, and heavy machine load. Every agent who works
on this will waste an hour on it exactly once. During this audit alone the same
unchanged code reported 1, then 3, then 2, then 0 failures across four runs.
Fix the gate so it either sets things up correctly by itself or refuses to run
and says why.

**What to change.** `.githooks/pre-commit` (20 lines, read it first).

1. Normalise the temp folder inside the hook itself. If `TEMP` or `TMP` contains
   a `~1`-style short name, rewrite both to the long form before running
   anything. Windows exposes both spellings for the same folder; one of them
   trips a bug deep in Node's file watcher and kills any test that spawns a
   server with a temp folder.
2. Set `MYTHOS_PORT`, `EDGE_TTS_PORT` and `EDGE_TTS_URL` to non-default values
   inside the hook, so a running MYTHOS instance can't collide with the suite.
   Note `MYTHOS_PORT=0` is invalid — the config schema enforces a minimum of
   1024.
3. Replace the current `tail -40` of raw output on failure with the actual list
   of failing test names. Grep the `not ok` lines out of the report. Right now a
   blocked commit tells you almost nothing.

**The test.** Add `mythos/test/precommit-hook-environment.test.js`. Read the
hook as text and assert all three properties are present: it normalises short
temp paths, it sets the three port variables, and it surfaces `not ok` lines.
This is a source-shape test, so keep the assertions loose — check for the
presence of the mechanism, not exact spacing — and say in a comment why a real
end-to-end test isn't possible here (running the hook runs the whole suite).

**Done when.** A full run with the app open and no manual environment setup
comes back green, and a deliberately broken test produces a message naming it.

---

## Phase 1 — the security hole

*One item. Not deferrable regardless of how it scores.*

**STATUS: DONE — BUG-303.** Reproduced at HEAD before fixing (`ok=true`, the
loopback service's body returned to the caller), then fixed as the plan
describes: `guardedLookup` in `net-address.js`, Node's built-in client in place
of `fetch()`, zero new dependencies. 13 new tests, mutation-tested 6/6, and
live-verified against two real public pages over HTTPS including a gzipped one.

Two things the plan did not anticipate, both now pinned by tests. Node 26 turns
`autoSelectFamily` on by default, so the socket calls the resolver with
`{ all: true }` and expects an **array** of records — a replacement handling only
the single-address shape breaks every connection it touches. And the
`ssrfBlocked` tag that was supposed to stop the Jina fallback retrying a blocked
request was never read by anything: the `catch` treated a refusal exactly like a
slow site and re-sent the same target through `r.jina.ai`. Fixed in the same
commit, since a comment claiming a mechanism works is what kept it hidden.

Three tests in `web-fetch-ssrf.test.js` stubbed `global.fetch` and were
repointed at the new transport seam. What they assert about the redirect loop is
unchanged, because the loop is unchanged.

### Item 1 — the internet guard checks one address and connects to another

**Plain English.** When MYTHOS fetches a web page, it first looks up the site's
address and refuses if that address is inside your own network — your machine,
your router, a cloud metadata service. Good. But after it approves the address,
it hands the *website name* to the fetch call, which looks the name up a second
time. An attacker who owns a domain can answer the first lookup with a harmless
public address and the second one with `127.0.0.1`. The guard approves, the
connection goes somewhere else entirely. The comment in the code says this
"catches DNS rebinding attacks" — it is the rebinding hole itself.

This is reachable: `web_fetch` is offered to the model as a harmless, no-approval
tool, and your own machine serves the MYTHOS API on port 4478.

**What to change.** `mythos/src/core/effectors/web-fetch.js` and
`mythos/src/core/effectors/net-address.js`.

The principle: the check and the connection must share one answer. Node's
built-in networking lets you supply your own address-lookup function that runs
*at the moment of connecting*. Use that.

1. Add `guardedLookup` to `net-address.js`, next to the existing
   `isPrivateAddress`. It does a normal lookup, then runs every returned address
   through `isPrivateAddress`, and fails the connection if any of them is
   internal. Export it.
2. In `web-fetch.js`, replace the `fetch()` call with a small request helper
   built on Node's built-in `https`/`http`, passing `guardedLookup`. It needs to
   handle: the one `User-Agent` header, a 15-second timeout, the status code,
   the `content-type` header, and reading the body as text. The redirect loop in
   `guardedFetch` is already written by hand and carries over unchanged — keep
   it, and keep every hop re-checked.
3. Watch out for compression. The old `fetch()` silently un-gzipped responses;
   the built-in client does not. Either ask for uncompressed content or
   un-gzip it yourself, or pages will come back as binary garbage.

**Why not just add a library.** There is a package (`undici`) that would make
this a three-line change. Two reasons against it: the project advertises having
only nine add-ons and treats that as a feature, and the package isn't properly
installed here anyway — it's sitting in a shared folder as somebody else's
leftover, so a fresh copy of the project wouldn't have it. Zero new add-ons is
the right trade for one fix.

**The test.** New `mythos/test/bug-303-ssrf-rebinding.test.js`. Stand up a
throwaway local server. Point the fetch at a hostname whose lookup returns a
public address the first time and a loopback address the second. On the old
code the request completes and returns the local server's body; on the fixed
code it is refused. Also add a direct unit test of `guardedLookup` on its own.

**Done when.** The rebinding test goes red on the old code and green on the
new, the existing `web-fetch` tests still pass, and a real fetch of a normal
public page still returns readable text.

---

## Phase 2 — stop reporting success that wasn't earned

*Four items. This is the phase that matters most to trusting what MYTHOS tells
you.*

### Item 2 — the ship gate checks a filename, not a file

**Plain English.** Before a build is marked "shipped", a gate checks that the
required steps happened. For the "artifact" step it checks that a file *path*
exists as a piece of text — not that a file exists at that path. For the
smallest class of job the path check is the *only* check, so a card can be
marked done when nothing was ever written. This exact mistake has already been
caught twice elsewhere in this codebase, and the comments recording both are
still in the files.

**What to change.** `mythos/src/core/effectors/evidence-validator.js` and one
line in `mythos/src/main.js`.

`createEvidenceValidator()` currently takes no arguments. Give it the vault file
handle: at `main.js:437` it becomes `createEvidenceValidator({ fs: memory.fs })`
— `memory.fs` is already in scope there, the next two lines use it. Then in
`verify()`, the artifact check becomes: the path must exist, the file must exist
on disk, and the file must not be empty. Strip the `/vault/` prefix the same way
`agent-actions.js:381` already does.

Keep the gate refusing when the handle is missing rather than skipping the
check. A gate that quietly stops checking is worse than no gate.

**The test.** New `mythos/test/bug-304-ship-gate-requires-a-real-file.test.js`.
Three cases: a card whose artifact path points at a file that was never written
(must be blocked), one pointing at an empty file (must be blocked), one pointing
at a real file with content (must pass). Use the smallest risk class, since that
is the path with no other check behind it.

### Item 5 — the build engine blames the wrong thing when it times out

**Plain English.** When a build hangs, the error says the model was probably
waiting for an approval it could never get. During the recent BUG-301 incident
that was wrong — the engine had crashed on startup and said so on its error
output within two seconds, but the adapter waited the full ten minutes and then
printed the misleading explanation. Three builds died that way.

**What to change.** `mythos/adapters/dsh-agent/index.js`, around the timeout
branch at line 684.

Two parts. First, watch the error output while the process runs, and if a
fatal startup signature appears, stop immediately with that message instead of
waiting out the clock. Second, soften the timeout message: state what is known
(no result within N ms, here is the error output) and offer the approval-prompt
theory as one possibility rather than the diagnosis. Never let a guess outrank
the evidence sitting right next to it.

**The test.** New `mythos/test/bug-305-fail-fast-on-fatal-stderr.test.js`. Feed
the adapter a fake child process that prints a known fatal startup line and then
hangs. Assert the call returns in well under the timeout and that the returned
error contains the actual output, not the approval-prompt sentence. The real
measured numbers from the incident are in `BUGS.md` under BUG-301: 600,000 ms
before, 1,858 ms after — quote them in the commit body.

### Item 6 — a ten-minute engine failure left no trace in the log

**Plain English.** When those three builds died, the server log said nothing at
all. The only record was buried in a separate audit trail. If something fails
for ten minutes, the log is the first place anyone looks, and it was empty.

**What to change.** `mythos/adapters/dsh-agent/index.js`, in the `catch` block
of `runTask` that already records `lastTaskFailure` (near line 715). It already
captures everything needed; it just never writes it out. Add a warning log line
with the model used, the elapsed time, and the first part of the error output.
Check how the adapter gets its logger — if it hasn't got one, follow the pattern
`websearch-child.js` uses.

**The test.** Add to the same BUG-305 file. Pass in a fake logger that records
what it was told, run a failing task, and assert a warning was emitted naming
the failure. Do not test this by grepping console output — this codebase's
logger is silent under test, so that would pass while proving nothing.

### Item 4 — a failed save of your conversation history is completely silent

**Plain English.** Every so often MYTHOS writes your session history to disk.
If that write fails, the code catches the error and throws it away — no log, no
warning, nothing. Next time you start up, your history is missing or stale and
it looks like a fresh start rather than a failure.

**What to change.** `mythos/server/index.js:2759`. The line is
`try { memory.fs.writeJSON(SESSION_PATH, …); } catch (_) {}`. Keep it
best-effort — a failed history write should not break the running system — but
log the error and the path. Best-effort is fine; invisible is not.

**The test.** New `mythos/test/bug-306-session-write-failure-is-logged.test.js`.
Inject a vault handle whose write throws, inject a recording logger, trigger the
save, assert the error was logged and that the surrounding request still
succeeded.

---

## Phase 3 — remove dangerous surface instead of guarding it

*Two items. Both follow the same principle: if nothing uses a risky option,
delete the option rather than defend it.*

### Item 3 — a caller can switch off the build engine's safety settings

**Plain English.** Before running a build, MYTHOS builds a clean set of
environment settings and deliberately decides two of them itself: whether the
build is allowed to write files, and a flag that makes the engine start at all.
The comment even says these are MYTHOS's call, not inherited. But the very last
line of that function merges in anything the caller passed, and later values
overwrite earlier ones — so a caller can turn both off.

Nothing in the app actually passes anything there. The whole option is unused.
So delete it rather than protect it.

**What to change.** `mythos/adapters/dsh-agent/index.js:441`. Remove the
`opts.extra` merge and the `extra:` argument that feeds it from `runTask`
(around line 678), plus the now-unused `opts.env` parameter. Confirm first with
a search across `src/` and `adapters/` — at audit time the only mention was the
forwarding line itself. If a genuine caller has appeared since, then instead
move the merge *above* the two decided settings so they always win, and say in a
comment why.

**The test.** Extend the existing
`mythos/test/bug-301-build-engine-under-electron.test.js` rather than adding a
file — it already owns these two settings. Add a case asserting a caller cannot
override either the write permission or the start-up flag. This is the case that
file is currently missing.

### Item 7 — the vault path helper doesn't keep anything inside the vault

**Plain English.** There's one helper that turns a short name into a full file
path inside MYTHOS's data folder. It does no checking at all, so a name
containing `..` would walk straight out of the folder. Four different places in
the code each wrote their own protection against this, in three different
styles. Two places wrote none. Nothing can currently exploit it — no model tool
or web route can reach those two places with a name it controls — but it is one
careless parameter away, and the right fix is to make it impossible in the
helper rather than add a fifth guard.

**What to change.** `mythos/src/core/memory/fs-store.js:118`. Make `vaultPath()`
refuse any result that lands outside the vault root and throw a message naming
the offending name. Two details: calling it with no arguments legitimately
returns the vault root and must keep working, and the comparison must be against
the root plus a path separator so a sibling folder with a similar name can't
sneak through.

Then remove the now-redundant hand-rolled checks in `from-runner.js:150` and
`from-docs.js:39` — leaving four implementations of one rule is how they drift
apart. Leave `from-okf.js`'s `badSegment()` alone: it rejects bad names with a
helpful message before they ever reach the filesystem, which is a different and
better-placed job.

**The test.** New `mythos/test/bug-307-vault-path-containment.test.js`. Feed the
helper hostile names — `..`, a nested `../..`, an absolute path, a Windows
drive letter, a name with a mix of slash styles — and assert each throws. Assert
the no-argument call still returns the root, and that ordinary names still
resolve. Then run the whole suite: this helper is used everywhere and something
legitimate may be relying on loose behaviour. If so, that is a finding, not a
reason to weaken the check.

---

## Phase 4 — safety nets and stopping repeats

*Three items.*

### Item 8 — one stray error can kill the whole system with no message

**Plain English.** MYTHOS's brain runs as a separate program launched by the
desktop app. Modern Node shuts a program down instantly if an error escapes from
background work. The desktop app has a catcher for this; the program that
actually does everything does not. So a single escaped error kills MYTHOS
outright and writes nothing anywhere explaining why.

I checked the two most likely sources and both are safe today. This is a
missing net, not a known leak — but the net costs almost nothing.

**What to change.** `mythos/src/main.js`, near the top, before anything is
started. Add handlers for escaped background errors and uncaught errors that log
the full details through the existing logger. Follow the shape already in
`electron/main.js:136` and `:153`.

Decide deliberately whether to keep shutting down after logging. Recommended:
log, then exit — a system in an unknown state should stop honestly rather than
carry on. Whichever you choose, write the reason in a comment.

**The test.** New `mythos/test/bug-308-server-logs-before-it-dies.test.js`.
Start the real server as a child process, make it throw an escaped background
error, and assert the log contains the details before the process exits. Use the
port overrides from the ground rules or this test will fight a running app.

### Item 9 — the same startup mistake has now been made twice

**Plain English.** When MYTHOS launches a helper program, it has to tell the
system "run this as a plain program, not as the desktop app". Forgetting that
flag has now caused two separate bugs — the web-search helper, and the build
engine. Each got its own individual test. Nobody wrote the rule down in a way
that catches the third one.

**What to change.** No production code. Add
`mythos/test/spawn-runs-as-node-guard.test.js`: scan every file under
`mythos/src` and `mythos/adapters` for a launch of the program's own executable,
and assert that each one either sets the flag or inherits an environment that
already has it.

Three sites already exist and all three are correct — do not "fix" them. Two set
the flag directly; `server/routes/components.js:184` correctly inherits it.
The guard must recognise the inheriting form or it will report a false alarm on
day one.

Crucially: **prove the guard works by breaking something.** Temporarily delete
the flag from the web-search helper, confirm the guard goes red, then restore
it. A guard that has never gone red is not known to work. Note in the test's
comment that this was done.

### Item 10 — one test asserts a thing that isn't always true

**Plain English.** A test that checks the build engine's health check has three
possible outcomes but the test only allows for two. It passes today by accident
— on a different machine, or after a real build failure, it would fail for no
good reason. This is the second time this same test has had this same problem;
the last version passed on the developer's machine and failed on the build
server.

**What to change.** `mythos/test/immune.test.js`, the block starting around
line 652.

Two bugs in it. The error branch asserts the engine is offline, but one of the
three error outcomes reports the engine as *online* with a recently failed build.
And the third outcome returns its details in a different shape, so the check
above it fails before reaching the line written to handle it — that line is
dead.

Rewrite so all three outcomes are accepted, each with the assertion that is
actually true of it. The property being pinned is: a health check is never
announced as a completed repair, and the system never stays silent about the
engine's state.

**The test is the fix here.** Prove it by forcing each of the three outcomes.
The engine-absent one can be produced without touching the real installation by
intercepting the module load and replacing the two health functions — that
technique was used during the audit and works. Say in a comment how to reproduce
each branch, so the next person doesn't have to rediscover it.

---

## Phase 5 — housekeeping, done properly

*Four items. Small, but each is a thing that would otherwise quietly rot.*

### Item 6b — the two loose ends from BUG-301 have no ticket

Once Phase 2 lands, items 5 and 6 above *are* those loose ends. Update the
BUG-301 entry in `BUGS.md` to point at the new bug numbers and mark them
resolved, so nothing is left living only inside another bug's prose.

### Item 11 — one document was deleted, another is untracked

**Plain English.** A 1,433-line explainer page was deleted but the deletion was
never committed, and a 42 KB "capability map" page is sitting in the folder
unrecorded. That second file was created outside version control, which is
exactly the situation that nearly lost a critical planning document once before.

**This is the one item I am guessing on, and the executing agent should confirm
before acting.** My reading is that the capability map replaces the explainer.
If so: commit the deletion, rename the new file to `MYTHOS-CAPABILITY-MAP.html`
(the current name has a `·` in it, which causes trouble in scripts and URLs),
and commit it. If the operator says both should stay, restore the explainer too.

Nothing links to the deleted file except historical notes, and the new file is
clean — no personal paths, no keys. Both were checked.

No test — this is version control housekeeping. Say so in the commit message.

### Item 12 — a skill's score can't tell "never tried" from "always fails"

**Plain English.** Each saved skill keeps a success score. Zero is used to mean
both "we've never measured this" and "this fails every time". In practice the
score never quite reaches zero once measuring starts, so only the very first use
is affected — and treating that as "never measured" happens to be correct. It is
a real ambiguity with almost no consequence.

**What to change.** `mythos/src/core/memory/skills.js:161`. Use the existing
`uses` counter to decide whether this is the first measurement, instead of
overloading the score itself.

**The test.** Extend the existing skills tests: a skill recorded as failing
twice, then succeeding once, must end with a low score, not a perfect one.

### Item 14 — ninety-four places that throw errors away

**Plain English.** There are 94 spots that catch an error and do nothing. Almost
all are harmless — closing a browser, closing a socket, trying the next way to
read a file. One mattered and is fixed in Phase 2 as item 4.

**Do not sweep all 94.** That would be a huge diff of no value and real risk.
Instead write down the standing decision: add a short note at the top of
`mythos/docs/AUDIT-2026-08-22-defect-classes.md` recording that the 94 were
reviewed on this date, that only the session-history one was load-bearing, and
what makes one load-bearing (does anything downstream depend on this having
happened?). That turns a shrug into a decision the next auditor can build on.

---

## Phase 6 — the big file split

*One item. Last, because it is the largest and riskiest, and because everything
above should be locked in by tests before this much code moves.*

### Item 13 — two files are far over the size limit

**Plain English.** The house rule is under 800 lines per file. `server/index.js`
is 4,654 and `electron/main.js` is 2,567, with nine more files between 800 and
1,700. Big files hide bugs and make two people editing at once collide.

**Recommended approach — split one file, document the other.**

For `server/index.js`: move whole groups of related web routes out into
`mythos/server/routes/*.js`. That folder already exists and already holds files
in exactly this shape, so you are following the existing pattern, not inventing
one. Rules: move code, never edit it in the same commit; one route group per
commit; run the full suite between each. If a group needs changing to move, that
is a separate commit before or after, never combined.

For `electron/main.js`: **do not split it.** This file has documented ordering
traps where simply *mentioning* a desktop API too early crashes the app for
everybody, including with the feature turned off — that has happened here
before, and the tests cannot see it because a green suite cannot tell you the
desktop app starts. Instead, record the decision as a comment at the top of the
file explaining why it stays whole, and add a test pinning the current structure
so nobody splits it by accident. The rule this repo follows is that a deliberate
non-fix gets written down with a test, not left implicit.

**The test.** A file-size guard listing the two accepted exceptions by name with
their reasons, failing on any *new* file over 800 lines. That way the debt can
shrink but cannot grow.

**Done when.** `server/index.js` is under 800 lines or has a written plan for
the remainder, `electron/main.js` carries its documented exception, the guard is
in place, and the full suite is green after every single commit.

---

## Verification — how to know the whole job is done

Run these in order, from `mythos/`, with the environment line from the ground
rules exported:

1. `node scripts/sync-test-count.js --check` — must print `fail=0 skipped=0` and
   confirm the documented numbers match. Run `--write` and commit if the count
   moved, which it will, since this plan adds roughly six test files.
2. Every new test verified red-before-green. For each one, note in the commit
   body what the failure looked like before the fix. Do not skip this: during
   the audit, four separate guards in this repo turned out to catch nothing when
   they were finally tested by deliberately breaking the thing they guard.
3. **Start the actual desktop app and run a build.** Items 2, 5 and 6 all touch
   the build path, and BUG-301 exists precisely because 5,822 passing tests could
   not tell anyone that the engine had never once been run inside the real
   application. A slice is not verified until the app actually starts.
4. Fetch a real public web page through `web_fetch` and confirm readable text
   comes back — Phase 1 replaces the whole transport underneath it.
5. `git log --oneline` should read as fifteen understandable sentences. If any
   commit message says "fix bug" or "updated", rewrite it before the pull
   request.

## Known traps, so you don't rediscover them

- The suite cannot be trusted until Phase 0 lands. Before that, always suspect
  the environment before suspecting the code.
- Another session may be editing this checkout. Files changing under you and
  wandering test failures are that, not a regression.
- The build engine tests need the engine installed locally
  (`node mythos/scripts/setup-dsh.js --install`). Without it some branches
  report "offline" — which is correct behaviour, not a failure.
- Do not write a fallback that makes a broken state look healthy. This codebase
  chooses honest failure over a plausible wrong answer everywhere, and reviews
  are strict about it.
