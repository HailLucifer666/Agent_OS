'use strict';

// effectors/voice.js — TTS text-shaping helpers (CA from app/lib/voice/tts.js).
//
// This file used to also export createVoiceEffector(), a hub effector with id
// 'speak'. It was removed 2026-07-31 as unreachable dead code:
//   * it declared `tier: 0` on the effector object, but leash/index.js's
//     check() reads TIER_TABLE[toolName] and ignores an effector's own .tier,
//     and there was no 'speak' table key — so it resolved to the T3
//     unknown-tool fail-safe (a confirm popup on speech),
//   * it had no describeMeta(), so it never appeared in hub.catalog() — the
//     single source for the autonomous planner's tool list (goals/index.js),
//     voice-agent's buildCatalogFromHub, live-tools' declarations, MCP
//     tools/list and the boot capabilities manifest. No planner could name it,
//   * and nothing invoked 'speak' by name anywhere.
// Real speech goes bus.emit('action.speak-requested') -> server/index.js's
// subscriber -> proactiveSpeak() -> providers/edge-tts.synthesize().
// The truncation/splitting helpers below are live (server/index.js, tests).

var MAX_CHARS = 350;

function truncateAtSentenceBoundary(text, maxChars) {
  maxChars = maxChars || MAX_CHARS;
  var trimmed = String(text || '').trim();
  if (trimmed.length <= maxChars) return trimmed;
  var window = trimmed.slice(0, maxChars);
  var sentenceEnd = Math.max(
    window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
    (window.endsWith('.') || window.endsWith('!') || window.endsWith('?')) ? window.length - 1 : -1
  );
  if (sentenceEnd > 0) return window.slice(0, sentenceEnd + 1).trim();
  var spaceIdx = window.lastIndexOf(' ');
  if (spaceIdx > 0) return window.slice(0, spaceIdx).trim();
  return window.trim();
}

// Split text into speakable sentences for chunked TTS. Groups very short
// fragments with their successor so we never synthesize a 2-word chunk (the
// per-request overhead would dominate). Same boundary set as
// truncateAtSentenceBoundary above.
var MIN_CHUNK_CHARS = 25;

function splitSentences(text) {
  var trimmed = String(text || '').trim();
  if (!trimmed) return [];
  var parts = trimmed.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [trimmed];
  var chunks = [];
  var buf = '';
  for (var i = 0; i < parts.length; i++) {
    buf += parts[i];
    if (buf.trim().length >= MIN_CHUNK_CHARS || i === parts.length - 1) {
      var t = buf.trim();
      if (t) chunks.push(t);
      buf = '';
    }
  }
  return chunks;
}

// Incremental counterpart to splitSentences() for P20 token-level streaming:
// feed raw text deltas as they arrive from the LLM and get back only the
// sentences that are provably complete (the regex requires terminal
// punctuation, so a chunk is never emitted on a guess). Any trailing text
// with no terminal punctuation yet is held back until either a later push()
// completes it or flush() is called at end-of-stream. Same MIN_CHUNK_CHARS
// grouping as splitSentences so streaming never emits a 2-word chunk either.
function createSentenceStreamer() {
  var buffer = '';
  var acc = '';

  function push(delta) {
    buffer += String(delta || '');
    var parts = buffer.match(/[^.!?]+[.!?]+["')\]]*\s*/g) || [];
    var consumedLen = 0;
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      consumedLen += parts[i].length;
      acc += parts[i];
      if (acc.trim().length >= MIN_CHUNK_CHARS) {
        out.push(acc.trim());
        acc = '';
      }
    }
    buffer = buffer.slice(consumedLen);
    return out;
  }

  // End of stream: whatever is left (completed-but-not-yet-emitted sentences
  // plus any dangling unpunctuated tail) becomes one final chunk, or null if
  // there's nothing left to say.
  function flush() {
    var t = (acc + buffer).trim();
    acc = '';
    buffer = '';
    return t || null;
  }

  return { push, flush };
}

module.exports = { truncateAtSentenceBoundary, splitSentences, createSentenceStreamer };
