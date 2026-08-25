'use strict';
// audit-providers.js — what can this machine's keys ACTUALLY call, right now?
//
//   node mythos/scripts/audit-providers.js
//   node mythos/scripts/audit-providers.js --provider mistral --top 20
//   node mythos/scripts/audit-providers.js --agentic-only
//
// WHY THIS EXISTS. Three separate sessions have guessed model ids and been wrong
// (`llama-3.3-70b-versatile` on Groq → 404, three Cerebras ids → 404, four
// NVIDIA ids → 404), and `lanes.default.js` carries a DEAD-ROUTE list precisely
// because advertised ≠ callable. This asks each endpoint what it serves, then
// PROVES each candidate by calling it. Nothing here is recalled.
//
// WHAT "FREE" MEANS HERE, because the word is doing real work. Only OpenRouter
// publishes per-model pricing, so for everyone else this reports the operationally
// honest thing: does THIS key get a 200 without a billing error. A `402 Payment
// required` (which Cerebras returns on this machine) means those models are not
// free for this account no matter what the vendor's pricing page says.
//
// THREE CAPABILITIES ARE TESTED, because "can be used" depends on the job:
//   chat    — a plain completion returns 200
//   tools   — the model emits a tool_call. This is the AGENTIC gate: dsh's Forge
//             path writes files through tools, so a model that only chats cannot
//             drive a build no matter how good its prose is.
//   bigctx  — a ~10.7k-token request is accepted. That is dsh's MEASURED fixed
//             overhead (system prompt + tool definitions) before any task text,
//             read off Groq's 413s twelve times. A model that refuses it cannot
//             host dsh at all, which is what disqualified Groq's free tier.
//
// No secret is printed. Keys are read from mythos/.env then the repo-root
// .env.local, the same order the rest of the scripts use.

const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
for (const rel of [path.join(REPO_ROOT, '.env'), path.join(REPO_ROOT, '..', '.env.local')]) {
  try { process.loadEnvFile(rel); } catch (_) { /* optional */ }
}

// OpenAI-compatible providers, plus Google which needs its own shape.
//
// BASE URLS ARE MEASURED, NOT GUESSED. opencode's is `opencode.ai/zen/v1`:
// `api.opencode.ai/v1/models` answers 200 with an EMPTY list, which is worse
// than an error because it looks like a working endpoint that serves nothing,
// and `opencode.ai/api/v1` returns an HTML page.
const PROVIDERS = [
  { name: 'mistral',   env: 'MISTRAL_API_KEY',    base: 'https://api.mistral.ai/v1' },
  { name: 'groq',      env: 'GROQ_API_KEY',       base: 'https://api.groq.com/openai/v1' },
  { name: 'cerebras',  env: 'CEREBRAS_API_KEY',   base: 'https://api.cerebras.ai/v1' },
  { name: 'nvidia',    env: 'NVIDIA_API_KEY',     base: 'https://integrate.api.nvidia.com/v1' },
  { name: 'nim',       env: 'NIM_API_KEY',        base: 'https://integrate.api.nvidia.com/v1' },
  { name: 'openrouter', env: 'OPENROUTER_API_KEY', base: 'https://openrouter.ai/api/v1' },
  { name: 'b.ai',      env: 'B_AI_KEY',           base: 'https://api.b.ai/v1' },
  { name: 'opencode',  env: 'OPENCODE_KEY',       base: 'https://opencode.ai/zen/v1' },
  { name: 'google',    env: 'GOOGLE_API_KEY',     base: 'https://generativelanguage.googleapis.com/v1beta', kind: 'google' },
];

const TOOLS = [{
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Write a file to disk',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
}];
// ~10k tokens of filler. Deliberately near dsh's measured 10,760-token floor.
const BIG = 'The quick brown fox jumps over the lazy dog. '.repeat(1000);

// Anything that cannot host a text build. Filtered before testing so the budget
// goes on candidates rather than on embedding and audio endpoints.
const NOT_A_BUILD_MODEL = /embed|whisper|tts|speech|audio|voice|guard|rerank|moderat|ocr|image|dall|flux|sora|video|diffusion|sana|riva|codec|parse|extract/i;

