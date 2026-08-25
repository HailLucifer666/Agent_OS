'use strict';

// test/reasoning-leak-2026-08-12-fixtures.test.js — live-verification follow-up,
// 2026-08-14. BUGS.md's deferred-fixture item: the operator's own vault
// (gitignored, both the batch mythos/vault AND the Electron app's
// %APPDATA%\agent-os\vault) still holds the raw incident session that
// motivated the 2026-08-12 stripReasoningLead fix (see live-session.js's own
// "2026-08-12" comments and test/live-reasoning-strip.test.js's simplified
// paraphrase of the same incident). These are the ACTUAL texts, verbatim,
// pulled from Episodic/2026-08-11.jsonl and Episodic/2026-08-12.jsonl
// (%APPDATA%\agent-os\vault — the Electron app's vault; the vault-day file
// name uses IST rollover, so entries timestamped late on 2026-08-11 UTC are
// the 2026-08-12 IST vault day). No personal data was embedded in any of the
// six (checked: no names, phone numbers, addresses, or account details —
// "account number" in fixture 3 is the OPERATOR'S QUESTION being discussed,
// not a real one) so nothing needed scrubbing.
//
// Two of these six were NOT fully caught by the 2026-08-12 fix as it shipped:
//   - fixture 2's SECOND "Self-Correction" header used different wording
//     ("Self-Correction during reasoning:") than the first, and the original
//     SELF_CORRECTION_RE only ever found the FIRST occurrence of the literal
//     string "Self-Correction:" (non-global .exec()) — so the second header,
//     and everything the real fix was supposed to remove, sailed through
//     untouched.
//   - fixture 6's "Output:" header (marking where the model's own answer
//     actually starts) had no recognized marker at all, so it was spoken
//     to the operator verbatim as a mechanical label glued onto a perfectly
//     good reply.
// Both are fixed in live-session.js (SELF_CORRECTION_RE widened to tolerate
// wording between "Self-Correction" and its colon; new REASONING_AFTER_RE
// and OUTPUT_LABEL_RE markers added; the marker scan now finds the LAST
// occurrence of each marker across the whole string, not just the first).
//
// The remaining four keep one residual imperfection each (a truncated
// mid-word ending on two of them — the vault record itself is cut off
// there, not a stripping defect; a single non-"I" leaked sentence glued in
// front of the real answer on the other two) — this is the SAME deliberate,
// documented trade-off peelContinuationSentences already makes everywhere
// else in this file: it only ever peels a leading "I ..." or numbered
// sentence, precisely so a genuine reply that opens with an ordinary
// sentence is never mistaken for reasoning and eaten. Chasing that further
// is exactly what test/bug-170-reasoning-strip-and-silent-turn.test.js's
// "CRITICAL fix" comment already warns against. The assertion below
// therefore checks the actual contract stripReasoningLead makes: the result
// is never empty, and it never RE-OPENS with a recognized reasoning-lead
// marker — not that every trace of reasoning is scrubbed from the whole
// turn, which was never this function's job.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { stripReasoningLead } = require('../src/core/voice/live-session');

