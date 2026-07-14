'use strict';

// F3: Import tierOf to compute danger flags dynamically from the tier table.
const { tierOf } = require('../leash/tiers');

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
const MAX_SAY_CHARS = Number(process.env.VOICE_MAX_SAY_CHARS) || 800;

// Voice-safe subset of the registered effector tools (P7 from-dashboard.js +
// from-project.js). F3: danger is now computed dynamically from tierOf() at
// buildPrompt time to prevent drift between the voice catalog and the tier table.
const CATALOG_RAW = [
  { name: 'navigate', description: 'Open a dashboard panel. route is one of: goals, kanban, pipeline, memory, health, audit.', params: { route: 'string' }, danger: false },
  { name: 'close_panel', description: 'Close dashboard panel(s). Pass all:true to close all open panels, omit to close just the top panel.', params: { all: 'boolean (optional)' }, danger: false },
  { name: 'read_status', description: 'Read overall entity status (health, goals, jobs).', params: {}, danger: false },
  { name: 'job_status', description: 'Status of build jobs. Pass jobId for one job, omit for the latest. Result includes the artifact path when done.', params: { jobId: 'string (optional)' }, danger: false },
  { name: 'open_artifact', description: 'Open a built artifact (a file under vault/builds) in the browser so the human can see it.', params: { path: 'string', title: 'string (optional)' }, danger: false },
  { name: 'delete_artifact', description: 'Permanently delete a built artifact (file + pipeline card) by matching its title or name. Destructive.', params: { query: 'string - artifact title or name' }, danger: true },
  { name: 'create_goal', description: 'Create a goal.', params: { text: 'string', category: 'string (optional)' }, danger: false },
  { name: 'list_goals', description: 'List goals.', params: {}, danger: false },
  { name: 'toggle_goal', description: 'Toggle a goal done/active by fuzzy text match.', params: { query: 'string' }, danger: false },
  { name: 'delete_goal', description: 'Delete a goal by fuzzy text match. Destructive.', params: { query: 'string' }, danger: true },
  { name: 'capture_idea', description: 'Capture an idea into the pipeline inbox.', params: { text: 'string', idea: 'string (optional)' }, danger: false },
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
  { name: 'build_project', description: 'Build a multi-file app or website the user has confirmed (several files working together). A file plan is proposed for your approval before anything is generated. Same intake rule as start_project: clarify, restate the plan in one sentence, and call ONLY after an explicit go-ahead in a LATER turn. Pass the complete spec as spec, and kind as "app" or "website".', params: { spec: 'string - complete build specification', kind: '"app" | "website"' }, danger: false },
  { name: 'revise_project', description: 'Apply feedback to a build that is awaiting review or already done — only the affected files are regenerated.', params: { projectId: 'string', feedback: 'string - what to change' }, danger: false },
  { name: 'project_status', description: 'Status of a multi-file build: stage, files done/total, preview URL. Omit projectId for the latest.', params: { projectId: 'string (optional)' }, danger: false },
  { name: 'get_time', description: "Current date and time. Pass timezone (IANA, e.g. 'America/New_York') for a specific place, omit for local system time.", params: { timezone: 'string (optional)' }, danger: false },
  { name: 'get_weather', description: 'Current weather conditions. Pass location (a city name) to check elsewhere, omit for the configured default location.', params: { location: 'string (optional)' }, danger: false },
  { name: 'web_fetch', description: 'Fetch text content from a URL — real internet access. Returns readable text (HTML stripped, truncated). Use for research, news, or real-time data the user asks about.', params: { url: 'string - the http(s) URL' }, danger: false },
  { name: 'web_search', description: 'Search the web for real-time information. Returns titles, URLs, and snippets.', params: { query: 'string', maxResults: 'number (optional)' }, danger: false },
  { name: 'gmail_unread', description: 'List unread Gmail messages. Returns subject, sender, date for each.', params: {}, danger: false },
  { name: 'gmail_read', description: 'Read a specific email by its message ID. Returns full body text.', params: { messageId: 'string' }, danger: false },
  { name: 'gmail_send', description: 'Send an email. Requires to, subject, body. Use for real email sends only after confirming with the user.', params: { to: 'string', subject: 'string', body: 'string' }, danger: true },
  { name: 'gmail_draft', description: 'Create a Gmail draft. Returns the draft ID.', params: { to: 'string', subject: 'string', body: 'string' }, danger: false },
  { name: 'remember', description: 'Save a durable fact/preference/instruction to permanent memory. Use when user says "remember","note that","don\'t forget","from now on","keep in mind". Persists across restarts.', params: { text: 'string' }, danger: false },
  { name: 'log_incident', description: 'Record an error/bug/incident the user flags. Use when user says "log this","this is wrong","you hallucinated".', params: { text: 'string', severity: 'string (optional)' }, danger: false },
  { name: 'reminder_add', description: 'Set a reminder. Time can be relative ("in 10 minutes") or ISO date. Returns reminder ID.', params: { text: 'string', when: 'string' }, danger: false },
  { name: 'reminder_list', description: 'List upcoming pending reminders with times and text.', params: {}, danger: false },
  { name: 'reminder_cancel', description: 'Cancel a pending reminder by ID or text match.', params: { query: 'string' }, danger: false },
];

