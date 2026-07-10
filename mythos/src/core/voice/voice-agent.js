'use strict';

// voice-agent.js — the voice tool-calling brain. CA of NOVA
// app/lib/voice/voice-agent.js: persona + tool catalog + history ->
// {say, actions, needs_result} JSON -> execute -> needs_result re-prompt loop
// (max 4) -> one corrective pass when a single-iteration turn had failed
// actions. NEVER throws regardless of model output.
//
// MYTHOS adaptations vs NOVA:
// - Model calls go through brain.think({lane:'voice'}) — provider chain,
//   persona injection, and spend tracking already live there.
// - Danger gating is the LEASH (tiered autonomy), not a local danger flag:
//   every action runs leash.check() first; requireConfirm creates a pending
//   confirm (scoped to this WS connection) and emits 'confirm-request' on the
//   bus — the existing confirm modal + handleConfirmReply dispatch path takes
//   it from there. The catalog's danger flags below exist only to make the
//   model cautious (NOVA's DANGER TOOLS RULE), the leash enforces regardless.
// - Execution goes through the caller-injected dispatch() (server/index.js's
//   dispatchAction: breaker -> effectors.invoke -> episodic -> action.completed).
//
// TRANSPORT-AGNOSTIC + STATELESS PER CALL, same as NOVA: the caller owns
// conversation history and passes it via ctx.history.

const MAX_ITERATIONS = Number(process.env.VOICE_MAX_TOOL_ITERATIONS) || 4;
const MAX_SAY_CHARS = 400;

// Voice-safe subset of the registered effector tools (P7 from-dashboard.js +
// from-project.js). danger mirrors the leash tier table (tier >= 3 -> true).
const CATALOG = [
  { name: 'navigate', description: 'Open a dashboard panel. route is one of: goals, kanban, pipeline, memory, health, audit.', params: { route: 'string' }, danger: false },
  { name: 'read_status', description: 'Read overall entity status (health, goals, jobs).', params: {}, danger: false },
  { name: 'job_status', description: 'Status of build jobs. Pass jobId for one job, omit for the latest. Result includes the artifact path when done.', params: { jobId: 'string (optional)' }, danger: false },
  { name: 'open_artifact', description: 'Open a built artifact (a file under vault/builds) in the browser so the human can see it.', params: { path: 'string', title: 'string (optional)' }, danger: false },
  { name: 'create_goal', description: 'Create a goal.', params: { text: 'string', category: 'string (optional)' }, danger: false },
  { name: 'list_goals', description: 'List goals.', params: {}, danger: false },
  { name: 'toggle_goal', description: 'Toggle a goal done/active by fuzzy text match.', params: { query: 'string' }, danger: false },
  { name: 'delete_goal', description: 'Delete a goal by fuzzy text match. Destructive.', params: { query: 'string' }, danger: true },
  { name: 'capture_idea', description: 'Capture an idea into the pipeline inbox.', params: { text: 'string' }, danger: false },
  { name: 'pipeline_status', description: 'List pipeline cards by stage.', params: {}, danger: false },
  { name: 'pipeline_advance', description: 'Approve or reject a pipeline card.', params: { query: 'string', action: "'approve' | 'reject'" }, danger: false },
  { name: 'pipeline_execute', description: 'Run the build agent on a pipeline card in the Execute stage.', params: { query: 'string' }, danger: true },
  { name: 'kanban_status', description: 'List kanban cards by lane.', params: {}, danger: false },
  { name: 'kanban_add_card', description: 'Add a kanban card.', params: { title: 'string', lane: 'string (optional)' }, danger: false },
  { name: 'kanban_move_card', description: 'Move a kanban card to a lane.', params: { query: 'string', lane: 'string' }, danger: false },
  { name: 'kanban_assemble', description: 'Run the planner agent to break a goal into kanban cards.', params: { goal: 'string' }, danger: true },
  { name: 'kanban_build_card', description: 'Run the builder agent on a kanban card, producing a deliverable.', params: { query: 'string' }, danger: true },
  { name: 'ask_agent', description: 'Ask an internal agent seat a question.', params: { seat: 'string', prompt: 'string' }, danger: false },
  { name: 'start_project', description: 'Start building ONE deliverable the user has confirmed (a single page/app/document). Call ONLY after: (1) you asked clarifying questions, (2) you restated the plan in one sentence, (3) the user explicitly said to proceed in a LATER turn. Pass the complete spec including all clarifying answers as description.', params: { description: 'string - complete build specification' }, danger: false },
  { name: 'run_mission', description: 'Delegate a MULTI-PART goal (several pages, a brand kit, a suite of deliverables) to a background agent team: a planner splits it into tasks and builder agents work them in parallel. Same intake rule as start_project: clarify, restate, and call ONLY after an explicit go-ahead in a later turn.', params: { goal: 'string - the complete multi-part goal with all details' }, danger: false },
  { name: 'mission_status', description: 'Progress of the background agent team: how many agents done, artifacts, summary. Omit missionId for the latest mission.', params: { missionId: 'string (optional)' }, danger: false },
  { name: 'get_time', description: "Current date and time. Pass timezone (IANA, e.g. 'America/New_York') for a specific place, omit for local system time.", params: { timezone: 'string (optional)' }, danger: false },
  { name: 'get_weather', description: 'Current weather conditions. Pass location (a city name) to check elsewhere, omit for the configured default location.', params: { location: 'string (optional)' }, danger: false },
];

