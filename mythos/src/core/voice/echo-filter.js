'use strict';

// echo-filter.js — own-voice echo filter for the Gemini Live path (BUG-271).
//
// The class of bug (checklist #6): MYTHOS's own voice reaching the speech
// recognizer. This is the BUG-027/056/224/229 class — the speakers replay
// MYTHOS's reply into the mic, the recognizer transcribes it, and the
// transcript is treated as the operator's words, which provokes the next
// reply, which is replayed, which is transcribed... The batch path solved
// this years ago with voice-loop.js's echoMatch + ECHO_GUARD_MS; the Live
// path never got it and accepted every inputTranscription from Gemini
// unfiltered. This module is the server-side port for Live.
//
// Known cost, accepted (checklist #1): if the operator quotes MYTHOS's own
// words back at it within 3s of it saying them, that transcript is dropped
// too — word overlap cannot tell an echo from a quotation. Tunable (raise
// the floor, shorten the window); still cheaper than the self-interrupting
// loop it kills.
//
// Semantics are a verbatim port of the batch path's battle-tested echoMatch:
// lowercase, split on non-[a-z0-9'], echo when >= 60% of the candidate's
// words appear in anything MYTHOS said in the last 3s. A candidate with no
// words at all is an echo whenever a reference exists — nothing real was
// said, so it cannot be the operator.
//
// Pure module: no I/O, clock injectable, never throws.

const ECHO_WINDOW_MS = 3000;     // batch voice-loop.js ECHO_GUARD_MS
const ECHO_OVERLAP_FLOOR = 0.6;  // batch voice-loop.js echoMatch threshold

function wordsOf(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
}

// Verbatim port of voice-loop.js's echoMatch (batch path), exported on its
// own so the ported semantics stay pinned by their own tests. True when
// `text` is an echo of `reference`.
function echoMatch(text, reference) {
  if (!reference) return false;
  const spoken = new Set(wordsOf(reference));
  const words = wordsOf(text);
  if (!words.length) return true;
  let hits = 0;
  for (const w of words) if (spoken.has(w)) hits++;
  return hits / words.length >= ECHO_OVERLAP_FLOOR;
}

// Stateful tracker of what MYTHOS said, with timestamps. match() returns the
// best overlap ratio against anything spoken within the window when that
// ratio clears the floor (the candidate is an echo), else null.
function createEchoFilter({ now = Date.now } = {}) {
  let open = null;    // the utterance still being spoken: { text, at }
  let closed = [];    // finished utterances, each a reference until it ages out

  function prune(t) {
    closed = closed.filter((u) => t - u.at < ECHO_WINDOW_MS);
    if (open && t - open.at >= ECHO_WINDOW_MS) open = null;
  }

  return {
    // One spoken fragment (an outputTranscription chunk). Fragments
    // accumulate into a single utterance until endUtterance() — a real echo
    // routinely straddles fragment boundaries.
    noteSpoken(text) {
      const t = now();
      prune(t);
      if (!open) open = { text: '', at: t };
      open.text += String(text || '');
      open.at = t; // the window runs from the last word spoken
    },
    // The utterance ended (turnComplete). It stays a reference for the rest
    // of its window — speaker bleed arrives after the speech finishes, the
    // same post-playback gap the batch path's ECHO_GUARD_MS covers.
    endUtterance() {
      const t = now();
      prune(t);
      if (open && open.text) closed.push(open);
      open = null;
    },
    // The overlap ratio (>= 0.6) if `text` echoes anything spoken within the
    // window, else null.
    match(text) {
      const t = now();
      prune(t);
      const refs = closed.slice();
      if (open && open.text) refs.push(open);
      if (!refs.length) return null;
      const words = wordsOf(text);
      if (!words.length) return 1; // wordless candidate, something was spoken
      let best = 0;
      for (const u of refs) {
        const spoken = new Set(wordsOf(u.text));
        let hits = 0;
        for (const w of words) if (spoken.has(w)) hits++;
        const ratio = hits / words.length;
        if (ratio > best) best = ratio;
      }
      return best >= ECHO_OVERLAP_FLOOR ? best : null;
    },
  };
}

module.exports = { echoMatch, createEchoFilter };