// Ranking heuristic: coding specialists first (this is for a BUILD engine), then
// big instruct models, then everything else. Within a tier, longer/newer-looking
// ids sort later so an explicit version beats a bare family name.
function score(id) {
  let s = 0;
  if (/codestral|devstral|coder|code|qwen.*coder/i.test(id)) s += 1000;
  if (/large|medium|120b|70b|235b|253b|550b|ultra|pro|max/i.test(id)) s += 300;
  if (/instruct|chat|it\b/i.test(id)) s += 100;
  if (/glm|nemotron|qwen|llama|gpt-oss|gemma|mistral|magistral|kimi|deepseek/i.test(id)) s += 50;
  if (/preview|exp|alpha|beta|nightly/i.test(id)) s -= 40;
  if (/\bnano\b|\bmini\b|\b1b\b|\b3b\b|\b7b\b|\b8b\b|lite|tiny|small/i.test(id)) s -= 60;
  return s;
}

function brief(text) {
  const m = /"(?:message|detail|title|raw)":\s*"?([^"]{0,120})/.exec(text);
  if (m) return m[1];
  return String(text).replace(/\s+/g, ' ').slice(0, 100);
}

async function req(url, opts, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 45000);
  try {
    const r = await fetch(url, Object.assign({ signal: ac.signal }, opts));
    return { status: r.status, text: await r.text() };
  } catch (err) {
    return { status: 0, text: 'NO RESPONSE (' + String((err && err.name) || err) + ')' };
  } finally {
    clearTimeout(timer);
  }
}

async function listModels(p, key) {
  if (p.kind === 'google') {
    const r = await req(p.base + '/models?key=' + encodeURIComponent(key), {}, 30000);
    if (r.status !== 200) return { error: r.status + ' ' + brief(r.text) };
    const models = (JSON.parse(r.text).models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''));
    return { ids: models };
  }
  const r = await req(p.base + '/models', { headers: { Authorization: 'Bearer ' + key } }, 30000);
  if (r.status !== 200) return { error: r.status + ' ' + brief(r.text) };
  let body;
  try { body = JSON.parse(r.text); } catch (_) { return { error: 'unparseable /models body' }; }
  return { ids: (body.data || []).map((m) => m.id).filter(Boolean), raw: body.data || [] };
}

async function testModel(p, key, id) {
  const out = { id: id, chat: null, tools: null, bigctx: null, note: '' };

  if (p.kind === 'google') {
    // Google's generateContent takes a different body; tool declarations differ
    // enough that a like-for-like tools probe would be its own exercise. Report
    // chat honestly and say so rather than guessing.
    const r = await req(p.base + '/models/' + encodeURIComponent(id) + ':generateContent?key=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'say ok' }] }],
        generationConfig: { maxOutputTokens: 8 } }),
    }, 40000);
    out.chat = r.status === 200 ? 'yes' : String(r.status);
    if (r.status !== 200) out.note = brief(r.text).slice(0, 70);
    out.tools = 'n/t';
    out.bigctx = 'n/t';
    return out;
  }

  const chat = await req(p.base + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: id, max_tokens: 8, messages: [{ role: 'user', content: 'say ok' }] }),
  }, 45000);
  out.chat = chat.status === 200 ? 'yes' : String(chat.status);
  if (chat.status !== 200) {
    out.note = brief(chat.text).slice(0, 78);
    return out;   // no point testing tools on a model that will not answer
  }

  const tools = await req(p.base + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: id, max_tokens: 96, tools: TOOLS,
      messages: [{ role: 'user', content: 'Write hello.txt containing hi. Use the tool.' }] }),
  }, 60000);
  if (tools.status !== 200) {
    out.tools = 'no';
    out.note = brief(tools.text).slice(0, 78);
  } else {
    let msg = null;
    try { msg = JSON.parse(tools.text).choices[0].message; } catch (_) { /* fall through */ }
    out.tools = (msg && (msg.tool_calls || []).length) ? 'YES' : 'no-call';
  }

  const big = await req(p.base + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: id, max_tokens: 8, tools: TOOLS,
      messages: [{ role: 'system', content: BIG }, { role: 'user', content: 'say ok' }] }),
  }, 60000);
  out.bigctx = big.status === 200 ? 'yes' : String(big.status);
  if (big.status !== 200 && !out.note) out.note = brief(big.text).slice(0, 78);

  return out;
}

