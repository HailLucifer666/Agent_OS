// probes.js — honest status probes for agent tiles. No faking green.
const http = require('http');
const { spawnSync } = require('child_process');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const PROBE_TIMEOUT_MS = 800;
const DEFAULT_CHAT_MODEL = process.env.OLLAMA_MODEL || 'qwen3:latest';

let heartbeatTicks = 0;
setInterval(() => { heartbeatTicks += 1; }, 4000);

// Detect claude CLI once at module load; cache the result.
function detectClaudeCli() {
  try {
    const result = spawnSync('claude', ['--version'], { shell: true, timeout: 5000, encoding: 'utf8' });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}
const claudeCliVersion = detectClaudeCli();

function pingOllama() {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = http.get(`${OLLAMA_URL}/api/tags`, { timeout: PROBE_TIMEOUT_MS }, (res) => {
      const latency = Date.now() - start;
      res.resume();
      resolve({ ok: res.statusCode === 200, latency });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, latency: null }); });
    req.on('error', () => resolve({ ok: false, latency: null }));
  });
}

function hasKey(name) {
  return Boolean(process.env[name] && process.env[name].trim().length > 0);
}

async function getStatus() {
  const ollama = await pingOllama();
  const openrouterKey = hasKey('OPENROUTER_API_KEY');
  const anthropicKey = hasKey('ANTHROPIC_API_KEY');
  const zcodeKey = hasKey('ZCODE_API_KEY');
  const nimKey = hasKey('NIM_API_KEY');

  const claude = claudeCliVersion
    ? { id: 'claude', label: 'Claude', status: 'ONLINE', detail: `claude cli ${claudeCliVersion} · wired` }
    : {
      id: 'claude',
      label: 'Claude',
      status: anthropicKey ? 'DEGRADED' : 'OFFLINE',
      detail: anthropicKey ? 'key present · CLI missing' : 'no ANTHROPIC_API_KEY',
    };
  const openclaw = {
    id: 'openclaw',
    label: 'OpenClaw',
    status: 'OFFLINE',
    detail: 'gateway not configured',
  };
  const hermes = {
    id: 'hermes',
    label: 'Hermes',
    status: ollama.ok ? 'ONLINE' : 'OFFLINE',
    detail: ollama.ok ? `ollama up · ${ollama.latency}ms · ${DEFAULT_CHAT_MODEL}` : 'ollama unreachable :11434',
  };
  const zcode = {
    id: 'zcode',
    label: 'ZCode',
    status: zcodeKey ? 'ONLINE' : 'OFFLINE',
    detail: zcodeKey
      ? `z.ai glm · ${process.env.ZCODE_MODEL || 'glm-4.6'}`
      : 'no ZCODE_API_KEY',
  };
  const nim = {
    id: 'nim',
    label: 'NIM',
    status: nimKey ? 'ONLINE' : 'OFFLINE',
    detail: nimKey
      ? `nvidia nim · ${process.env.NIM_MODEL || 'nvidia/llama-3.1-nemotron-70b-instruct'}`
      : 'no NIM_API_KEY',
  };
  const freeClaude = claudeCliVersion
    ? { id: 'free-claude', label: 'Free Claude Code', status: 'DEGRADED', detail: 'cli ready · builder lands next' }
    : {
      id: 'free-claude',
      label: 'Free Claude Code',
      status: anthropicKey ? 'DEGRADED' : 'OFFLINE',
      detail: anthropicKey ? 'key present · builder not wired' : 'no key configured',
    };

  const latencies = [ollama.ok ? ollama.latency : null].filter((v) => v !== null);
  const p50 = latencies.length ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)] : null;

  return {
    ollama,
    keys: { openrouter: openrouterKey, anthropic: anthropicKey, zcode: zcodeKey, nim: nimKey },
    heartbeat: { ticks: heartbeatTicks, intervalMs: 4000 },
    latency: { p50 },
    agents: [claude, openclaw, hermes, zcode, nim, freeClaude],
  };
}

module.exports = { getStatus, pingOllama };