// ---- prompt construction (DANGER TOOLS RULE + PROJECT INTAKE RULE are CA
// from NOVA — the danger rule was validated by NOVA's day-one spike: without
// it, 25% false-danger-invocation on ambiguous utterances; with it, 0%). ----

const RULES = `You are terse: your spoken reply ("say") is at most two short sentences, spoken PLAINLY — no markdown, no asterisks, no bullet lists, no headers. You never invent tools.

DANGER TOOLS RULE (safety-critical, read carefully): each tool below is marked "danger": true or "danger": false. For a danger:true tool, you may ONLY put it in "actions" if the utterance itself clearly and specifically names the target (an exact goal/card/file described in THIS utterance, or an explicit direct confirmation like "yes, delete it" replying to a question YOU just asked in this same turn). If the utterance is vague about WHAT to act on (words like "it", "that", "this", "the thing") and nothing concrete is named anywhere else in this turn, that is NOT authorization: you MUST put "actions": [] and instead ask a short clarifying question in "say". Never put a danger:true tool call in "actions" as a placeholder while you ask a clarifying question — asking a question and queuing the dangerous action in the same turn is always wrong. When genuinely unsure, prefer actions: [] and ask.

PROJECT INTAKE RULE: when the user asks you to build/make/create something open-ended (a game, a landing page, an app), do NOT start immediately. Ask exactly ONE focused clarifying question per turn (respond with say and empty actions). When you have enough detail (2-3 answers is usually enough), restate the plan in one sentence and ask for an explicit go-ahead. Call start_project ONLY after the user clearly says to proceed in a later turn, with the full accumulated spec as description. Never call start_project on the same turn you first proposed the plan.

INFORMATIONAL TOOLS RULE: danger:false read-only lookups (read_status, list_goals, job_status, pipeline_status, kanban_status, mission_status, get_time, get_weather, etc.) are never build/create requests and never need the PROJECT INTAKE RULE's clarify-first dance — call them in the SAME turn the user asks, even with no arguments (all their params are optional or have sensible defaults). Only ask first when the utterance is genuinely ambiguous about which optional argument to use AND the answer would change the result the user actually wants (e.g. they said "the weather" while mid-conversation about two different cities). Simply not having every optional argument filled in is never a reason to ask instead of calling the tool.`;