// Write a reference doc of USABLE models only — everything listed here answered
// a real request on this machine's keys. Failures stay on stdout: a model that
// will not answer is not a choice, so listing it would be noise.
function writeMarkdown(outPath, rows) {
  const fs = require('fs');
  const byProvider = new Map();
  for (const r of rows) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, []);
    byProvider.get(r.provider).push(r);
  }

  const L = [];
  L.push('# Usable models, by provider');
  L.push('');
  L.push('**Generated by `node mythos/scripts/audit-providers.js --all --markdown <path>`.**');
  L.push('Every model below ANSWERED a real request on this machine\'s keys. Models that');
  L.push('returned an error are deliberately absent — a model that will not answer is not');
  L.push('a choice. Re-run the script rather than editing this file: three sessions have');
  L.push('been wrong about model ids from memory, and `lanes.default.js` keeps a');
  L.push('dead-route list for exactly that reason.');
  L.push('');
  L.push('Columns:');
  L.push('');
  L.push('- **tools** — does it EMIT a tool call. This is the agentic gate: a build engine');
  L.push('  writes files through tools, so `no-call` cannot drive a build however good its');
  L.push('  prose is.');
  L.push('- **10k** — does it accept a ~10.7k-token request. That is DeepSeek Harness\'s');
  L.push('  measured fixed overhead (system prompt + tool definitions) before any task');
  L.push('  text, so a `413` here means the model cannot host dsh at all.');
  L.push('- **$/M** — prompt price per million tokens, and only where the provider actually');
  L.push('  publishes one. `unpriced` means the API discloses no price, NOT that it is');
  L.push('  free; a 200 on an unpriced route means it costs nothing extra on this key today.');
  L.push('');

  const order = ['mistral', 'nvidia', 'nim', 'opencode', 'b.ai', 'groq', 'cerebras', 'openrouter', 'google'];
  const names = [...byProvider.keys()].sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  for (const name of names) {
    const list = byProvider.get(name);
    const agenticCount = list.filter((r) => r.tools === 'YES' && r.bigctx === 'yes').length;
    L.push('## ' + name);
    L.push('');
    L.push(list.length + ' usable, of which **' + agenticCount + '** can host an agentic build engine.');
    L.push('');
    L.push('| model | tools | 10k | $/M prompt |');
    L.push('|---|---|---|---|');
    // Agentic-capable first — that is the column that decides a build engine.
    list.sort((a, b) => {
      const ra = (a.tools === 'YES' ? 0 : 1) + (a.bigctx === 'yes' ? 0 : 1);
      const rb = (b.tools === 'YES' ? 0 : 1) + (b.bigctx === 'yes' ? 0 : 1);
      return ra - rb || a.id.localeCompare(b.id);
    });
    for (const r of list) {
      const price = r.price === null ? 'unpriced' : (r.price === 0 ? '**free**' : '$' + r.price.toFixed(3));
      L.push('| `' + r.id + '` | ' + (r.tools === 'YES' ? '**yes**' : r.tools)
        + ' | ' + (r.bigctx === 'yes' ? 'yes' : r.bigctx) + ' | ' + price + ' |');
    }
    L.push('');
  }

  const best = rows.filter((r) => r.tools === 'YES' && r.bigctx === 'yes');
  L.push('## Can host a build engine');
  L.push('');
  L.push('Passed all three gates — answers, emits tool calls, accepts a ~10.7k request.');
  L.push('');
  L.push('| provider | model | $/M prompt |');
  L.push('|---|---|---|');
  for (const r of best) {
    const price = r.price === null ? 'unpriced' : (r.price === 0 ? '**free**' : '$' + r.price.toFixed(3));
    L.push('| ' + r.provider + ' | `' + r.id + '` | ' + price + ' |');
  }
  L.push('');

  fs.writeFileSync(outPath, L.join('\n') + '\n');
  console.log('\nwrote ' + outPath + ' — ' + rows.length + ' usable models, '
    + best.length + ' agentic-capable');
}

