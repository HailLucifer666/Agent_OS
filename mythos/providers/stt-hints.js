'use strict';

// providers/stt-hints.js — recognition hints for the STT chain.
//
// WHY THIS EXISTS, and where the idea came from. The operator asked why Claude
// Code's own dictation transcribes "MYTHOS", "STT" and "dsh" correctly while
// MYTHOS's mishears them. Read from Claude Code's published voice-dictation
// documentation (code.claude.com/docs/en/voice-dictation, 2026-08-22), the
// answer is one sentence:
//
//   "Transcription is tuned for coding vocabulary in both modes. Common
//    development terms like regex, OAuth, JSON, and localhost are recognized
//    correctly, and your current project name and git branch name are added as
//    recognition hints automatically."
//
// The MODEL behind that is not available to us — the same docs say the service
// requires a Claude.ai account, is explicitly unavailable when authenticating
// with an API key, and streams audio to Anthropic's own endpoint. So this is NOT
// an attempt to reproduce it. What IS reproducible is the *technique*, because
// Whisper takes an optional `prompt` field that biases decoding toward the
// vocabulary it contains, and MYTHOS was sending none.
//
// WHAT A WHISPER PROMPT ACTUALLY DOES, because misunderstanding it makes things
// worse. It is not an instruction and it is not a glossary lookup. It is treated
// as *preceding transcript text*, so the decoder's language model becomes more
// willing to emit tokens that look like it. Three consequences that shape
// everything below:
//
//   1. It biases, it does not constrain. A word in the prompt is more likely,
//      never guaranteed, and a word absent from it is not forbidden.
//   2. It is capped at 224 tokens and SILENTLY TRUNCATED past that. A long list
//      does not fail loudly — it quietly loses its tail, so the most valuable
//      terms have to come FIRST rather than in whatever order a directory walk
//      produced.
//   3. It can be echoed. Because it reads as prior transcript, a prompt written
//      as a sentence can leak fragments of that sentence into the output on
//      near-silent audio. This repo already documented Whisper inventing stock
//      phrases from silence (see groq-stt.js's HALLUCINATION_PHRASES), and a
//      prompt gives it fresh material to invent from. So this file emits a bare
//      comma-separated TERM LIST and never a sentence — there is no grammatical
//      frame for the decoder to continue.
//
// DELIBERATELY STATIC, not derived from the vault at call time. Two reasons: a
// per-utterance directory walk on the voice hot path is latency nobody asked
// for, and vault content is operator text that would then be fed back into the
// recognizer — a loop where one mishearing teaches the next. The git branch name
// IS included because it is cheap, bounded, and exactly what Claude Code uses.

var { execFileSync } = require('child_process');
var path = require('path');

// Ordered MOST-VALUABLE-FIRST because of the 224-token truncation above. The
// terms MYTHOS mishears are the ones a general-purpose recognizer has no reason
// to expect: its own name, its subsystem names, and its tool names.
//
// Every entry here has to be a word the operator actually SAYS out loud. A tool
// name nobody pronounces is pure token budget spent for nothing, so this is not
// the effector catalogue — it is the spoken vocabulary of this project.
var CORE_TERMS = [
  // The product and its parts. "MYTHOS" is the single most common miss.
  'MYTHOS', 'Agent OS', 'HUD', 'vault', 'cortex', 'leash', 'effector', 'adapter',
  'sensor', 'lane', 'persona', 'engagement', 'Forge', 'kanban',
  // The build engine and its neighbours (W6, 2026-08-22).
  'dsh', 'DeepSeek Harness', 'Hermes', 'Codestral', 'Mistral', 'Cerebras',
  'Groq', 'OpenRouter', 'NIM', 'Gemini', 'Ollama',
  // Voice subsystem words, which get spoken while debugging voice.
  'STT', 'TTS', 'wake word', 'barge-in', 'VAD', 'Whisper', 'edge-tts',
  'Gemini Live', 'openWakeWord', 'Silero', 'Piper', 'Kokoro',
  // Development vocabulary a general model already knows but which competes
  // with ordinary English homophones when spoken.
  'repo', 'commit', 'branch', 'rebase', 'regex', 'JSON', 'YAML', 'OAuth',
  'localhost', 'npm', 'Node', 'Electron', 'adb', 'MCP', 'API key', 'env',
];

// The git branch name, exactly as Claude Code does it. Cheap, bounded, and the
// term most likely to be spoken and least likely to be guessable.
//
// Read once and cached: a spawnSync on every utterance is latency on the voice
// hot path. A branch change mid-session is not worth paying for on every turn,
// and the stale value is still a valid hint rather than a wrong answer.
var cachedBranch;
function gitBranch() {
  if (cachedBranch !== undefined) return cachedBranch;
  cachedBranch = null;
  try {
    var out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    var name = String(out || '').trim();
    // A detached HEAD reports 'HEAD', which is not a word anyone dictates.
    if (name && name !== 'HEAD') cachedBranch = name;
  } catch (_) {
    // Not a git checkout, or no git on PATH. A missing branch hint is not a
    // failure — this whole module is an accuracy aid, never a requirement.
  }
  return cachedBranch;
}

// Whisper's prompt cap is 224 TOKENS, which nothing here can count exactly
// without a tokenizer. Bound the CHARACTER length well inside it instead: at a
// conservative ~3 characters per token for short technical words, 600 characters
// stays under the cap with room to spare. Under-using the budget costs a little
// accuracy; over-running it loses the tail silently, and silent loss is the
// worse failure.
var MAX_PROMPT_CHARS = 600;

// A comma-separated term list, never a sentence — see consequence 3 above.
// Branch name goes FIRST: it is the least guessable term and must survive
// truncation.
function buildPrompt(extraTerms) {
  var terms = [];
  var branch = gitBranch();
  if (branch) terms.push(branch);
  if (Array.isArray(extraTerms)) {
    for (var i = 0; i < extraTerms.length; i++) {
      var t = String(extraTerms[i] || '').trim();
      if (t) terms.push(t);
    }
  }
  terms = terms.concat(CORE_TERMS);

  var seen = Object.create(null);
  var out = [];
  var len = 0;
  for (var j = 0; j < terms.length; j++) {
    var term = terms[j];
    var key = term.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    var add = (out.length ? 2 : 0) + term.length;   // ', ' + term
    if (len + add > MAX_PROMPT_CHARS) break;        // truncate HERE, knowingly
    out.push(term);
    len += add;
  }
  return out.join(', ');
}

module.exports = {
  buildPrompt: buildPrompt,
  CORE_TERMS: CORE_TERMS,
  MAX_PROMPT_CHARS: MAX_PROMPT_CHARS,
  // Exported for tests only.
  _gitBranch: gitBranch,
  _resetBranchCache: function () { cachedBranch = undefined; },
};
