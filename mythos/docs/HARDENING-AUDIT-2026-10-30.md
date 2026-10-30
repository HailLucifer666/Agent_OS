<!--
Anchor: origin/main@abd86c5dcc5998dfa4e823d55778522f14ad8b8d, 2026-10-29 22:52:33 +0530.
Measured 2026-10-30 from git blobs (`git show origin/main:<path>`, `git grep <sha>`),
never from a working tree. Ledger rows re-measured independently 2026-10-30 at the
same anchor (second verifier); the second pass matched every row below.
This is evidence for the v2.1 hardening plan, not a fourth plan document.
-->

# MYTHOS hardening audit — 2026-10-30

**Anchor:** `origin/main@abd86c5dcc5998dfa4e823d55778522f14ad8b8d` (2026-10-29
22:52:33 +0530, "fix #165 vendor-cache: version-key the mediapipe vendor mount").

**Method:** every line number and status below was read from a git blob at the
anchor SHA, not from the operator's checkout. The checkout at first writing was
`fix160@f0721647`, 82 commits behind (`git rev-list --count f0721647..abd86c5d`
= 82). The second verifier repeated the same reads at the same SHA and matched.

Status vocabulary is deliberately narrow: `LANDED <commit>` means the fix is in
the anchor tree; `OPEN` means the defect is still there; `PARTIAL` means one
half landed and the remainder has not been re-measured. `VERIFIED` is not used,
because it cannot distinguish "closed since" from "still present".

## Ledger

| ID | Slice | Finding | Anchor evidence | Status |
|---|---|---|---|---|
| HA-C-1 | 1.2 | A verification sweep that repairs and re-runs a stage re-enters the sweep from `EXECUTING`. `stageComplete` is illegal from `EXECUTING`, so `allVerified` is rejected and `completeEngagement`'s catch swallows it: completion fields are written and the completed event fires, but the persisted status stays `EXECUTING`. `blockEngagement` transitions only from `REPAIRING`, so the failure path also persists nothing from `EXECUTING`. | `mythos/src/core/engagements/executor.js:559-604` (sweep `:559`, `verificationFailed` `:587`, re-run `:594`, recursion `:596`, `noRepairsRemaining` `:604`); `mythos/src/core/engagements/state-machine.js:48-56`; `blockEngagement` `executor.js:537-552` | **OPEN** at the anchor; **LANDED** `092f352c` (post-anchor, PR #174) |
| HA-C-2 | 1.7 | `RUN_COMMAND_ALLOWLIST`'s colon form admits any positional argument. `npm:test` becomes a flag set `{test,--test,-test}`; the matcher rejects only args beginning with `-`. `npm exec <anything>` therefore passes a config written to allow `npm test`. | `mythos/src/core/effectors/from-runner.js:64-95` (`parseAllowlist`), `:204-213` (matcher); the comment at `:204-210` states positionals are allowed on purpose | **OPEN** |
| HA-H-1 | 1.5 | `getQuotaStatus` reads `stats.byProvider`, which is built from the 200-entry rolling `recent` ring buffer, not from a day bucket. A "daily" quota counts yesterday's calls until 200 newer calls evict them, and saturates at 200 on a heavy day. The same seam mixes clocks: `spend.js` buckets by local day while `quota.js` advertises a UTC reset for `resetsTz: 'UTC'` providers. | `mythos/src/core/quota.js:60` (`stats.byProvider`), `:84` (`nextResetUTC()`); `mythos/src/core/brain/spend.js:6` (`MAX_RECENT = 200`), `:35` (eviction), `:46-49` (`byDay`, local `todayKey()`), `:79` (`today` exposed but unread by quota) | **OPEN** |
| HA-H-2 | 1.6 | The live-tool adapter subscribes to `voice.live.toolcancel` and discards the unsubscribe function returned by the bus. The adapter is created per connection and deleted on close, so every socket open/close leaks one subscriber. | `mythos/src/core/voice/live-tool-adapter.js:193`; adapter creation `mythos/server/index.js:2884`; close-path delete `mythos/server/index.js:4048`; bus unsubscribe contract `mythos/src/core/bus/index.js:101-104` | **OPEN** |
| HA-M-1 | 1.4 | The `cmd /c start` half of the artifact / `mailto:` / `launch_app` path is landed (B2c, 2026-09-29): links go through `rundll32 url.dll,FileProtocolHandler` with no shell. The artifact-open containment and path-like `launch_app` name cases have not been re-measured at this anchor. | `mythos/src/core/effectors/open-url.js:19-27`, `:75`; historical comments at `mythos/src/core/effectors/from-dashboard.js:646`, `:701`, `:704`, `mythos/src/core/effectors/from-computer.js:720`; helper is `open-external-route.js` (not `open-external.js`) | **PARTIAL** |
| HA-C-3 | 1.1 | A generated build iframe and the Electron HUD authority gate are isolated: the preview sandbox omits `allow-same-origin`, the server sends a matching CSP sandbox, and the Electron trust predicate refuses subframes and frameless senders. | `mythos/ui/public/js/views/forge.js:40`; `mythos/ui/public/js/url.js:56`; `mythos/src/core/server/preview-isolation.js:64`; `electron/hud-trust.js:55`; tests `mythos/test/preview-isolation.test.js`, `mythos/test/electron-hud-trust.test.js` | **LANDED** `832d1be3` (server), `3583dacd` (Electron) |
| HA-H-3 | 1.3 | The conversation-history route sent Episodic as `readLines().join('\n')`, so every parsed row reached the HUD as `[object Object]` and the client parser skipped it. The route now sends raw JSONL text. | `mythos/server/index.js:1136`; test `mythos/test/bug-466-history-sends-raw-jsonl.test.js` | **LANDED** `f834b302` |

