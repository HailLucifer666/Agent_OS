# Fix plan for the twelve open tickets (2026-09-10)

Written under `/kee fix` (FIX-PROTOCOL + GATES) for the twelve rows `index.html`
listed as open on 2026-09-10: 268, 274, 275, 406, 421, 422, 432, 433, 434, 435,
436, 437. Same shape as `AUDIT-2026-08-22-FIX-PLAN.md`: this is a docs file, not
a fifth plan document; `Plans/RESUME.md` stays the position.

**The rule every entry follows:** a fix without a test is a claim. Each ticket
below names the test that must go red before the fix, the mutation that proves
the test can fail, the adjacent case that must keep passing, and the one piece
of evidence that would move it. Where a ticket cannot be moved by code, it says
whose hand it needs.

## Status at a glance

| Ticket | Plain-language symptom | State 2026-09-10 | Moves when |
|---|---|---|---|
| 435 | "Open YouTube on Brave" opened two Brave windows | **coded** (PR #88) | operator decides which browser a named request means; one attended run |
| 436 | MYTHOS goes quiet mid-sentence | goAway half **coded** (PR #88); stall half open | one live goAway; a stall profiler run |
| 434 | typed text into Slack, then retracted it as "not sent" | in flight, other agent | its PR |
| 433 | app boots silent until the wake word | in flight, other agent | its PR |
| 432 | system notices talk over each other | measured, open | a serialiser behind a flag + measured pass |
| 421 | "play the twelfth video" promised but unreachable | measured, open | growth-based stop + a page-size sweep |
| 437 | closing the app left processes behind | observed once | reproduce with Task Manager open |
| 422 | server child died silently, never restarted | instrumented, cause unknown | a live capture at the moment of death |
| 268 | Ctrl+Alt+X does nothing | narrowed to two candidates | operator presses the key once |
| 406 | mic held for 40 % of a conversation | measured, deferred | a live-room recording |
| 275 | promoted names out of prose into rank positions (H1) | H2–H4 closed; H1 open | a detector design pass |
| 274 | wake-word weights are non-commercial | T3 only | a lawyer |

Order to work in, if one person does it all: 437 (cheap repro) → 432 → 421 →
422 → 268 → 406 → 275 → 274. 433/434/435/436 are in review or in flight.

---

## Shipped in PR #88 (branch `fix/live-voice-435-436`)

### BUG-436, goAway half — we hung up on Gemini mid-sentence

**Measured premise (Gate A), and the ticket was wrong.** The ticket said the
goAway "closed the session while screen_read_text was in flight" and the result
"had no session to return to". `mythos-server.log`: tool call 09:47:39.110 →
result ok 09:47:39.948 (836 ms) → own-voice hold 09:47:41.183 (the model was
speaking) → `live.goaway timeLeft:"50s"` 09:47:42.508 → **our own
`close('goaway')` on the same tick** → reconnected 09:47:44.485 → silence until
the operator spoke at 09:47:59. The result had returned 2.5 s before the goAway.

**Mechanism, plainly.** Google's goAway is the hotel saying "check-out is in
fifty minutes". The old code dropped its bags and walked out mid-sentence. With
session resumption the new connection held the context and waited for someone
to speak. Google's reference: timeLeft "lets you take further action before the
connection will be terminated as ABORTED".

**Fix.** `src/core/voice/goaway-gate.js` (pure): if a turn is in flight (the
model owes a toolResponse or has produced audio/text this turn) the non-final
close is held until turnComplete, or timeLeft minus 2 s, whichever first. Idle
goAway closes at once, unchanged. Unparseable timeLeft closes at once. Any
close() cancels a pending hold. `live-session.js` wiring is net +1 line; the
file sits exactly at its size-ratchet ceiling (1204).

**Proof.** `test/bug-436-goaway-waits-for-the-turn.test.js`, 8 tests. Mutations
2026-09-10: restoring the old one-line close → (1)(3)(4) red "socket must still
be OPEN after goAway mid-turn (got 3)"; forcing in-flight always true → (2) red
"a goAway with nothing in flight must close immediately". Both restored
sha256-identical.

**Not covered.** Whether Gemini services the held connection for the full
timeLeft and whether the resumed session continues the cut turn. One attended
goAway settles it: `live.goaway deferred:true` then `live.goaway-close
why:turn-complete` in the server log.

### BUG-436, stall half — the event loop freezes 2–9 s with zero CPU

Not fixed; no code yet, deliberately. 18 `loop.stalled` rows in 32 minutes with
`cpuMs` mostly under 150.

> **SUPERSEDED 2026-09-11 — see the BUG-436 entry in `BUGS.md`, which is now the
> authority for this ticket's reading.** The next sentence used to conclude that
> `cpuMs` mostly under 150 "means the process was **blocked, not computing** —
> waiting on a synchronous file read, a child spawn, or a lock". It does not
> mean that. `cpuMs` is process-wide (it counts the libuv threadpool and every
> native thread) and is accumulated over `period + lag` while `lagMs` covers
> only the lag. The instrument now emits `sampleWindowMs` and `mainCpuMs`; use
> those. Guessing the call site is how this repo has mis-diagnosed voice twice,
> and this paragraph was a third attempt at it.

**Plan.** (1) Instrument: extend `src/core/loop-lag.js` so each `loop.stalled`
row carries the last synchronous fs/spawn call started before the lag (a
ring-buffer of `fs.*Sync` and `spawnSync` entry names, patched in at boot behind
`LOOP_LAG_TRACE=true`). Test: a fake sync call followed by an induced lag emits
a row naming that call; mutation: drop the name and the test reds. (2) Run one
attended session, read the rows, then fix the named caller. (3) Only then decide
whether the `cortex-stall → restart-cortex` heal at 1883 ms is helping or
hiding. **Do not lower the 250 ms threshold or raise it** — that changes the
instrument, not the fault.

### BUG-435 — two browsers for one request

**Mechanism.** Two tools, one intent, prose only. Nothing but description text
separated "open it in your browser" (`open_web browser:true`, the signed-in
profile) from "open it in the browser I control" (`browser_launch_debug`, the
empty debug profile), and the model called both in one turn.

**Fix.** `src/core/voice/browser-route-guard.js` (pure) + one line in
`live-tool-adapter.js`: one real-browser door per errand. The route set is
derived from the reason "a page in a real window", so `browser_navigate`,
`browser_switch` and `browser_launch_debug` are one route and `open_web
browser:true` the other; a call whose route differs from one already taken this
turn is refused before the leash and told what already opened. Store: the
adapter's own per-turn `executedSignatures`, cleared at turnComplete.

**Proof.** `test/bug-435-one-browser-route-per-turn.test.js`, 10 tests, driving
the real adapter with the audited arguments. Mutation: deleting the guard line →
"dispatched: open_web,browser_launch_debug — the second browser opened".
Bounds: same route twice allowed; an `open_web` HUD card is not a route; a new
turn clears memory; **each route alone is allowed**.

**Deliberately not changed, and pinned by test (f):**

> ⚠️ **DECISION (operator):** the ticket wants "on Brave" to mean the debug
> browser; the Stage 1 golden path in `Plans/RESUME.md` drives the already
> signed-in browser, the opposite route. Choose. One answer changes the tool
> guidance; the other changes what the golden path drives.

No description prose was added: a first draft did and
`test/remedy-prose-ratchet.test.js` refused it. The class is "prose only"; the
guard is the mechanism.

---

## In flight by another agent (main checkout, uncommitted as of 16:30 IST)

A second agent, not visible in this app's session list, edited
`claim-check.js` (BUG-434) and started `test/bug-433-proactive-speech-needs-a-
listener.test.js` while this session was reading the same files. This session
moved to a worktree and took 435/436 to avoid duplicate diffs.

> ⚠️ **DECISION (operator):** let that agent land 433 and 434, or reassign
> them. Do not merge two fixes to the same lines.

### BUG-434 — a true "I sent the text" was retracted

**Measured.** Audit `aud-105f3c76f66c`: `ui_type` completed `outcome:ok` into
Slack at 09:51:13Z. Episodic `ep-9c8163920e5cc7a3`: "I sent the text …to that
message box." The `sending` category matched "I sent", looked only at its three
send tools, found none, and the retract notice made MYTHOS deny a true action.
F1b's class exactly, one category over.

**Plan (the agent's diff already matches this).** Add `backingTools:
['ui_type','send_key']` to the `sending` category — tools whose SUCCESS backs
the claim without OWNING the category. Consult them only in the backed check:
never in the elliptical gate (a failed ui_type is a failed typing, not a failed
send, so "Message sent to Alex" over a `whatsapp_send` FAIL stays caught) and
never in candidateTools (the correction must not say "call ui_type"). The tool is
`send_key`, not the ticket's `press_key` — `TIER_TABLE` has no `press_key`.

**Test that must go red first** (a copy sits in this session's scratchpad,
`bug-434-typing-backs-a-sent-claim.test.js`): the real 09:51 sentence with the
real `ui_type` row → `[]`; same row one turn back via the ledger → `[]`;
FAILED ui_type → still flagged and `ui_type` absent from candidateTools; the
2026-08-14 "Message sent to Alex, sir." + `whatsapp_send` FAIL → still flagged;
"I sent it" with no tool → flagged; every backing tool exists in `TIER_TABLE`; no
backing tool is any category's owned tool. Mutation: delete `backingTools` →
(a)/(a2) red.

**Honest limit to pin:** a first-person "I sent" beside a successful ui_type is
backed even if a send tool also failed nearby — the header's favour-misses rule.

### BUG-433 — the packaged app boots silent

**Premise, confirmed from source (Gate A).** `s2s-bridge.js` registers
`onBroadcast('live-audio-out')` only inside `start()`; nothing calls `start()`
at boot (only the orb, the talk hotkey and the wake word via `toggleVoice`);
`ws.js` drops broadcast types with no handler. So every Live utterance before
the first wake word has no listener. The TTS path (`proactive-speech`) IS
subscribed at boot (`app.js:999`) and did play the Sep 8 greeting.

**Plan.** In `server/index.js` track per connection `clientLiveRequested`: true
on `live-open`, false on `live-close` and on socket close. `liveForSpeech()`
returns null unless it is true, so proactive speech, the typed-utterance path and
`routeConversation` (the three callers — Gate B: derive the set from the reason)
all fall through to the TTS chain when nobody is listening. Distinguish the log:
`proactive.live-skipped-no-listener` (info) instead of BUG-149's
`live-unavailable-voice-will-differ` warn, which was written for the case where
the fall-through IS a defect. Amend the BUG-146 comment clause that calls a
boot-opened session "the normal case".

**Test.** Harness from `test/proactive-speak-live-routing.test.js`, but WITH
`GOOGLE_API_KEY` set — the existing "legacy path" test passes today only because
its fixture lacks the key (fixture more generous than the wire). Cases: no
`live-open` → `reminder.due` produces `proactive-speech`, zero Gemini sockets
opened; after `live-open` → Live path (already covered); after `live-open` then
`live-close` → next proactive speech takes TTS and opens no new socket.
Mutation: remove the gate → the first case opens a socket → red.

> ⚠️ **DECISION (operator):** this trades the Live voice for audibility at
> boot — the greeting will be in the TTS voice (BUG-149's complaint) until the
> HUD subscribes at boot, which needs an AudioContext without a user gesture.
> Audible-in-the-wrong-voice beats silent; say if you disagree.

---

## Open, with a code path a session can start

### BUG-432 — system notices interrupt each other

**Measured.** 15 of 35 interruptions on 2026-09-09 followed MYTHOS's own
`live.text-injected` within 300 ms; the boot greeting was cut on 2 of 2 boots on
2026-09-10 (self-heal notice 1.05 s after it; Gmail/provider notices after the
20 s lock ceiling). The ticket itself says timing changes need a measured pass.

**Plan.** A notice queue in `live-tool-adapter.js`'s `sendSystemNotice` path
(extract to a pure `notice-serializer.js`; the adapter is at its ratchet
ceiling): while a system-initiated turn is in flight (the live-session's own
in-flight predicate from BUG-436 can be exposed), hold non-urgent notices and
release one per turnComplete; a ceiling (`NOTICE_HOLD_MAX_MS`, e.g. 15 000)
releases regardless so a stuck turn cannot bury a notice; operator-typed text and
tool-outcome corrections are never held (the operator's words and the
honesty corrections outrank an announcement). Ship behind
`VOICE_SERIALIZE_NOTICES` default **off** until the measured pass.

**Test.** Fake session: inject notice A, model starts replying, inject notice B
→ B is not sent until A's turnComplete; ceiling releases B after
`NOTICE_HOLD_MAX_MS`; an operator-typed line bypasses the hold. Mutation: remove
the hold → B goes out immediately → red. **Measured pass:** replay the
2026-09-09 log through the serializer and count how many of the 15 would have
been held; then one attended session comparing `live.interrupted` counts.

### BUG-421 — ordinals up to "twentieth" that the page cannot reach

**Measured.** YouTube at 1280×800 ranked 6, 6, 8, 11, 14 cards across four
600 px scrolls; result six became clickable on the FOURTH scroll with
`REVEAL_SCROLLS = 4`, so the promise "1–20" is kept only to about six.

**Plan (the ticket's own two directions, both).** (1) Stop on "the ranked count
stopped growing for two scrolls" instead of a fixed count, with an absolute cap
(`REVEAL_SCROLLS_MAX`, e.g. 12) so a page that never reveals a card still stops.
(2) When the requested ordinal is above the count reached, the refusal names the
reachable count: "I can see nine results; the twelfth is not on this page yet".
Do NOT just raise the number.

**Test.** A fake page whose ranked count grows 6, 6, 8, 11, 14, 14, 14: the
seventh is reached, the fifteenth refuses naming 14, and the loop stops two
scrolls after growth stopped, not at the cap. Mutation: revert to the fixed
count → the fifteenth's refusal says the old generic text → red. **Measurement
pass owed:** three result pages × two viewport sizes before the constants are
trusted.

### BUG-437 — closing the app left processes behind, no quit line

**What is known.** No `app quit: orderly exit` in `main.log` for the 09:52 close
while earlier quits wrote it; only `adb.exe -L tcp:5037 fork-server` survived
afterwards (deliberate, BUG-404). `stopChild()` hard-kills the child, so its
exit hook cannot write on a normal quit — that part is expected.

**Plan, reproduce first.** Task Manager open, `main.log` tailed, close 0.1.12
three times: (a) via the window X, (b) via the tray Quit, (c) via Alt+F4. Record
per attempt: did `before-quit` log `vault-sync`, did `window-all-closed` fire,
which processes remain and for how long. If `window-all-closed` never fires
while a hidden window (media window, cursor overlay) is still open, that is the
mechanism: Electron keeps the app alive while any BrowserWindow exists. Fix
would be: track owned windows and destroy them in `before-quit`; test:
source-shape plus a unit on the window registry. Do not write code before the
three closes are recorded.

### BUG-422 — the server child died silently, never restarted

**What is known.** Child died 2026-09-09 19:52:05.685Z; no restart ever; the
`child.on('exit')` handler ALWAYS logs and schedules a restart, and demonstrably
did so earlier that evening. The stdout capture that would have shown the
handler running was dead since boot, so its silence proves nothing. The 2026-09-10
instrumentation (`electron/child-lifecycle.js`) timestamps main logs, records
main-log write failures separately, and checks every 30 s for a disconnected
child with no exit.

**Plan.** No watchdog first — the ticket is explicit and right: a supervisor
that restarts what it cannot explain turns a visible outage into an invisible
one. Next evidence: run the packaged app with the new instrumentation until the
next death and read `main.log` for the three candidates (handler never ran /
handler ran but log lost / `isQuitting` true). Then fix the one that happened.
Test comes from the diagnosis; a pre-written test here would be a guess.

---

## Blocked on a hand that is not a session's

### BUG-268 — Ctrl+Alt+X

Narrowed to two candidates (the keypress not reaching `globalShortcut`, or
delivery after dispatch). The five markers shipped 2026-08-20 have never been
pressed in a build that carries them: 8 registrations, 0 firings. **Operator: one
press in a running build**, then grep the five markers in order. Separately, the
nine source-shape tests are a false green (renaming the channel disabled the
feature with 9/9 passing) and should be replaced by an in-process behavioural
test that drives the handler — after the stdout capture problem recorded in the
ticket is solved, not before.

### BUG-406 — the microphone held 40 % of a conversation

267.7 s held, 46 963 frames zeroed, 7 of 34 releases at a ceiling. Loosening
the gate wrongly makes MYTHOS answer itself, which is worse. Needs a synchronised
mic + playback recording in a live room and a replay test that asserts the gate
opens within N ms of the last real speaker frame, with near-field speech as the
must-keep-passing case. BUG-428 wired the numeric echo verdict behind a switch;
its acoustic proof is owed under this ticket. **Operator: one recorded session.**

### BUG-275 H1 — names promoted from unranked prose into rank positions

H2, H3, H4 closed with detectors; H5 and H7 refuted. H1 is harder than filed:
the names were in evidence, in a comparison article, and the model gave them
ranks. A detector needs "this name occurs in evidence but never in a ranked
shape there" — the digest must keep positional context, which
`evidence-digest.js` drops today. Design pass first; replay the 171-reply corpus
before shipping, as H3/H4 did (fired exactly twice, both real).

### BUG-274 T3 — openWakeWord weights, CC BY-NC-SA 4.0

Four of six items shipped with tests. T3 is a licence decision about one set of
weights for a product that will be sold. **A lawyer's call**; `CLAUDE.md`
forbids a session writing a legal conclusion into a tracked file. Engineering
prep that IS a session's: enumerate the swap candidates with their licences
(Porcupine is metered/proprietary — already rejected) and the cost of training
own weights, as a docs table, so the decision has its options in front of it.

---

## What this plan does not do

It does not close any ticket. Two are coded with local evidence and need one
attended run each; two are another agent's; the rest need the evidence named
above. The next `RESUME.md` rewrite should point here for the per-ticket
detail and keep only the position.
