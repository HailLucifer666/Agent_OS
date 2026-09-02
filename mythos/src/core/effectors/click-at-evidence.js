'use strict';

// effectors/click-at-evidence.js — BUG-398 row 10 (2026-09-02).
//
// WHY ITS OWN FILE. from-pc.js sits on the file-size ratchet at a recorded
// ceiling of 1552 lines and was EXACTLY at it, so every line of this fix had to
// leave. The guard's own words: "the baseline number is a ceiling, not a
// suggestion — do not raise it to make this pass. Move the new code somewhere
// else." The dossier repeated the warning for this specific file. So the
// orchestration lives here, the wording lives in ui-target.js's clickVerdict,
// and from-pc keeps only the wiring.
//
// A factory taking its collaborators rather than importing them: from-pc owns
// the pc-child delegate and the OCR seam, and reaching back into it from here
// would be a circular require. Passing them in also makes this testable with no
// desktop at all.

// BUG-398 row 10 — 2026-09-02. THE MODEL-FACING TOOL, and until now it was the
// last false-success left in this file.
//
// MEASURED: click_at(1336, 1433) returned {"clicked":true}. The URL did not
// change and the <video> still read paused:true, t:0. The element's rect was
// y 1399, height 67 — BELOW THE FOLD, so the click landed on whatever pixel
// happened to be at those coordinates. A 1/0 return, no post-condition, no
// visibility check.
//
// Q3 — WHO ACTUALLY READS THIS? `ui_click`'s own failure text recommends
// click_at as the next thing to try. So the one tool the recovery ladder points
// at was the one tool that could not report its own effect — the ladder ended in
// a shrug that looked like a success. That is what makes this worth fixing
// rather than documenting.
//
// WHY NOT AN UNCONDITIONAL SCREEN READ. A before/after OCR pair on every click
// would make the honest answer available always, and would also put a slow
// whole-desktop read in front of every coordinate click in a UI-driving loop.
// So the cost is OPT-IN: pass `expect` and you get proof, pass nothing and you
// get an honest `unverified` that says why. Both are truthful; neither is
// `{clicked:true}` standing in for "it worked".
//
// Q8 — DELIBERATELY NOT A BOUNDS CHECK. A coordinate below a PAGE's fold is
// still inside the screen (1433 < the display height here), so validating
// against the virtual desktop would have passed this exact call and bought
// nothing. Scrolling the target into view is not possible either: click_at is
// given raw pixels and has no element to scroll to. Saying so is the fix.
function makeClickAt(deps) {
  const { delegateWithRetry, readScreenRegions, settleForChange, evidence, clickVerdict, fail } = deps;

  // The raw delivery, paired with its wrapper rather than left in from-pc.js.
  // Internal callers that run their OWN oracle afterwards use this —
  // see_and_click does a bounded settle on the scope it already read — so the
  // wrapper cannot charge them a second whole-screen read.
  //
  // Phase 3 hardening, carried over: coordinate clicks are racy (the window can
  // move between screen_look and click) and the retry bounds that. Note
  // delegateWithRetry records `retries` on the envelope it returns, which the
  // wrapper must preserve rather than replace — see the shape() note below.
  async function clickAtRaw({ x, y }) {
    if (typeof x !== 'number' || typeof y !== 'number') return fail('x and y coordinates are required (numbers).');
    return delegateWithRetry({ cmd: 'click_at', x, y }, { attempts: 3 });
  }

  async function click_at({ x, y, expect }) {
    if (typeof x !== 'number' || typeof y !== 'number') return fail('x and y coordinates are required (numbers).');

    const want = (typeof expect === 'string' && expect.trim()) ? expect.trim() : null;
    // Only read beforehand when there is going to be an after-read to compare it
    // against — otherwise this is pure cost for no evidence.
    const before = want ? await readScreenRegions({}) : null;

    const clicked = await clickAtRaw({ x, y });
    if (!clicked.ok) return clicked;

    // BUILD ON THE RAW ENVELOPE, never a fresh object. delegateWithRetry records
    // `retries` on the envelope it returns, and the first version of this wrapper
    // replaced that envelope wholesale — dropping the retry count that
    // phase3-desktop-control.test.js has asserted since Phase 3. Caught by that
    // test, which is what a pre-existing guard is for.
    const shape = (extra) => Object.assign({}, clicked, { result: Object.assign({ clicked: true, x, y }, extra) });

    if (!want || !before || !before.ok) {
      const verdict = clickVerdict(null, want, x, y);
      return evidence.unverified(shape(),
        want
          ? 'the click was delivered at ' + x + ',' + y + ', but the screen could not be read beforehand, '
            + 'so there is nothing to compare against and I cannot confirm the effect.'
          : verdict.reason);
    }

    const settled = await settleForChange({
      read: () => readScreenRegions({}), beforeText: before.text, expect: want,
    });
    const verdict = clickVerdict(settled.kind, want, x, y);
    const base = shape({ attempts: settled.attempts });
    if (verdict.verified) {
      return evidence.verifiedOk(base, { oracle: 'ocr', expected: want, observed: verdict.observed });
    }
    return evidence.unverified(base, verdict.reason);
  }

  return { click_at, clickAtRaw };
}

module.exports = { makeClickAt };