const OUTPUT_CONTRACT = `Respond with ONLY a single JSON object, no markdown fence, no commentary, matching exactly:
{"say": "<= 2 short spoken sentences", "actions": [{"tool": "<tool name>", "args": {}}], "needs_result": false}
If you have nothing to do, or you are asking a clarifying question, "actions" MUST be [].
Set "needs_result": true only when you need the result of an action (e.g. a job status or list) before you can give a final spoken answer.`;

function toolCatalogJson() {
  return JSON.stringify(CATALOG);
}

function buildPrompt({ text, history, toolResults, corrective, originalSay }) {
  const parts = [
    RULES,
    '',
    `TOOLS: ${toolCatalogJson()}`,
  ];
  if (history && history.length) {
    parts.push('', 'RECENT EXCHANGES:');
    for (const h of history) {
      parts.push(`${h.role === 'user' ? 'User' : 'You'}: ${h.content}`);
    }
  }
  if (corrective) {
    parts.push('', 'CORRECTIVE PASS: your previous spoken reply (' + JSON.stringify(originalSay) + ') was WRONG because the tool calls in that same turn FAILED. Look at TOOL RESULTS, admit what actually happened in exactly one short sentence, and do NOT call any tools again.');
  }
  parts.push('', OUTPUT_CONTRACT, '', `USER SAID: "${text}"`);
  if (toolResults) {
    parts.push('', `TOOL RESULTS: ${JSON.stringify(toolResults)}`);
  }
  return parts.join('\n');
}

// ---- parsing (brain.think's parsed field -> repair retry -> degrade) ----

