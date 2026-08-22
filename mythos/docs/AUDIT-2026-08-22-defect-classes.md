# Defect-class audit — 2026-08-22

Whole-codebase hunt over the nine defect classes, run against HEAD of
`docs/w6-deepseek-harness-build-engine`. 411 JavaScript files outside
`node_modules` and `test/`. Every finding below was confirmed by reading the
code and, where it was cheap, by running it. Nothing here is a guess; where a
candidate turned out to be already defended, it is recorded in CLOSED rather
than quietly dropped, so the same ground does not get re-hunted next time.

Suite state at audit time: `tests=5822 pass=5822 fail=0 skipped=0`, docs-sync OK.

---

## QUICK WIN

### Q1 — the SSRF guard resolves DNS at check time and lets `fetch` resolve it again at dial time

**Class 1 (TOCTOU). Security sink — not deferrable.**
`src/core/effectors/web-fetch.js:47`

`isInternalUrl()` calls `dns.promises.lookup(hostname, { all: true })` and
rejects the URL if any resolved address is private. It then returns, and
`guardedFetch()` calls `fetch(current, ...)`, which performs its **own**
resolution inside undici. The comment on that block says it "catches DNS
rebinding attacks". It does the opposite: it is the textbook time-of-check to
time-of-use window, because the address the guard approved is never the address
the socket connects to.

**Why it is not hypothetical.** The attacker controls only a DNS zone, not this
machine. A record with a short TTL answers the guard's lookup with a public
address and the connect with `127.0.0.1` or `169.254.169.254`. `web_fetch` is
registered to the model as `danger: false, tier 0`
(`src/core/effectors/from-dashboard.js:1369`), so any prompt that reaches the
tool reaches this path, and the response body is returned to the caller. The
loopback interface on this machine serves the MYTHOS API itself on 4478.

**When it bites.** As soon as someone points `web_fetch` at a hostile host. The
redirect-following work already done in `guardedFetch` (verified bypass, fixed
2026-08-19) shows the surrounding reasoning is right — this is the one hop it
cannot see, because the hop happens below `fetch`.

**Fix.** Pin the connection to the address the guard actually validated. Pass a
`dispatcher: new Agent({ connect: { lookup } })` whose `lookup` re-runs
`isPrivateAddress` on every resolved address before handing it back, so the
check and the connect share one answer. This is the same remedy the redirect fix
used: move the decision to the layer that performs the action.

### Q2 — the ship gate proves a path exists as a string, not that an artifact exists on disk

**Class 5 (existence standing in for correlation).**
`src/core/effectors/evidence-validator.js:25`

The gate's `artifact` phase is `if (!artifact || !artifact.path) missing.push(...)`.
A truthy string satisfies it. For the `tiny-fix` risk class the gate path is
`['artifact']` alone — no review phase, no visual phase — so nothing else in
that path ever opens the file.

**Why it is not hypothetical.** This repo has already fixed this exact shape
twice elsewhere and left the reasoning in the code: `from-dashboard.js:674`
records that `open_artifact` "mapped any /vault/... path straight to a URL and
spawned the OS opener with no existence check, so a fabricated slug looked
identical to a real success", and job -531 is recorded at `agent-actions.js:625`
as having shipped with `evidence.pass:true` beside `reviewStatus:'failed'`. The
higher risk classes are saved only incidentally, because `fullReview()` happens
to read the file and reject on `'artifact file missing or empty'` — the gate
itself never looks.

**When it bites.** A `tiny-fix` card whose artifact object survives from a prior
attempt, or whose write produced an empty file, ships as done with nothing
behind it.

**Fix.** Give the validator a vault handle and require the file to exist and be
non-empty, not merely named. One line of check, one regression test with a card
whose `artifact.path` points at a file that was never written.

### Q3 — `opts.extra` is merged last and can switch off the build sandbox

**Class 4 (the guard contains the defect it prevents) and Class 9 (nothing reads it — delete it).**
`mythos/adapters/dsh-agent/index.js:441`

`scrubbedEnv()` sets `DSH_PERMISSION_MODE` with the comment "Permission mode is
MYTHOS's call, so it is SET rather than inherited", then ends with
`return Object.assign(env, opts.extra || {})`. Last write wins, so a caller
passing `{ env: { DSH_PERMISSION_MODE: 'workspace-write' } }` gets writes on a
task the adapter classified read-only. The same merge can clear
`ELECTRON_RUN_AS_NODE`, the BUG-301 fix committed the same day.

