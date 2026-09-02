'use strict';

// voice/narration-claims.js — the five sentences MYTHOS is allowed to say about
// a tool outcome, and nothing else.
//
// WHY THIS FILE EXISTS. These constants were declared inside
// live-tool-adapter.js's factory closure, and they never used it: they are pure
// text plus one name lookup. Moving them out was forced by two of this repo's
// own guards firing on BUG-398 R5a in the same run, which between them left
// exactly one correct answer:
//   * file-size-ratchet.test.js — live-tool-adapter.js is oversized debt at a
//     recorded ceiling of 1449 lines, and adding a fifth claim pushed it to
//     1524. "The baseline number is a ceiling, not a suggestion — do not raise
//     it to make this pass. Move the new code somewhere else." So the code moved.
//   * bug-295-narrating-unread-content.test.js's fifth-constant guard — a new
//     `*_CLAIM` must be named in the path matrix in the SAME commit. That guard
//     scans for these declarations, so it now scans this file too; a constant
//     added HERE without a matrix entry fails exactly as one added there does.
//
// Every comment below is carried over verbatim from live-tool-adapter.js. They
// are the record of four separate incidents (BUG-068, BUG-116, BUG-273,
// BUG-295) and one near-miss (BUG-398), and the reasoning for why each sentence
// is worded the way it is belongs next to the sentence — not in a ticket.
//
// THE RULE THE WHOLE FILE SERVES: the status field is for us, the prose is what
// the model reasons over. Every outcome that is not a proven success carries an
// explicit prohibition, and no two branches may word it differently — that
// divergence IS BUG-273.

// BUG-116 — 2026-08-05 17:13:04: "The click went through, and the screen did
// change afterwards", 49 seconds after see_and_click came back ok:false. Same
// shape at 17:10 twice ("I've played Starboy" over error 153, "YouTube is now
// present" over a Chrome window).
//
// On Live there is no turn boundary of ours to correct at — Gemini speaks its
// own audio as results arrive, so the text inside the functionResponse is the
// ONLY thing that teaches it what happened, both for the sentence it is
// speaking now and for the rest of the retained session. status:'started' and
// status:'unverified' both carried an explicit prohibition; the failure
// branches — the ones with the strongest reason to — carried a bare error
// string and nothing else. The status field is for us; the model reasons over
// the prose. Hence one shared sentence, used on every "this did not happen"
// reply, awaited or late.
const NO_SUCCESS_CLAIM = 'This action did NOT succeed. Tell the operator plainly that it failed and what ' +
  'failed. Do NOT claim it worked, do NOT claim the screen or anything else changed as a result, and do ' +
  'NOT describe it as done later in this conversation either.';

function failedNarration(toolName, detail) {
  return `${toolName} FAILED: ${detail} ${NO_SUCCESS_CLAIM}`;
}

// BUG-273 B1 — 2026-08-18. The operator logged an incident reading "Your tools
// are lying. Your tools are not wired properly." immediately after
// launch_app('wt'). The effector was already honest: ok:true + unverified:true,
// reason "launched, but no windowed process matching the name could be
// confirmed; a later focus_window/ui_type has no trustworthy target." MYTHOS
// told the operator it had opened Windows Terminal.
//
// ROOT CAUSE, and it is NOT the instruction-following failure it looks like.
// Three paths narrate an unverified outcome to a Live model, and they did not
// agree with each other:
//   * the awaited branch below appended 'Report only that it was attempted.'
//   * reportLateOutcome appended NOTHING — it kept the neutral default
//     'Report this to the operator accurately.', because only its FAILURE
//     branch escalated to NO_SUCCESS_CLAIM.
//   * resolveLiveConfirm inlined its prohibition into `verdict`, i.e. into the
//     audit record, and also left its instruction neutral.
// BUG-272 slice 4 (190cd74) then moved launch_app into SLOW_TOOLS for sound
// duration reasons — which silently moved its narration off the strongest of
// those three paths and onto the weakest. The tool did not get less honest; the
// sentence carrying its honesty did. Everything else in SLOW_TOOLS that can
// return unverified had the same hole: spotify_play, cua_click, screen_look,
// camera_look, browser_switch, dsh_task.
//
// Q6 — WHAT CLASS IS THIS AN INSTANCE OF? The third occurrence of one invariant.
// BUG-068: only the late path honored `unverified`, so the awaited path reported
// status:'ok' over an unprovable ui_type. BUG-116: the failure branches carried a
// bare error string and nothing else, so the model narrated a click it had just
// failed to make. Both were closed by making ONE shared sentence mandatory on
// EVERY branch of one kind. Twice is a pattern, so this is deliberately not a
// third per-branch patch: test/bug-273-unverified-payload.test.js enumerates all
// three narration paths and asserts the sentence on each — the assertion those
// two fixes never wrote down.
//
// Q8 — DELIBERATELY NOT COLLAPSED INTO A FAILURE. effectors/evidence.js is
// explicit that unverified means "it may well have landed, we simply cannot
// prove it", and reporting that as a failure would make MYTHOS deny things it
// actually did — its own kind of lying. So this forbids BOTH claims, and the
// test pins that both halves are present. Reusing NO_SUCCESS_CLAIM verbatim here
// was the easy move and would have been wrong.
const UNVERIFIED_NO_PROOF_CLAIM = 'There is NO proof either way about this action. Tell the operator ' +
  'plainly what was attempted and what could not be confirmed. Do NOT say it worked, is done, is open, ' +
  'or is ready, and do NOT describe it as done later in this conversation either. Do NOT claim it FAILED ' +
  'either — that is equally unproven.';