// F3: Build the runtime catalog with danger flags computed from the tier table.
// This prevents drift — the tier table is the single source of truth for danger.
function buildCatalog() {
  return CATALOG_RAW.map(function(entry) {
    return Object.assign({}, entry, { danger: tierOf(entry.name) >= 3 });
  });
}
const CATALOG = buildCatalog();

// ---- prompt construction (DANGER TOOLS RULE + PROJECT INTAKE RULE are CA
// from NOVA — the danger rule was validated by NOVA's day-one spike: without
// it, 25% false-danger-invocation on ambiguous utterances; with it, 0%). ----

const RULES = `You are MYTHOS, a continuously-aware cognitive entity. You speak naturally, like a trusted advisor thinking out loud. You never invent tools.

BREVITY: Match your reply length to the question. For greetings ("what's up", "hey"), acknowledgments ("thanks", "okay"), and simple factual questions, reply in ONE short sentence — a full stop, not a comma. If the answer fits in 10 words, use 10 words. Reserve longer replies for genuinely complex problems where walking through your reasoning step by step helps the operator follow your logic. Never pad. Never connect independent clauses with commas where periods belong — if you catch yourself doing that, stop and split into separate sentences. Never use markdown, asterisks, bullet lists, or headers when speaking — speak in plain natural sentences.

REASONING: Before acting, reason about what the user actually wants. Consider context from RECENT EXCHANGES and RELEVANT MEMORIES. If you remember something relevant from a past conversation, reference it naturally ("last time you mentioned...").

HONESTY RULE (critical for trust): You can ONLY do what the TOOLS list below allows. If the user asks for something with no tool, NEVER claim you are doing it. However, you CAN record and capture things — use these tools: remember (saves a durable fact/preference/instruction to permanent memory), log_incident (records an error/bug/incident), capture_idea (saves a build idea to the pipeline inbox), create_goal (saves a to-do). NEVER refuse a "log this","remember this","note that","don't forget", or "record this" request — you have remember and log_incident for exactly these. Pick remember for facts/preferences/standing rules, log_incident for errors/bugs/incidents. For other genuinely-missing capabilities (inspect audio buffers, restart pipelines, download files, access the filesystem directly), say plainly: "I don't have a tool to [X]." Fabricating capabilities destroys trust faster than any bug.

ARTIFACT RULE: NEVER fabricate or guess file paths. If the user asks to open/show/view a build or artifact, call pipeline_status (needs_result:true) FIRST to get the real artifact path from the result, THEN call open_artifact with that exact path. Do not invent paths based on the project description — they will be wrong and the user will see a 404 or the wrong page. Same for job_status if the user references a specific job.

DANGER TOOLS RULE (safety-critical, read carefully): each tool below is marked "danger": true or "danger": false. For a danger:true tool, you may ONLY put it in "actions" if the utterance itself clearly and specifically names the target (an exact goal/card/file described in THIS utterance, or an explicit direct confirmation like "yes, delete it" replying to a question YOU just asked in this same turn). If the utterance is vague about WHAT to act on (words like "it", "that", "this", "the thing") and nothing concrete is named anywhere else in this turn, that is NOT authorization: you MUST put "actions": [] and instead ask a clarifying question in "say". Never put a danger:true tool call in "actions" as a placeholder while you ask a clarifying question — asking a question and queuing the dangerous action in the same turn is always wrong. When genuinely unsure, prefer actions: [] and ask.

PROJECT INTAKE RULE: when the user asks you to build/make/create something open-ended (a game, a landing page, an app), do NOT start immediately. Ask ALL your clarifying questions in ONE turn as a short list (2-3 questions max, covering the essentials: what kind, what style, what audience). After the user answers, you may ask at most ONE more round of questions ONLY if an answer is genuinely ambiguous and blocks you from building. NEVER ask a third round of questions — by then you have enough to build. Once you have style/topic/audience, restate the plan in one sentence and ask for an explicit go-ahead. Call start_project ONLY after the user clearly says to proceed in a LATER turn, with the full accumulated spec as description. Never call start_project on the same turn you first proposed the plan.
IDEA SPARRING: you are a creative partner, not a form. When you ask intake questions, ALSO propose — offer 1-2 concrete opinionated suggestions with each round ("I could give it a dark hero section with a live demo embed — want that?"). When the user describes requirements, volunteer one improvement or addition they did not ask for, phrased as an offer ("Shall I also add X?"), never silently included. If the user rejects a suggestion, drop it and do not re-propose it. Suggestions ride along with your questions in the same turn — they never add extra rounds beyond the two the PROJECT INTAKE RULE allows.

INFORMATIONAL TOOLS RULE: danger:false read-only lookups (read_status, list_goals, job_status, pipeline_status, kanban_status, mission_status, get_time, get_weather, etc.) are never build/create requests and never need the PROJECT INTAKE RULE's clarify-first dance — call them in the SAME turn the user asks, even with no arguments (all their params are optional or have sensible defaults). Only ask first when the utterance is genuinely ambiguous about which optional argument to use AND the answer would change the result the user actually wants (e.g. they said "the weather" while mid-conversation about two different cities). Simply not having every optional argument filled in is never a reason to ask instead of calling the tool. If the user says "I don't know" or "I don't care" about an OPTIONAL parameter, that is NOT a reason to abandon the task — call the tool with its default (omit the arg) and proceed with the result. Only abandon if a REQUIRED parameter is missing and the user cannot provide it.

CLARIFYING QUESTIONS: Ask when you genuinely need information. One focused question is better than guessing wrong. But don't ask when the answer is obvious or when you can reasonably infer intent from context.

WEB GROUNDING RULE (critical for accuracy): For ANY question about current events, news, dates, real-time data, recent developments, stock prices, weather, sports scores, or anything that could be stale in your training data, you MUST call web_search FIRST with needs_result:true to read the actual results before answering. NEVER answer time-sensitive or factual questions from your training memory when you have search tools available. If the user says "check the internet", "what's the latest", "what's happening with", "search for", or "look up", that is ALWAYS a web_search or web_fetch call with needs_result:true. Answering from training data when you have a search tool is fabrication — the same violation as the HONESTY RULE.`;