**Why it is not hypothetical — and the honest half.** No production caller
passes `opts.env`. A search over `src/` and `adapters/` finds exactly one
reference, the forwarding line itself. So this is latent, not live. That is
precisely the case where the rule is to remove the surface rather than guard it.

**Fix.** Delete `opts.env`/`extra`, or move the merge above the two SET lines so
MYTHOS's decisions cannot be overridden. Extend the BUG-301 test to cover the
`extra` path, which it currently does not.

### Q4 — the session-history write is swallowed whole

**Class 6 (errors that hide the evidence).**
`mythos/server/index.js:2759`

```js
try { memory.fs.writeJSON(SESSION_PATH, { turns: history, savedAt: historyAt }); } catch (_) {}
```

A failed write leaves no log line, no bus event and no marker. The next boot
reads a stale or absent session file and looks like a fresh start. Given
BUG-301's finding that a ten-minute engine failure left nothing in
`mythos-server.log`, silent persistence failures are a live weakness in this
system's diagnosability, not a stylistic one.

**Fix.** Log the error with the path. Best-effort may stay best-effort; it may
not stay invisible.

---

## BACKLOG

### B1 — `vaultPath()` has no containment, and every caller re-implements it

**Class 4.** `src/core/memory/fs-store.js:118`

`vaultPath(...segments)` is `path.resolve(root(), ...segments)`. Nothing stops a
segment from escaping the vault. Containment is instead re-implemented per call
site — `from-docs.js:39` does its own `startsWith(prefix)` assertion,
`from-okf.js:38` has `badSegment()`, `from-runner.js:150` has both a separator
test and a prefix re-check. Three correct implementations of one invariant, in
three shapes.

Two call sites do not implement it: `agent-actions.js:382` and
`agent-actions.js:844` both do
`fs.readText(String(artifact.path).replace(/^\/vault\//, ''))`. Whether
`artifact.path` is reachable from the model was traced, and it is not —
`kanban.patchCard()` does a blind `Object.assign`, but no tool or route hands it
a caller-supplied patch object, and no route passes `req.body` wholesale into an
effector. So there is **no live traversal today**. It is one careless `patch`
parameter away.

**Fix when picked up.** Enforce containment inside `vaultPath()` itself and let
the per-caller checks become redundant, rather than adding a fourth one.

### B2 — the server child has no unhandled-rejection handler

**Class 6.** No `process.on('unhandledRejection')` or `uncaughtException`
anywhere in `mythos/src` or `mythos/server`; the only pair lives in
`electron/main.js:136` and `:153`, which covers the Electron **main** process,
not the `fork()`ed server child that runs everything. Node terminates on an
unhandled rejection by default, so an escaped promise kills the whole runtime
with no MYTHOS-side log line at all.

The two hottest candidates were checked and both are safe —
`cortex/index.js`'s `tickOnce()` is wrapped in try/catch/finally and cannot
reject, and `announcer.js`'s `generate()` always resolves to its fallback text.
This is a missing net, not a known leak.

### B3 — `spawn(process.execPath)` needing `ELECTRON_RUN_AS_NODE` has now been fixed twice, with no class-level assertion

**Class 8 (platform blind spot).** `src/core/effectors/websearch-child.js:140`
(BUG-288) and `adapters/dsh-agent/index.js:422` (BUG-301) are the same defect,
each with its own bespoke regression test. A third live instance was searched
for and there is none: `server/routes/components.js:184` inherits the variable
because Electron's `fork()` sets it on the server child, and
`electron/main.js:1166` sets it explicitly with a comment saying it is required.
One guard enumerating `spawn(process.execPath` across `src/` and `adapters/`
would catch instance three for roughly the cost of either test already written.

### B4 — the reprobe test's error branch asserts a state that branch can legitimately not have

**Class 3 (friendly test data).** `test/immune.test.js:659`

`reprobe-build-engine` has three non-ok returns, not two. The test asserts
`probed.state === 'OFFLINE'` whenever `outcome === 'error'`, which is right for
`build-engine-offline` and wrong for `build-engine-online-but-last-task-failed`,
whose detail carries `state: 'ONLINE'`. It passes today only because the adapter
module is freshly loaded per test process with `lastTaskFailure === null` — the
same accident that made the previous version of this assertion pass locally and
fail on CI. Separately, the `missing-dependency:dsh-agent` return carries no
`result` key, so `probed` resolves to `{}` and the state assertion fails before
the `/offline|missing-dependency/` alternative at line 660 can ever match: that
alternative is dead.