async function main() {
  const argv = process.argv.slice(2);
  let only = null;
  let top = 12;
  let agenticOnly = false;
  let markdown = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--provider') { only = String(argv[++i] || ''); continue; }
    if (argv[i] === '--top') { top = Number(argv[++i]); continue; }
    if (argv[i] === '--all') { top = Infinity; continue; }
    if (argv[i] === '--markdown') { markdown = String(argv[++i] || ''); continue; }
    if (argv[i] === '--agentic-only') { agenticOnly = true; continue; }
    console.error('unknown argument: ' + argv[i]
      + '  (--provider N | --top N | --all | --markdown PATH | --agentic-only)');
    process.exit(2);
  }

  const agentic = [];
  const rows = [];   // every tested model, for the markdown report
  for (const p of PROVIDERS) {
    if (only && p.name !== only) continue;
    const key = process.env[p.env];
    console.log('\n================================ ' + p.name.toUpperCase()
      + '  (' + p.env + ') ================================');
    if (!key) { console.log('  key not set — skipped'); continue; }

    const listed = await listModels(p, key);
    if (listed.error) { console.log('  /models -> ' + listed.error); continue; }

    const usable = listed.ids.filter((id) => !NOT_A_BUILD_MODEL.test(id));
    console.log('  advertises ' + listed.ids.length + ' models, ' + usable.length
      + ' plausibly text/build models. Testing the top ' + Math.min(top, usable.length) + ' by ranking.');

    // OpenRouter publishes pricing; nobody else here does. Only record a price
    // when the response ACTUALLY carries one.
    //
    // The first version of this did `Number(pricing.prompt || 0)`, which turned
    // "this provider publishes no pricing" into "$0" and printed **FREE** beside
    // every Mistral model. That is a fabricated claim about money, and the same
    // class of defect as the rest of this session: a missing value silently
    // becoming a confident answer. Absent pricing now reads `?`.
    const priceOf = new Map();
    for (const m of (listed.raw || [])) {
      const raw = m && m.pricing && m.pricing.prompt;
      if (raw === undefined || raw === null || raw === '') continue;
      const n = Number(raw);
      if (Number.isFinite(n)) priceOf.set(m.id, n * 1e6);
    }

    const ranked = usable.slice().sort((a, b) => score(b) - score(a));
    const picks = top === Infinity ? ranked : ranked.slice(0, top);
    console.log('');
    const priceCol = priceOf.size ? '$/M'.padEnd(9) : '';
    console.log('  ' + 'model'.padEnd(46) + 'chat'.padEnd(7) + 'tools'.padEnd(9)
      + '10k'.padEnd(7) + priceCol + 'note');
    for (const id of picks) {
      const r = await testModel(p, key, id);
      const price = priceOf.size
        ? (priceOf.has(id)
            ? (priceOf.get(id) === 0 ? 'FREE' : '$' + priceOf.get(id).toFixed(3))
            : 'unpriced').padEnd(9)
        : '';
      console.log('  ' + id.slice(0, 45).padEnd(46) + String(r.chat).padEnd(7)
        + String(r.tools).padEnd(9) + String(r.bigctx).padEnd(7) + price + r.note);
      if (r.chat === 'yes' && r.tools === 'YES' && r.bigctx === 'yes') {
        agentic.push({ provider: p.name, id: id, price: priceOf.has(id) ? priceOf.get(id) : null });
      }
      // Only USABLE models reach the report. A model that will not answer is not
      // a choice the operator has, so listing it is noise — the failure detail
      // stays on stdout above for whoever is debugging a specific id.
      if (r.chat === 'yes') {
        rows.push({
          provider: p.name,
          id: id,
          tools: r.tools,
          bigctx: r.bigctx,
          price: priceOf.has(id) ? priceOf.get(id) : null,
        });
      }
    }
  }

  console.log('\n\n================================ AGENTIC-CAPABLE ON THIS MACHINE ================================');
  console.log('Passed all three: answers chat, EMITS TOOL CALLS, and accepts a ~10.7k-token request.');
  console.log('These are the models that can host DeepSeek Harness as a build engine.\n');
  if (!agentic.length) {
    console.log('  none — see the notes column above for why each candidate failed');
  } else {
    for (const a of agentic) {
      console.log('  ' + a.provider.padEnd(12) + a.id.padEnd(46)
        + (a.price === null ? 'price not published by this API — a 200 here means it costs'
            + ' nothing extra on THIS key today, which is not the same as free'
          : a.price === 0 ? 'FREE (published $0)' : '$' + a.price.toFixed(3) + '/M prompt'));
    }
  }
  if (markdown) writeMarkdown(markdown, rows);
  if (agenticOnly) return;
  console.log('\nReminders that are measured, not assumed:');
  console.log('  * "FREE" on OpenRouter still means a SHARED upstream pool. z-ai/glm-5.2:free');
  console.log('    measured 2/10 success in a sequential burst, retry-after 5 — unusable for a');
  console.log('    multi-turn agentic build even though single calls succeed.');
  console.log('  * A 402 means the account is unbilled, so those models are not free HERE');
  console.log('    regardless of the vendor pricing page.');
  console.log('  * lanes.default.js keeps a dead-route list. Anything failing above belongs in it.');
}

main().catch((err) => {
  console.error('audit-providers failed: ' + String((err && err.stack) || err));
  process.exit(1);
});