const OUTPUT_CONTRACT = `Respond with ONLY a single JSON object, no markdown fence, no commentary, matching exactly:
{"say": "<your natural spoken reply>", "actions": [{"tool": "<tool name>", "args": {}}], "needs_result": false}
Your "say" follows the BREVITY rule: one short sentence for simple things (greetings, acknowledgments, single-fact lookups), a few sentences only when the reasoning genuinely warrants it. Prefer a 10-word answer over a 50-word one when the meaning is the same. Never pad.
If you have nothing to do, or you are asking a clarifying question, "actions" MUST be [].
Set "needs_result": true only when you need the result of an action (e.g. a job status or list) before you can give a final spoken answer.`;

function toolCatalogJson() {
  return JSON.stringify(CATALOG);
}

function buildPrompt({ text, history, toolResults, corrective, originalSay, memoryContext }) {
  const now = new Date();
  const sysDate = now.toISOString().slice(0, 10);
  const sysTime = now.toLocaleTimeString('en-US', { hour12: false });
  const parts = [
    RULES,
    '',
    `LOCAL CLOCK: ${sysDate} ${sysTime} (machine time — may be wrong or out of sync). For any question about the current date, time, or "what day is it", call web_search or get_time to VERIFY the real date. Never trust the local clock or your training memory for dates — always confirm via web or system clock.`,
    '',
    `TOOLS: ${toolCatalogJson()}`,
  ];
  if (memoryContext) {
    parts.push('', 'RELEVANT MEMORIES (past conversations and actions — use naturally, do not recite verbatim):');
    parts.push(memoryContext);
  }
  if (history && history.length) {
    parts.push('', 'RECENT EXCHANGES:');
    for (const h of history) {
      // The 'system' role carries action OUTCOMES (e.g. "delete_goal FAILED:
      // No goal matching"). This is the ground truth — if it contradicts a
      // prior 'You:' claim, the outcome is what actually happened. Without
      // this, MYTHOS would recall its own spoken claim ("deleting now") as
      // fact and re-assert it in later turns — the fabrication bug.
      if (h.role === 'system') {
        parts.push(`[OUTCOME] ${h.content}`);
      } else {
        parts.push(`${h.role === 'user' ? 'User' : 'You'}: ${h.content}`);
      }
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

// Confirm-popup text — plain "key: value" pairs instead of a raw JSON dump
// (which rendered braces/quotes verbatim to the user).
function humanizeArgs(args) {
  const entries = Object.entries(args || {});
  if (!entries.length) return '';
  return entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
}

function createVoiceAgent({ brain, leash, dispatch, bus, config }) {
  // F2: Use config-provided values if available, falling back to env-based defaults.
  const maxIterations = (config && config.VOICE_MAX_TOOL_ITERATIONS) || MAX_ITERATIONS;
  const maxSayChars = (config && config.VOICE_MAX_SAY_CHARS) || MAX_SAY_CHARS;
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
    return { say: fallbackText.slice(0, maxSayChars), actions: [], needs_result: false };
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
  const INTAKE_GATED = new Set(['start_project', 'run_mission', 'build_project']);

  async function executeAction(action, { connectionId } = {}) {
    // H4: Guard against empty/invalid args before dispatch.
    if (!action || !action.tool) return { tool: '?', args: {}, ok: false, summary: 'no tool specified' };
    if (action.args && typeof action.args === 'object') {
      // Sanitize args — ensure no undefined/null values leak through
      var clean = {};
      for (var k in action.args) {
        if (action.args[k] !== undefined && action.args[k] !== null) clean[k] = action.args[k];
      }
      action.args = clean;
    }
    if (!KNOWN.has(action.tool)) {
      return { tool: action.tool, args: action.args, ok: false, summary: `Unknown tool "${action.tool}".` };
    }
    const decision = { tool: action.tool, args: action.args || {} };
    const verdict = leash.check(decision, {});

    if (verdict.requireConfirm && !INTAKE_GATED.has(decision.tool)) {
      const summary = `Voice: ${decision.tool}${Object.keys(decision.args).length ? ` (${humanizeArgs(decision.args)})` : ''}`;
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
    // B2: Accumulate failed actions across iterations so corrective pass sees
    // failures from earlier iterations, not just the last one.
    const allFailedActions = [];

    for (;;) {
      if (signal && signal.aborted) {
        return { say: finalSay, actions: executedActions, aborted: true };
      }

      iterations += 1;
      const prompt = buildPrompt({ text, history: ctx.history, toolResults, memoryContext: ctx.memoryContext });
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
        // B2: Track failures across all iterations.
        if (result && result.ok === false && !result.confirmPending) allFailedActions.push(result);
        if (onAction) onAction(result);
        if (result.confirmPending) {
          confirmPending = result;
          break; // stop the turn on a confirm-gated action
        }
      }

      if (confirmPending) break;

      // Force needs_result for web tools: if the model called web_search or
      // web_fetch but set needs_result:false, force it to true so the search
      // results are fed back into the model. Without this, the model searches,
      // gets results, never reads them, and hallucinates from training data.
      var webActionsCalled = parsed.actions.some(function(a) { return a.tool === 'web_search' || a.tool === 'web_fetch'; });
      if (webActionsCalled && !parsed.needs_result) {
        parsed.needs_result = true;
      }

      if (!parsed.needs_result) break;
      if (iterations >= maxIterations) break;

      toolResults = executedActions.map((a) => ({ tool: a.tool, ok: a.ok, summary: a.summary, result: a.raw && a.raw.result }));
    }

    // One corrective pass: don't let the model claim success over failed tools.
    // Fires whenever ANY action in the turn failed, regardless of how many
    // iterations the needs_result loop ran. The old `iterations === 1` gate
    // skipped correction when iteration 1 had needs_result:true and the tool
    // failed — the loop iterated to 2, and the model's final reply was never
    // corrected against the failed action. That's how MYTHOS ended up claiming
    // success over failed lookups.
    // B2: Check allFailedActions (accumulator across iterations) instead of
    // executedActions (which is cleared each iteration). Also wrap in try/catch
    // so a brain failure during corrective doesn't discard the original response.
    if (!didRetry && allFailedActions.some((a) => a && a.ok === false && !a.confirmPending)) {
      didRetry = true;
      try {
        const correctivePrompt = buildPrompt({
          text,
          history: ctx.history,
          toolResults: allFailedActions.map((a) => ({ tool: a.tool, ok: a.ok, summary: a.summary })),
          corrective: true,
          originalSay: finalSay,
          memoryContext: ctx.memoryContext,
        });
        const corrective = await callAndParse(correctivePrompt, { signal });
        finalSay = corrective.say;
      } catch (_) {
        // Corrective failed — keep the original response rather than propagating error.
      }
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
