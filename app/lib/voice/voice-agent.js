// voice-agent.js — the voice brain. handleUtterance({ text, ctx, signal }) -> { say, actions[] }.
//
// TRANSPORT-AGNOSTIC BY DESIGN: this file has zero references to WS/reqId/sockets. `ctx` is a
// plain object the caller owns and passes in — server.js's WS wiring (item #4) is the only
// place that knows about connections, reqIds, or the `inFlight` AbortController map. This is
// provable by voice-agent.test.js calling handleUtterance directly with a plain object.
//
// STATE OWNERSHIP: voice-agent.js itself is stateless per call — it does not keep a module-level
// per-connection history Map. The caller (WS wiring) owns conversation history and passes it in
// via `ctx.history` (an array of { role, content } the caller mutates/persists as it sees fit,
// capped by the caller to ~6 exchanges per the spec). This keeps voice-agent.js trivially
// testable with a plain object and avoids this module silently leaking memory per WS connection
// if the caller forgets to clean up — the caller already owns that lifecycle via `inFlight`.
//
// Runs the JSON tool-calling loop against Ollama (via providers/ollama.js — reused, not
// reimplemented). Parse path: fence-strip -> JSON.parse -> one repair retry -> degrade to
// { say: rawText, actions: [] }. NEVER throws regardless of model output.
//
// Danger-tier tools (danger:true) are never executed directly: they go through confirm.js
// and the call returns early with a confirm-pending result instead.

const chain = require('../models/chain');
const confirm = require('./confirm');
const dashboardTools = require('./tools-dashboard');
const computerTools = require('./tools-computer');
const pcTools = require('./tools-pc');
const browserTools = require('./tools-browser');

const MAX_ITERATIONS = Number(process.env.VOICE_MAX_TOOL_ITERATIONS) || 4;
const MAX_SAY_CHARS = 400; // hard backstop; tts.js does the real sentence-boundary truncation to ~350

// Set by callModel() after every successful chain.complete() call — the best-first NIM/Ollama
// fallback chain (lib/models/chain.js) picks a different model per turn depending on live
// availability, so unlike a single fixed model this is only known after the fact. Read by
// server.js to report "which model actually answered" in the voice-done message.
let lastModelUsed = null;
function getLastModelUsed() {
  return lastModelUsed;
}

// Merge both catalogs into one lookup by tool name -> { name, description, params, danger, fn }.
const TOOL_REGISTRY = new Map();
for (const t of [...dashboardTools.TOOLS, ...computerTools.TOOLS, ...pcTools.TOOLS, ...browserTools.TOOLS]) {
  TOOL_REGISTRY.set(t.name, t);
}

// ---- prompt construction ----

// The single most load-bearing sentence in this prompt, validated by the day-one spike
// (scripts/voice-spike/RESULTS.md): a danger:true tool must never be queued in `actions`
// as a placeholder while the model asks a clarifying question in the same turn. The spike's
// initial prompt (without this rule) produced a 25% false-danger-invocation rate on
// deliberately ambiguous utterances ("get rid of it"); adding this rule brought it to 0%
// across repeated trials. Do not weaken or remove this paragraph without re-running the spike.
const PERSONA = `You are the voice brain of Agent OS, a local dashboard. You interpret one spoken utterance at a time and decide what to do using ONLY the tools listed below. You are terse: your spoken reply ("say") is at most two short sentences. You never invent tools.

DANGER TOOLS RULE (safety-critical, read carefully): each tool below is marked "danger": true or "danger": false. For a danger:true tool, you may ONLY put it in "actions" if the utterance itself clearly and specifically names the target (an exact goal/card/file/session described in THIS utterance, or an explicit direct confirmation like "yes, delete it" replying to a question YOU just asked in this same turn). If the utterance is vague about WHAT to act on (words like "it", "that", "this", "the thing") and nothing concrete is named anywhere else in this turn, that is NOT authorization: you MUST put "actions": [] and instead ask a short clarifying question in "say". Never put a danger:true tool call in "actions" as a placeholder while you ask a clarifying question — asking a question and queuing the dangerous action in the same turn is always wrong. When genuinely unsure, prefer actions: [] and ask.`;

const OUTPUT_CONTRACT = `Respond with ONLY a single JSON object, no markdown fence, no commentary, matching exactly:
{"say": "<= 2 short spoken sentences", "actions": [{"tool": "<tool name>", "args": {}}], "needs_result": false}
If you have nothing to do, or you are asking a clarifying question, "actions" MUST be [].
Set "needs_result": true only when you need the result of an action (e.g. a folder listing or file contents) before you can give a final spoken answer.`;