**Post-anchor:** HA-C-1 landed after this audit was written — `092f352c`
(PR #174), with `78c1d83d` as the pure move that made room under the 864-line
size ratchet. The row's evidence above is still the anchor measurement; the fix
is not in `abd86c5d`.

## Known residual

HA-C-3 closes the cross-origin path; it does not make `isHudContents` a frame
gate. A same-origin iframe that scripts the HUD through `window.parent` still
reports the main frame to Electron's facts model. B3c's opaque-origin isolation
is the argument that closes that, and no frame check in `isHudContents` can:
the helper has one call site (`electron/main.js:202`) and is a log field, as its
own comment at `electron/main.js:550` says.

## Plan-vs-anchor corrections measured while re-deriving this audit

These are corrections to the v2.1 plan text, recorded here so the next run does
not inherit them.

1. **CORRECTION A's premise is wrong.** The plan says `plan.currentStageIndex`
   sits at `stages.length - 1` when the sweep runs, so the fix's first
   `stageComplete` bump moves it to `stages.length`. At this anchor the final
   stage already calls `store.transition(..., 'stageComplete', ...)` before
   `runVerificationSweep` (`executor.js:206-209`), and that transition bumps
   `currentStageIndex` (`engagements/index.js`, `case 'stageComplete'`). The
   index is therefore already `stages.length` during the sweep. The fix's added
   `stageComplete` is a no-op for the index because the guard sees
   `stages[stages.length]` as undefined. The invariant worth pinning is the one
   that is actually true: the index ends at `stages.length` and stays there
   across a second verify-fail-repair cycle. A mutation that removes the guard
   in `transitionEngagement` would push it past `stages.length` and the test
   must catch that.
2. **`BUGS.md` line drift.** `C-3` ("video call: no tool exists") is at
   `BUGS.md:6225` at this anchor, not `:6167`. The `HA-*` prefix is still the
   right call; the collision the plan warned about is real, only the line moved.
3. **The 1.1 path names are UI paths.** `forge.js:40` and `url.js:56` are
   `mythos/ui/public/js/views/forge.js` and `mythos/ui/public/js/url.js`.
   `hud-trust.js:55` is repo-root `electron/hud-trust.js`.
4. **The phase-1 harness is in-memory, not fs-store.** `phase1-engagement-executor.test.js`
   uses a `memStore()`; the fs-store + temp-vault harness is
   `phase3-executor-verify-stage.test.js:29-72`. RUN 1 should copy the phase-3
   setup because the plan's stated requirement is an on-disk read-back.
5. **The 1.6 gate is still closed.** `mythos/src/core/voice/speech-release.js`
   is absent from the anchor tree and `LIVE_FRAME_TRACE` is absent from
   `mythos/server/index.js`; `#163` has not landed.

## Out of scope

- `mythos/adapters/pc-child/ps-automation.ps1` is deliberately untouched by
  every slice in this audit. It carries live-verified fixes protected by
  BUG-037, and none of the findings above requires editing it.
- 1.1 and 1.3 are not re-opened. Their rows are recorded as landed evidence,
  and the only open question is the known residual above.