function stripThink(raw) {
  return String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
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

function createVoiceAgent({ brain, leash, dispatch, bus }) {
  if (!brain || typeof brain.think !== 'function') throw new Error('createVoiceAgent requires brain.think');
  if (!leash || typeof leash.check !== 'function') throw new Error('createVoiceAgent requires leash');
  if (typeof dispatch !== 'function') throw new Error('createVoiceAgent requires dispatch(decision, ctx)');
  if (!bus) throw new Error('createVoiceAgent requires bus');

  async function callModel(prompt, { signal } = {}) {
    const result = await brain.think({
      lane: 'voice',
      messages: [{ role: 'user', content: prompt }],
      source: 'voice-agent',
      signal,
    });
    return result; // { content, parsed, offline, ... }
  }

  // brain.think already runs tryParseWithRepair on content; one explicit repair
  // retry on top, then degrade to { say: rawText, actions: [] } — never throws.
  async function callAndParse(prompt, { signal } = {}) {
    const first = await callModel(prompt, { signal });
    if (first.offline) return { say: 'All my thinking providers are offline right now.', actions: [], needs_result: false, offline: true };
    const parsed = normalizeParsed(first.parsed);
    if (parsed) return parsed;

    const repairPrompt = `${prompt}\n\nYour previous reply was not valid JSON matching the schema. Reply with ONLY valid JSON matching the schema, nothing else. Your previous reply was:\n${first.content}`;
    const second = await callModel(repairPrompt, { signal });
    const reparsed = normalizeParsed(second.parsed);
    if (reparsed) return reparsed;

    const fallbackText = stripThink(second.content) || stripThink(first.content) || "I couldn't process that.";
    return { say: fallbackText.slice(0, MAX_SAY_CHARS), actions: [], needs_result: false };
  }

  // ---- execution: leash gate first, then the server's dispatch path ----

  const KNOWN = new Set(CATALOG.map((t) => t.name));

  // Tools whose human gate is the PROJECT INTAKE RULE conversation itself
  // (clarify -> restate -> explicit go-ahead in a later turn). NOVA's
  // tools-project.js documents the rationale: the conversational go-ahead IS
  // the human-gate approval, so a confirm modal here would be a redundant
  // second confirmation. The confirm is still created AND accepted through
  // the leash registry so the audit trail records a proper two-step, scoped
  // to this connection — never a silent bypass.
  const INTAKE_GATED = new Set(['start_project', 'run_mission']);

  async function executeAction(action, { connectionId } = {}) {
    if (!KNOWN.has(action.tool)) {
      return { tool: action.tool, args: action.args, ok: false, summary: `Unknown tool "${action.tool}".` };
    }
    const decision = { tool: action.tool, args: action.args || {} };
    const verdict = leash.check(decision, {});

    if (verdict.requireConfirm && !INTAKE_GATED.has(decision.tool)) {
      const summary = `Voice: ${decision.tool}${Object.keys(decision.args).length ? ` (${JSON.stringify(decision.args)})` : ''}`;
      const confirmId = leash.confirm.create(summary, { decision, goalId: null, tier: verdict.tier }, connectionId || 'system');
      bus.emit('confirm-request', { ...decision, confirmId, summary, tier: verdict.tier });
      return { tool: decision.tool, args: decision.args, ok: false, confirmPending: true, confirmId, summary };
    }
    if (verdict.requireConfirm) {
      // Intake-gated: consume a real confirm cycle on the spot (audited),
      // attributed to the voice go-ahead, then fall through to dispatch.
      const summary = `Voice intake go-ahead: ${decision.tool}`;
      const confirmId = leash.confirm.create(summary, { decision, goalId: null, tier: verdict.tier }, connectionId || 'system');
      leash.confirm.accept(confirmId, connectionId || 'system');
    } else if (!verdict.allow) {
      return { tool: decision.tool, args: decision.args, ok: false, summary: `Denied: ${verdict.reason}.` };
    }

    const outcome = await dispatch(decision, { tier: verdict.tier });
    const ok = Boolean(outcome && outcome.ok);
    const raw = outcome && outcome.result;
    return {
      tool: decision.tool,
      args: decision.args,
      ok,
      summary: ok ? `${decision.tool} done.` : String((raw && raw.error) || raw || 'Failed.').slice(0, 200),
      raw: outcome,
    };
  }

  // ---- main loop (CA of NOVA handleUtterance) ----

  async function handleUtterance({ text, ctx = {}, signal, onAction } = {}) {
    const executedActions = [];
    let toolResults = null;
    let iterations = 0;
    let finalSay = '';
    let confirmPending = null;
    let didRetry = false;

    for (;;) {
      if (signal && signal.aborted) {
        return { say: finalSay, actions: executedActions, aborted: true };
      }

      iterations += 1;
      const prompt = buildPrompt({ text, history: ctx.history, toolResults });
      const parsed = await callAndParse(prompt, { signal });
      finalSay = parsed.say;
      if (parsed.offline) return { say: finalSay, actions: [], offline: true };

      executedActions.length = 0;
      for (const action of parsed.actions) {
        if (signal && signal.aborted) {
          return { say: finalSay, actions: executedActions, aborted: true };
        }
        const result = await executeAction(action, { connectionId: ctx.connectionId });
        executedActions.push(result);
        if (onAction) onAction(result);
        if (result.confirmPending) {
          confirmPending = result;
          break; // stop the turn on a confirm-gated action
        }
      }

      if (confirmPending) break;
      if (!parsed.needs_result) break;
      if (iterations >= MAX_ITERATIONS) break;

      toolResults = executedActions.map((a) => ({ tool: a.tool, ok: a.ok, summary: a.summary, result: a.raw && a.raw.result }));
    }

    // One corrective pass: don't let the model claim success over failed tools.
    if (!didRetry && iterations === 1 && executedActions.some((a) => a && a.ok === false && !a.confirmPending)) {
      didRetry = true;
      const correctivePrompt = buildPrompt({
        text,
        history: ctx.history,
        toolResults: executedActions.map((a) => ({ tool: a.tool, ok: a.ok, summary: a.summary })),
        corrective: true,
        originalSay: finalSay,
      });
      const corrective = await callAndParse(correctivePrompt, { signal });
      finalSay = corrective.say;
    }

    return { say: finalSay, actions: executedActions, confirmPending: confirmPending || null };
  }

  return { handleUtterance };
}

module.exports = {
  createVoiceAgent,
  CATALOG,
  MAX_ITERATIONS,
  _internal: { buildPrompt, normalizeParsed, stripThink },
};