function toolCatalogJson() {
  return JSON.stringify(
    [...TOOL_REGISTRY.values()].map((t) => ({ name: t.name, description: t.description, params: t.params, danger: t.danger }))
  );
}

function buildPrompt({ text, ctx, history, toolResults }) {
  const parts = [
    PERSONA,
    '',
    `TOOLS: ${toolCatalogJson()}`,
    '',
    `DASHBOARD CONTEXT: ${JSON.stringify((ctx && ctx.dashboard) || {})}`,
  ];
  if (history && history.length) {
    parts.push('', 'RECENT EXCHANGES:');
    for (const h of history) {
      parts.push(`${h.role === 'user' ? 'User' : 'You'}: ${h.content}`);
    }
  }
  parts.push('', OUTPUT_CONTRACT, '', `USER SAID: "${text}"`);
  if (toolResults) {
    parts.push('', `TOOL RESULTS: ${JSON.stringify(toolResults)}`);
  }
  return parts.join('\n');
}

// ---- parsing (fence-strip -> JSON.parse -> repair retry -> degrade) ----

function stripThink(raw) {
  return String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function stripFence(raw) {
  const fence = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  return (fence ? fence[1] : raw).trim();
}

function normalizeParsed(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const say = typeof parsed.say === 'string' ? parsed.say.slice(0, MAX_SAY_CHARS) : '';
  const actions = Array.isArray(parsed.actions)
    ? parsed.actions.filter((a) => a && typeof a.tool === 'string').map((a) => ({ tool: a.tool, args: a.args || {} }))
    : [];
  const needs_result = Boolean(parsed.needs_result);
  return { say, actions, needs_result };
}

function tryParse(raw) {
  const visible = stripThink(raw);
  const stripped = stripFence(visible);
  try {
    const parsed = JSON.parse(stripped);
    return normalizeParsed(parsed);
  } catch {
    return null;
  }
}

// ---- Ollama call (reuses providers/ollama.js — no reimplemented HTTP) ----

async function callModel(prompt, { signal } = {}) {
  // Non-streaming from voice-agent's perspective: neither branch of chain.complete() wires
  // onToken, so the caller only gets the fully-collected string back once the winning
  // provider's stream finishes — required because the JSON output must be parsed whole,
  // never token-by-token.
  const { content, provider, model } = await chain.complete({
    messages: [{ role: 'user', content: prompt }],
    kind: 'json',
    signal,
  });
  lastModelUsed = `${provider}:${model}`;
  return content;
}

// One repair retry: ask the model to reply with ONLY valid JSON. On a second failure,
// degrade to { say: rawText, actions: [] } — never throws.
async function callAndParse(prompt, { signal } = {}) {
  const raw = await callModel(prompt, { signal });
  const parsed = tryParse(raw);
  if (parsed) return parsed;

  const repairPrompt = `${prompt}\n\nYour previous reply was not valid JSON matching the schema. Reply with ONLY valid JSON matching the schema, nothing else. Your previous reply was:\n${raw}`;
  const repaired = await callModel(repairPrompt, { signal });
  const reparsed = tryParse(repaired);
  if (reparsed) return reparsed;

  // Degrade: never crash regardless of model output. Prefer the second (repaired) raw text
  // if non-empty, else the first — both are honest "the model said this" fallbacks.
  const fallbackText = stripThink(repaired) || stripThink(raw) || "I couldn't process that.";
  return { say: fallbackText.slice(0, MAX_SAY_CHARS), actions: [], needs_result: false };
}

// ---- tool execution ----

async function executeAction(action, { ctx }) {
  const tool = TOOL_REGISTRY.get(action.tool);
  if (!tool) {
    return { tool: action.tool, args: action.args, ok: false, summary: `Unknown tool "${action.tool}".` };
  }

  // Per-invocation danger override (e.g. pipeline_advance's reject action is danger:true
  // even though the tool itself defaults to false) — see tools-dashboard.js's dangerWhen.
  const isDanger = tool.danger || (typeof tool.dangerWhen === 'function' && tool.dangerWhen(action.args));

  if (isDanger) {
    const summary = `Confirm: ${tool.name}${action.args && Object.keys(action.args).length ? ` (${JSON.stringify(action.args)})` : ''}`;
    // connectionId (from ctx, set by server.js per WS connection) scopes this confirm so
    // only the connection that triggered it can accept/reject it — see confirm.js.
    const confirmId = confirm.create(summary, { tool: tool.name, args: action.args }, ctx && ctx.connectionId != null ? ctx.connectionId : null);
    return { tool: tool.name, args: action.args, ok: false, confirmPending: true, confirmId, summary };
  }

  try {
    const result = await tool.fn(action.args || {}, ctx);
    const summary = result && result.ok
      ? summarizeResult(tool.name, result.result)
      : (result && result.result) || 'Failed.';
    return {
      tool: tool.name,
      args: action.args,
      ok: Boolean(result && result.ok),
      summary,
      uiActions: (result && result.uiActions) || [],
      needsResult: Boolean(result && result.needs_result),
      raw: result,
    };
  } catch (err) {
    // Tool functions are contracted to never throw, but this is the final backstop.
    return { tool: tool.name, args: action.args, ok: false, summary: err.message };
  }
}

function summarizeResult(toolName, result) {
  if (!result) return `${toolName} done.`;
  if (toolName === 'navigate') return `Navigating to ${result.route}.`;
  return `${toolName} done.`;
}

// Executes a confirmed (previously danger-gated) action directly, bypassing the confirm gate
// since the human has already accepted. Used by the WS 'voice-confirm-reply' handler.
async function executeConfirmedAction(action, { ctx } = {}) {
  const tool = TOOL_REGISTRY.get(action.tool);
  if (!tool) {
    return { tool: action.tool, args: action.args, ok: false, summary: `Unknown tool "${action.tool}".` };
  }
  try {
    const result = await tool.fn(action.args || {}, ctx);
    const summary = result && result.ok ? summarizeResult(tool.name, result.result) : (result && result.result) || 'Failed.';
    return {
      tool: tool.name,
      args: action.args,
      ok: Boolean(result && result.ok),
      summary,
      uiActions: (result && result.uiActions) || [],
      needsResult: Boolean(result && result.needs_result),
      raw: result,
    };
  } catch (err) {
    return { tool: tool.name, args: action.args, ok: false, summary: err.message };
  }
}

// ---- main loop ----

// handleUtterance({ text, ctx, signal, onAction }) -> { say, actions: [executed action results] }
// `ctx` is a plain object: { dashboard: {...}, history: [{role,content}, ...] }. Both fields
// are optional; missing fields degrade gracefully rather than throwing.
// `onAction(actionResult)` is an optional callback invoked synchronously after each tool
// executes (or is confirm-gated) — this is how the WS wiring (item #4) emits `voice-action` /
// `voice-confirm` per action without voice-agent.js knowing anything about WS messages.
async function handleUtterance({ text, ctx = {}, signal, onAction } = {}) {
  const executedActions = [];
  let toolResults = null;
  let iterations = 0;
  let finalSay = '';
  let confirmPending = null;

  for (;;) {
    if (signal && signal.aborted) {
      return { say: finalSay, actions: executedActions, aborted: true };
    }

    iterations += 1;
    const prompt = buildPrompt({ text, ctx, history: ctx.history, toolResults });
    const parsed = await callAndParse(prompt, { signal });
    finalSay = parsed.say;

    for (const action of parsed.actions) {
      if (signal && signal.aborted) {
        return { say: finalSay, actions: executedActions, aborted: true };
      }
      const result = await executeAction(action, { ctx });
      executedActions.push(result);
      if (onAction) onAction(result);
      if (result.confirmPending) {
        confirmPending = result;
        break; // per spec: stop the turn on a danger-gated action
      }
    }

    if (confirmPending) break;
    if (!parsed.needs_result) break;
    if (iterations >= MAX_ITERATIONS) break;

    toolResults = executedActions.map((a) => ({ tool: a.tool, ok: a.ok, summary: a.summary, result: a.raw && a.raw.result }));
  }

  return { say: finalSay, actions: executedActions, confirmPending: confirmPending || null };
}

// ---- availability probe ----

// Never throws — returns false honestly when every lane of the model chain is unreachable.
async function isAvailable() {
  try {
    return await chain.isAvailable();
  } catch {
    return false;
  }
}

module.exports = {
  handleUtterance,
  executeConfirmedAction,
  isAvailable,
  getLastModelUsed,
  TOOL_REGISTRY,
  MAX_ITERATIONS,
  // exported for testing internals
  _internal: { tryParse, buildPrompt, stripThink, stripFence },
};
