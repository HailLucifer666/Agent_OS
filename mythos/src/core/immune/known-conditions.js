'use strict';

// immune/known-conditions.js — anomaly kinds that are KNOWN, already
// instrumented, and have no remedy the healer can perform. Each is ACKNOWLEDGED,
// never healed. Moved out of healer.js on 2026-09-23 (BUG-449) so a fifth could be
// added without raising healer.js's size ratchet; healer.js spreads this list into
// SEED_PLAYBOOKS at the position it used to occupy, so matching order is unchanged.
//
// WHEN NOT TO ADD ONE HERE: an anomaly whose cause is known AND needs the operator
// must stay on the no-match path, which is the only path that runs the explainer.
// test/bug-324-anomaly-must-report-a-cause-it-knows.test.js records why.

const KNOWN_CONDITION_PLAYBOOKS = [
  // F8 (2026-08-15) — THE FIVE KINDS THAT MATCHED NOTHING.
  //
  // 26 anomalies in the 2026-08-14 session reached no-match, and four kinds
  // account for all of the recurring ones: live-turn-no-user-transcript x16,
  // live-turn-silent x3, claimed-action-not-taken x2,
  // live-tool-outcome-late-for-turn x1. (build-engine-fallback-used x4 was the
  // fifth and can no longer be emitted at all — see build-engine.js's F5 note.)
  //
  // The no-match path is expensive: it is what invokes the immune explainer,
  // whose episodic recall was the measured source of loop.stalled. So leaving the
  // MOST COMMON anomalies unmatched made the costly branch the default outcome.
  //
  // These are acknowledged, NOT healed, and that distinction is deliberate. None
  // of them has a remediation the healer can perform — the first is a client-side
  // audio-gate condition, the second a provider behaviour, the third a
  // model-honesty check, the fourth a timing race. Inventing a "fix" for any of
  // them would be worse than admitting there isn't one. What acknowledgement buys
  // is that the system stops treating a known, understood, already-instrumented
  // condition as an unexplained emergency.
  //
  // NOTHING IS HIDDEN BY THIS (rules/core.md §11.2). The health.anomaly records
  // are stored by the server's anomaly subscriber independently of the healer, so
  // every occurrence remains countable in the vault exactly as before; what
  // changes is only that a brain call and a 7-day episodic scan no longer fire
  // for a condition nobody can act on from here.
  {
    id: 'live-turn-no-transcript-known',
    title: 'a Live turn that arrived with no operator transcript',
    when: { kind: 'live-turn-no-user-transcript' },
    then: [{ do: 'acknowledge', args: {
      note: 'Known condition, no automatic remedy. The operator\'s speech reaches Gemini but is '
        + 'not transcribed, most often because the half-duplex gate held it past the preroll ring '
        + '(see s2s-bridge.js F3) or because what reached the VAD was MYTHOS\'s own voice. The '
        + 'release log\'s framesDropped/heldMs is the evidence to read, not this anomaly.',
    } }],
    cooldownMs: 60000
  },
  {
    id: 'live-turn-silent-known',
    title: 'a Live turn that produced text but no audio',
    when: { kind: 'live-turn-silent' },
    then: [{ do: 'acknowledge', args: {
      note: 'Known condition, already remediated elsewhere: BUG-170\'s re-speak path routes a '
        + 'silent turn to the TTS chain with skipLive. Nothing further for the healer to do.',
    } }],
    cooldownMs: 60000
  },
  {
    id: 'claimed-action-not-taken-known',
    title: 'a spoken claim with no tool call behind it',
    when: { kind: 'claimed-action-not-taken' },
    then: [{ do: 'acknowledge', args: {
      note: 'Known condition, handled in-band: the claim checker already injects a correction on '
        + 'the turn itself. Note that a FALSE positive here is worse than a miss — on 2026-08-14 '
        + 'both instances were the detector\'s own category gap (F1b), not the model lying.',
    } }],
    cooldownMs: 60000
  },
  {
    id: 'live-tool-outcome-late-known',
    title: 'a tool outcome that arrived after its turn ended',
    when: { kind: 'live-tool-outcome-late-for-turn' },
    then: [{ do: 'acknowledge', args: {
      note: 'Known condition, by design: reportLateOutcome() pushes the real result into the next '
        + 'turn through the [SYSTEM] channel. This anomaly records the race, it does not report a '
        + 'fault.',
    } }],
    cooldownMs: 60000
  },
  {
    // BUG-449 (2026-09-23 attended run, turn 50): the model rendered a function
    // call as speech — "call:web_search{maxResults:5,query:…" — and the call it
    // named never ran. Known condition, no automatic remedy: the text has already
    // been spoken by the time its transcript arrives, and preventing that needs
    // the validated text lane (decision D7, deferred). Acknowledged rather than
    // explained, for two reasons: the explainer's spoken line is held back during
    // Live anyway (Live is the only path with an output transcript to scan), and
    // its brain call plus episodic recall is the measured cost F8 above exists to
    // avoid. Nothing is hidden: the anomaly row is stored either way.
    id: 'spoken-tool-syntax-known',
    title: 'a reply that spoke tool-call syntax aloud',
    when: { kind: 'spoken-tool-syntax' },
    then: [{ do: 'acknowledge', args: {
      note: 'Known condition, no automatic remedy. The reply spoke a tool call as text, and the '
        + 'parsed text is never executed. The anomaly row names the tool and whether a real call of '
        + 'it ran that turn. Prevention needs the validated voice lane (decision D7).',
    } }],
    cooldownMs: 60000
  },
  {
    // BUG-275, 2026-09-23: a changeable fact stated as current with no web lookup
    // behind it (voice/unsearched-current-fact.js). Telemetry by design — judging
    // prose can be wrong, so it is never spoken — and acknowledged here for the
    // same reasons as spoken-tool-syntax above.
    id: 'unsearched-current-fact-known',
    title: 'a changeable fact stated as current without a web lookup',
    when: { kind: 'unsearched-current-fact' },
    then: [{ do: 'acknowledge', args: {
      note: 'Known condition, no automatic remedy. The reply stated something that can change as '
        + 'current fact with no web lookup in its evidence window. Replayed over two whole days '
        + 'before shipping: 2 real hits and 1 false positive in 773 sentences. Making the model '
        + 'search first needs the validated voice lane (decision D7).',
    } }],
    cooldownMs: 60000
  }
];

module.exports = { KNOWN_CONDITION_PLAYBOOKS };
