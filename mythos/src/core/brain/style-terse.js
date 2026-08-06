'use strict';

// style-terse.js — the "caveman" output-compression directive.
//
// Adapted from the caveman skill (https://github.com/JuliusBrussee/caveman),
// which reports ~65% fewer output tokens on chat-style prose with the technical
// substance preserved. See THIRD_PARTY_NOTICES.md for attribution.
//
// VENDORED ON PURPOSE. Upstream installs via `curl … | bash` / `irm … | iex`;
// root CLAUDE.md forbids that pattern outright, and there is nothing to execute
// here anyway — the whole artefact is a prompt string. Keeping it as a tracked
// constant also means the exact wording that shaped a given output is in git,
// which a network-fetched skill file would not be.
//
// SCOPE IS THE WHOLE POINT. This is applied per LANE (BRAIN_TERSE_LANES) and is
// off for anything the operator hears:
//   - 'voice' is spoken aloud; caveman-terse speech reads as a malfunction, and
//     voice-agent.js already caps `say` at 800 chars so there was little to win.
//   - 'build' emits artifact content (source files) — a brevity instruction
//     there truncates real code.
// A caller on a spoken path that happens to use an included lane opts out with
// think({ terse: false }); the boot greeting (lane 'simple', spoken) does that.
//
// The "unchanged" clause is load-bearing, not decoration: this repo's evidence
// contract depends on error strings and tool payloads round-tripping verbatim,
// so compressing them would corrupt audit reasons rather than save tokens.

const TERSE_STYLE = [
  'OUTPUT STYLE — terse. Compress prose, never substance.',
  'Drop: articles (a/an/the), filler (just, really, basically, actually, simply),',
  'pleasantries, hedging, and restating the question before answering.',
  'Sentence fragments are fine. Prefer short synonyms (big not extensive, fix not',
  '"implement a solution for"). Keep every technical term exact.',
  'Reproduce code, commands, file paths, identifiers, JSON and error messages',
  'BYTE-FOR-BYTE — never abbreviate, summarize or reformat them.',
  'If the response must satisfy a schema or output contract stated elsewhere in',
  'this prompt, that contract wins over this style rule.',
].join(' ');

module.exports = { TERSE_STYLE };