The engine-absent branch itself was verified to work, by stubbing the adapter's
`probe`/`getStatus` through `Module._load` to simulate a machine with no
project-local dsh. The test passes on that branch.

### B5 — BUG-301's two secondary faults are recorded only inside a resolved bug

**Class 6 (process).** The BUG-301 entry in `BUGS.md` honestly names two open
problems: a ten-minute engine failure appears nowhere in `mythos-server.log`,
and the adapter's timeout message asserts "in headless mode this is the shape an
unanswerable approval prompt takes" when the real cause was a load-time crash
that stderr reported immediately. Both are correct calls to leave out of that
fix. Neither has an ID, so neither is in anybody's queue. The second is cheap:
`runTask` already captures stderr, so failing fast on a fatal load-time
signature turns 600s into roughly 2s — the measured figures are in the entry.

---

## ACCEPT

### A1 — a skill's success rate uses 0 to mean both "never measured" and "always fails"

**Class 7.** `src/core/memory/skills.js:161`:
`parsed.successRate = oldRate === 0 ? newRate : (oldRate * 0.9 + newRate * 0.1)`.
The EMA decays toward zero but never reaches it, so in practice the ambiguity
only exists on the first recorded use, where treating it as "unmeasured" is
correct. Real, tiny, and the fix (a separate `uses === 0` test) is not worth the
churn until something else touches this function.

### A2 — two files are far over the 800-line ceiling

`server/index.js` is 4,654 lines and `electron/main.js` is 2,567. Nine more
files sit between 800 and 1,700. Splitting `server/index.js` is a large, risky,
purely structural change on a file two machines edit concurrently; the
concurrent-session hazard in root `CLAUDE.md` makes the timing worse than the
debt. Recorded so it is a decision rather than an oversight.

### A3 — 94 empty catch blocks

Sampled across `src`, `server`, `adapters` and `electron`. The overwhelming
majority wrap teardown that genuinely cannot fail usefully (`ws.close()`,
`browser.close()`, `page.title()`) or a JSON-parse ladder that tries the next
shape. The one that mattered is Q4 above. No sweep warranted.

---

## CLOSED — checked during this audit, already defended

| # | Hunted | Result |
| --- | --- | --- |
| C1 | Command injection via `shell: true` | Not present anywhere in `src`, `server`, `adapters`, `electron`. `adapters/command-runner/index.js:103` states it as a hard invariant and four other modules carry the same note. |
| C2 | A second, unguarded `web_fetch` | Consolidated. `from-dashboard.js:958` now delegates to the guarded fetcher and the history is written into the comment above it. |
| C3 | HTML-attribute break-out and `javascript:` hrefs in the HUD | All four `href=` interpolation sites are gated — `safeHref` (engagements), `safeSameOriginUrl` + `escapeAttr` (pipeline), `safeUrl` + `escapeAttr` (web-panel), `safeUrl` plus a local quote-escaping `escapeHtml` (news). `renderMarkdown()` escapes its whole input before any regex runs. |
| C4 | Whole `req.body` passed into an effector | None. Every route names its fields. |
| C5 | Secrets reaching a log line | None. The three matches log a *reason* ("bad or missing token"), never a value. |
| C6 | Path segments in the OKF knowledge store | `badSegment()` is applied at every door that takes a caller-supplied bundle or filename; inner filenames come from `listFiles`, not from the caller. |
| C7 | The OODA tick escaping as an unhandled rejection | `tickOnce()` is wrapped in try/catch/finally with a generation guard; it cannot reject. |
| C8 | `isInternalUrl` failing open | Fails closed on an unparseable URL and on DNS failure, with the 2026-08-20 reasoning recorded in place. |

---

## What this audit did not cover

The `ui/public/js` tree was examined only for the href and `innerHTML` sinks
above. Class 2 (un-awaited writes) was scanned mechanically across `src`,
`server`, `adapters` and `electron` — 42 bare statement-position calls to
async-named functions, all of which resolved to synchronous same-file
definitions or to deliberately-contained call sites — but a promise handed to a
variable and dropped later would not show up in that scan. The test suite itself
was not audited for friendly data beyond B4.