// A superset of the module's own marker regexes, used only to assert the
// OUTPUT never re-opens with one of them — never used to decide what to
// strip (that stays live-session.js's job).
const REOPENS_WITH_LEAK_RE =
  /^(?:[\s>*_#-]*(?:reasoning|thinking|thought|thoughts|chain[\s-]of[\s-]thought|internal(?:\s+monologue)?)[\s*_]*:|the user (?:is asking|asked)\b|self-correction\b[^:\n]{0,60}:|correction plan:|reasoning after\b[^:\n]{0,60}:|output:)/i;

describe('2026-08-12/13 incident session — real leaked-reasoning fixtures (verbatim from the operator vault)', () => {
  it('fixture 1 (ts 1786478437544) — Google News/Tier-3 turn: label stripped, no re-opening leak', () => {
    const leaked = 'The user is asking why I mentioned Google News headlines in the previous turn and is using the phrase "Tier 3 approval," which is external terminology (perhaps based on their interaction style preference for clear goals and tracking, which I misread as implying a structured approval system). My previous turn\'s tool call to `google_news_fetch` apparently failed internally (implied by the conversation context, even though the user\'s log shows `gmail_unread` failing, my previous prose explicitly mentions seeing headlines via Google News). I need to clarify that I didn\'t ask for "approval" but was simply reporting what resources I successfully accessed versus what failed (Gmail). I should address their phrasing directly but correct the context based on my previous reply.\n\nSelf-Correction: My previous reply said: "can see some headlines trickling through on Google News". It didn\'t mention a *failure* or *asking for approval* for Google News. The failure was with Gmail. The user\'s query migh';
    const cleaned = stripReasoningLead(leaked);
    assert.notEqual(cleaned.trim(), '', 'must never hand the caller nothing to speak');
    assert.ok(!REOPENS_WITH_LEAK_RE.test(cleaned), 'must not re-open with a recognized reasoning-lead marker: ' + JSON.stringify(cleaned.slice(0, 60)));
    assert.ok(!cleaned.startsWith('The user'), 'the third-person narration lead specifically must be gone');
  });

  it('fixture 2 (ts 1786478490331) — google_news_fetch technical turn: SECOND differently-worded Self-Correction header now caught', () => {
    const leaked = 'The user is asking about the technical implementation of the failed `google_news_fetch` call, specifically suggesting I might have used a Google API. The SYSTEM NOTICE explicitly stated the failure reason: `unknown-effector: no tool named "google_news_fetch"`. This means I tried to use a tool identifier that doesn\'t exist in my actual tool list, not that an API call failed. I need to explain this distinction clearly adhering to the HONESTY and SUCCESS rules. I must *not* claim I used an API or that it failed due to external reasons; the failure was internal to my system\'s knowledge of its own tools.\n\nCorrection plan:\n1. Directly answer \'no\'.\n2. Explain the actual failure reason from the SYSTEM NOTICE: I tried to call a tool (`google_news_fetch`) that simply doesn\'t exist in my catalog of available tools.\n3. Contrast this with an API failure to clarify the user\'s technical question.\n4. Maintain the honest, slightly chagrined but declarative tone.\n\nSelf-Correction during reasoning: I sho';
    const cleaned = stripReasoningLead(leaked);
    // Before the 2026-08-14 fix this returned 'Self-Correction during reasoning: I sho'
    // — the second, differently-worded header reached the operator verbatim.
    assert.notEqual(cleaned.trim(), '', 'must never hand the caller nothing to speak');
    assert.ok(!REOPENS_WITH_LEAK_RE.test(cleaned), 'the second Self-Correction header (different wording) must be gone too: ' + JSON.stringify(cleaned));
    assert.equal(cleaned, 'I sho', 'the vault record itself is truncated here — this is the real remaining text, not a graceful sentence');
  });

  it('fixture 3 (ts 1786481967410) — account-number clarifying question: narration lead gone, real question intact', () => {
    const leaked = 'The user asked for the "account number". I don\'t have enough context, so I need to ask a clarifying question about which account they are referring to.\n\nI should reason that this could be a sensitive request, and MYTHOS, with its Dry, Warm, and Unhurried persona, would not jump to fulfill a vaguely stated financial request without more information, adhering strictly to the CLARIFYING QUESTIONS rule for genuinely ambiguous situations.\n\nTherefore, the response should be a natural sentence asking for clarification and should not call any tool.Which account are you referring to, sir? There are no bank details on record, and I wouldn\'t have a way to access that information without more specific direction. What are you trying to achieve?';
    const cleaned = stripReasoningLead(leaked);
    assert.notEqual(cleaned.trim(), '', 'must never hand the caller nothing to speak');
    assert.ok(!REOPENS_WITH_LEAK_RE.test(cleaned), 'must not re-open with a recognized reasoning-lead marker: ' + JSON.stringify(cleaned.slice(0, 60)));
    assert.ok(cleaned.includes('Which account are you referring to, sir?'), 'the real clarifying question must survive intact');
  });

  it('fixture 4 (ts 1786455171836) — volume-teasing callback: new "Reasoning after tool analysis:" header now caught', () => {
    const leaked = 'The user is asking about the "volume thing" which they interpret as an unresolved issue based on my previous teasing message. I need to clarify that it was humor and that volume control is functional, but specify its limits (stepped media key vs. exact level set) per tool capabilities. I should check current volume status to be informative. Using `get_volume` will provide evidence.\n\nReasoning after tool analysis: I should clearly state that volume isn\'t \'broken,\' it was just a conversational callback. To be truly helpful, I\'ll explain that I can step the volume up/down or mute (using `media_key`) and suggest using `set_volume` if they need a precise percentage — educating them on the difference between fixed steps and convergent exactness as per the prompt guidelines.\nOh, no, it\'s not broken at all. I was just teasing about the "volume traps" mentioned earlier. To be fair, I can step it up and down, mute and unmute. If you need an exact percentage, I have another tool that can do that,';
    const cleaned = stripReasoningLead(leaked);
    // Before the 2026-08-14 fix, "Reasoning after tool analysis:" was not a
    // recognized marker at all, so this whole paragraph (plus everything
    // ahead of it) reached the operator's ears.
    assert.notEqual(cleaned.trim(), '', 'must never hand the caller nothing to speak');
    assert.ok(!REOPENS_WITH_LEAK_RE.test(cleaned), 'must not re-open with a recognized reasoning-lead marker: ' + JSON.stringify(cleaned.slice(0, 60)));
    assert.ok(cleaned.includes('not broken at all'), 'the real answer must survive');
  });

  it('fixture 5 (ts 1786455408457) — OCR shortcut question: differently-worded "Reasoning after tool consideration:" also caught', () => {
    const leaked = 'The user is asking about a shortcut key for OCR, possibly referencing a feature on their machine or system rather than a capability I directly *have*. My tool `screen_read_text` performs OCR when called, and `screen_look` also uses it for evidence validation in its `ocrSample` result. I don\'t control the host system\'s global keyboard shortcuts. I need to explain this context to remain honest about what I can do versus what the keyboard shortcuts are. I should check memory first per REASONING guidelines by calling `recall_memory` to see if there\'s any precedent for this shortcut in past conversations, since continuity is important.\n\nReasoning after tool consideration: While `screen_read_text` *is* the real OCR tool, the user is specifically asking about a *shortcut key*. I don\'t know the user\'s local system shortcuts and don\'t have a tool to set them or read them globally. I should search my memory for context using `recall_memory`, but regardless of whether I find anything, I must be h';
    const cleaned = stripReasoningLead(leaked);
    assert.notEqual(cleaned.trim(), '', 'must never hand the caller nothing to speak');
    assert.ok(!REOPENS_WITH_LEAK_RE.test(cleaned), 'must not re-open with a recognized reasoning-lead marker: ' + JSON.stringify(cleaned.slice(0, 60)));
    assert.ok(!cleaned.startsWith('The user'), 'the third-person narration lead specifically must be gone');
  });

  it('fixture 6 (ts 1786462939378) — "how are you" small talk: new "Output:" header now caught, leaving a clean natural reply', () => {
    const leaked = 'The user is asking yet another variation of "how are you?". I need to keep the conversational chain going without being redundant. I should stick to the persona—dry, witty, measured—and give a response that feels continuous with the previous turn about observing the digital universe. I can offer a slightly more opinionated or observational twist to keep it interesting.\n\nOutput: Manageable, mostly. The data streams are flowing as usual, and I haven\'t accidentally deleted anything critical yet. Always a good day in my book. And for you? Things staying orderly?';
    const cleaned = stripReasoningLead(leaked);
    // Before the 2026-08-14 fix this returned the "Output:" label still
    // attached to the front of an otherwise-clean reply.
    assert.equal(cleaned, 'Manageable, mostly. The data streams are flowing as usual, and I haven\'t accidentally deleted anything critical yet. Always a good day in my book. And for you? Things staying orderly?',
      'the "Output:" header must be gone, leaving exactly the natural reply behind it');
  });
});