// BUG-398 R5a — 2026-09-02. THE FOURTH CASE, and the only one in this file
// with an irreversible consequence behind it.
//
// hub.js's caller-abort (raceSignal) stops WAITING for an effector; it does not
// cancel it. Until now that outcome reached every narration site below as a
// plain failure, because `ok:false` is all it carried. MEASURED: whatsapp_send
// ×2 `outcome:fail reason:"tool-timeout"` while the operator watched the
// message arrive; MYTHOS then OFFERED TO SEND IT AGAIN. A retry there
// duplicates an outward message to a third party.
//
// Q1 — WHAT ELSE MATCHES THIS? Every tool whose confirmation phase can outlive
// the budget while its side effect has already fired. That is the whole
// population, not a list, so this is keyed on the hub's flag rather than on
// tool names: naming tools would be the denylist-where-a-rule-belongs trap,
// and the next such tool would arrive unprotected.
//
// Q8 — WHY NOT JUST REUSE UNVERIFIED_NO_PROOF_CLAIM? Because it is correct
// about the claim and silent about the ACTION, and the action is the dangerous
// half here. An unverified outcome is safe to attempt again — that is why
// nothing in this file forbids it. An aborted-in-flight outcome is not. So this
// is that sentence plus the retry prohibition, and the two must not be merged:
// adding "never retry" to the unverified claim would stop MYTHOS re-trying the
// launch_app/ui_type outcomes it currently recovers from correctly.
const ABORTED_IN_FLIGHT_CLAIM = 'This action was NOT cancelled — MYTHOS stopped waiting for it, so it '
  + 'may already have completed. There is NO proof either way. Tell the operator plainly that it was '
  + 'sent but could not be confirmed, and do NOT say it worked, is done or is sent, and do NOT say it '
  + 'FAILED either: not now, and not later in this conversation. Do NOT run it again and do NOT offer '
  + 'to — repeating it could perform the same action twice. If certainty is needed, check with a '
  + 'read-only tool or ask the operator to look.';

// BUG-273 B2 — the sibling claim, for an outcome with a CONFIRMED step.
//
// The claim above is correct when nothing is known and wrong when something is:
// applied to a working browser hand-off it forbids "is open" and "is ready",
// i.e. it gags the model about the fact the operator actually asked for. This one
// permits exactly the confirmed part and fences off the rest, so the honesty
// invariant is preserved without inventing doubt about a step that is not in
// doubt. B1s rule still holds — every unverified branch carries A prohibition —
// and bug-273-b2-handoff-wording.test.js pins that the no-proof case keeps the
// stricter wording verbatim.
const UNVERIFIED_PARTIAL_CLAIM = 'State the confirmed part plainly — it happened. Then say the rest is ' +
  'not confirmed, and do not claim the rest: not now, and not later in this conversation. Do NOT report ' +
  'the whole action as done, and do NOT report it as FAILED either.';

// BUG-295 — 2026-08-20. THE MISSING THIRD CASE. The two claims above cover an
// outcome that FAILED and an outcome that is UNVERIFIED. Neither covers a tool
// that SUCCEEDS and hands back no readable body, and that is the shape that
// produced the worst narration this project has logged.
//
// browser_navigate returned, verbatim from the session log:
//   {"url":"https://www.google.com/search?q=weather+in+Kolkata+current",
//    "title":"weather in Kolkata current - Google Search","newTab":true,"browser":"chrome"}
// ok:true, no error, nothing unverified — a truthful report of a NAVIGATION.
// MYTHOS then told the operator it was 28C with thunderstorms and high
// humidity. Every number and every condition was invented. Nothing in that
// payload says "you have not read this page", so a successful navigate reads
// to the model as having SEEN the page, and it supplies the rest from weights.
//
// Q1 — WHAT ELSE MATCHES THIS? Every tool that can succeed while returning no
// readable body. The population is larger than this list: browser_click and
// browser_type change a page and return no body; cua_click and focus_window do
// the same to a window. THE NARROWNESS IS DELIBERATE — these two are the only
// two with a LOGGED fabrication behind them, and a guard that quietly
// generalises is a guard nobody can reason about. Those others are known-blind;
// widening this list needs its own evidence, and the bug-291 path matrix is
// where the widening gets asserted.
//
// Q2 — DOES THIS HIDE EVIDENCE? No. It appends an instruction and leaves the
// payload whole: the URL, the title and the browser still reach the model, so
// the diagnostic trail is unchanged. And it is the LAST branch on every path,
// so a failure or an unverified outcome keeps its stronger prohibition — two
// prohibitions on one outcome would disagree with each other.
//
// Q8 — get_weather is DELIBERATELY NOT TOUCHED. It returned ok ten times that
// same day; the model bypassed a working tool. The defect is narration, not the
// effector, and nobody should "fix" from-system.js on the strength of this bug.
const NO_CONTENT_CLAIM = 'This returned NO page content — you have NOT read this page, only opened it. ' +
  'Report only that it is open, and call a read tool if you need what it says. Do NOT state, summarise ' +
  'or answer from anything on the page: not now, and not later in this conversation either.';

// Keyed on tool NAME, not on payload shape. A shape probe would have to decide
// what counts as "readable", and every one of these payloads is a legitimate
// success object — the thing that makes them content-free is what the tool
// does, which only its name knows. See Q1 above for why the list is this short.
const NO_CONTENT_TOOLS = {
  browser_navigate: true,
  open_web: true,
};

function returnsNoReadableContent(toolName) {
  return NO_CONTENT_TOOLS[toolName] === true;
}

module.exports = {
  NO_SUCCESS_CLAIM,
  failedNarration,
  UNVERIFIED_NO_PROOF_CLAIM,
  ABORTED_IN_FLIGHT_CLAIM,
  UNVERIFIED_PARTIAL_CLAIM,
  NO_CONTENT_CLAIM,
  NO_CONTENT_TOOLS,
  returnsNoReadableContent,
};
