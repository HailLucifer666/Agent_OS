// reasoning.js — picks the reasoning engine the orchestrator should use.
// Priority: Mistral (HTTP) → ZCode (HTTP) → NIM (HTTP) → Claude Code CLI (local binary).
// This lets Pipeline/Kanban/Game/Video agents run without the Claude CLI installed,
// as long as MISTRAL_API_KEY or ZCODE_API_KEY or NIM_API_KEY is set. Falls back to
// the CLI for backward compatibility if no HTTP key is configured.
const { spawnSync } = require('child_process');
const zcode = require('./providers/zcode');
const nim = require('./providers/nim');
const mistral = require('./providers/mistral');
const claudeCli = require('./providers/claude-cli');

// Detect the claude binary once at module load; cache the result.
let _claudeCliOk = null;
function claudeCliAvailable() {
  if (_claudeCliOk !== null) return _claudeCliOk;
  try {
    const result = spawnSync('claude', ['--version'], { shell: true, timeout: 5000, encoding: 'utf8' });
    _claudeCliOk = !!(result.status === 0 && result.stdout && result.stdout.trim());
  } catch {
    _claudeCliOk = false;
  }
  return _claudeCliOk;
}

// Returns { provider, id } for the first available engine, or null if none.
function getReasoningProvider() {
  if (mistral.isAvailable()) return { provider: mistral, id: 'mistral' };
  if (zcode.isAvailable()) return { provider: zcode, id: 'zcode' };
  if (nim.isAvailable()) return { provider: nim, id: 'nim' };
  if (claudeCliAvailable()) return { provider: claudeCli, id: 'claude-cli' };
  return null;
}

// Delegates chat() to whichever engine is available; throws clearly if none.
async function chat(messages, opts = {}) {
  const entry = getReasoningProvider();
  if (!entry) {
    throw new Error(
      'no reasoning engine available — set MISTRAL_API_KEY, ZCODE_API_KEY or NIM_API_KEY in app/.env, ' +
      'or install the Claude Code CLI.',
    );
  }
  return entry.provider.chat(messages, opts);
}

// Human-readable summary for startup logs.
function describeEngines() {
  const m = mistral.isAvailable() ? 'on' : 'off';
  const z = zcode.isAvailable() ? 'on' : 'off';
  const n = nim.isAvailable() ? 'on' : 'off';
  const c = claudeCliAvailable() ? 'on' : 'off';
  return `mistral:${m} zcode:${z} nim:${n} claude-cli:${c}`;
}

module.exports = { chat, getReasoningProvider, describeEngines, claudeCliAvailable };
