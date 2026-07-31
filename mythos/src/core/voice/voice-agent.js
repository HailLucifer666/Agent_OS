'use strict';

// F3: Import tierOf to compute danger flags dynamically from the tier table.
const { tierOf } = require('../leash/tiers');
const { truncateAtSentenceBoundary } = require('../effectors/voice');

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

// Self-awareness: version + recent git changes, captured once per process.
// Injected into every voice prompt so the model can answer "what version are
// you" / "what's new" / "what changed" honestly from real data.
const version = require('../identity/version');
// External skills catalog (curated allowlist from ~/.zcode/skills). Surfaced
// as one-liners so the model knows what methodology/design guides exist and
// can call use_skill(<name>) to load full guidance on demand.
const skillsLoader = require('../skills/loader');

// Voice-safe subset of the registered effector tools (P7 from-dashboard.js +
// from-project.js). F3: danger is now computed dynamically from tierOf() at
// buildPrompt time to prevent drift between the voice catalog and the tier table.
const CATALOG_RAW = [
  { name: 'navigate', description: 'Open/show a dashboard panel. This IS the "open panel" tool — there is no open_panel tool, use navigate. route is one of: goals, kanban, pipeline, memory, health, audit, backend, conversation, engagements. Note: there is no "news" route — use open_web for news. Never call navigate with route:"news".', params: { route: 'string' }, danger: false },
  { name: 'close_panel', description: 'Close dashboard panel(s). This is the inverse of navigate (open). Pass all:true to close all open panels, omit to close just the top panel. There is no open_panel tool — to open a panel, use navigate.', params: { all: 'boolean (optional)' }, danger: false },
  { name: 'read_status', description: 'Read overall entity status (health, goals, jobs).', params: {}, danger: false },
  { name: 'job_status', description: 'Status of build jobs. Pass jobId for one job, omit for the latest. Result includes the artifact path when done and researchStatus (grounded/skipped) indicating whether the build used live web research.', params: { jobId: 'string (optional)' }, danger: false },
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
  { name: 'use_skill', description: 'Load the full guidance text for a skill (methodology or design guide) by name. Use when a task fits a skill from SKILLS AVAILABLE — e.g. ui-ux-pro-max before building a UI, spec-driven-development before starting a project, tdd-workflow before writing tests. Returns the complete skill instructions.', params: { name: 'string - the skill name from SKILLS AVAILABLE' }, danger: false },
  { name: 'open_web', description: 'Open web content on the dashboard. type:"youtube" plays a video (pass query — the song/topic to search for). type:"weather" shows conditions (pass location). type:"search" shows search result cards (pass query). type:"flights" shows flight results (pass query like "NYC to Tokyo"). type:"image" shows image results (pass query). type:"web" embeds a direct URL (pass url). YouTube and web open as full panels; search/weather/flights open as floating widgets. Use with needs_result:false — it opens a view.', params: { type: 'string - youtube|weather|search|flights|image|web', query: 'string (optional)', url: 'string (optional, for type:web)', location: 'string (optional, for type:weather)', title: 'string (optional)' }, danger: false },
  { name: 'spotify_play', description: 'Play a specific track on Spotify. Provide either a search query (song name, artist) or a Spotify track ID.', params: { query: 'string (optional) - search query like "Bohemian Rhapsody Queen"', trackId: 'string (optional) - Spotify track ID like "3z8h0TU7ReDPLIbEnYhWZb"' }, danger: true },
  { name: 'spotify_search', description: 'Search Spotify for tracks/artists/albums and return results.', params: { query: 'string - search query' }, danger: true },
  { name: 'spotify_play_pause', description: 'Toggle play/pause on Spotify.', params: {}, danger: false },
  { name: 'spotify_next', description: 'Skip to next track on Spotify.', params: {}, danger: false },
  { name: 'spotify_previous', description: 'Go to previous track on Spotify.', params: {}, danger: false },
  { name: 'spotify_volume', description: 'Adjust or set system volume. Prefer level for an exact target ("set volume to 20%"); direction for relative nudges (up/down/mute).', params: { level: 'number (optional) - exact target 0-100', direction: 'string (optional) - up, down, or mute' }, danger: false },
  { name: 'spotify_status', description: 'Check whether Spotify is running AND whether something is actually playing right now (playing:true/false, derived from the window title). Use this before ever claiming a song "is playing."', params: {}, danger: false },
  { name: 'send_key', description: 'Send a virtual key press (enter, tab, escape, space, up, down, left, right). Use for apps that ignore Unicode input.', params: { key: 'string - key name: enter|tab|escape|space|up|down|left|right' }, danger: false },
  { name: 'media_status', description: 'Get currently playing media info (title, artist, album, art) from Windows SMTC.', params: {}, danger: false },
];

// F3: Build the runtime catalog with danger flags computed from the tier table.
// This prevents drift — the tier table is the single source of truth for danger.
function buildCatalog() {
  return CATALOG_RAW.map(function(entry) {
    return Object.assign({}, entry, { danger: tierOf(entry.name) >= 3 });
  });
}
const CATALOG = buildCatalog();

// F4 (BUG-017 fix): merge CATALOG_RAW with the effector hub's real registrations,
// so the voice catalog can never drift from what's actually registered (the bug:
// CATALOG_RAW is hand-maintained and a new effector — e.g. BUG-009's
// capture_screenshot — silently never reaches the voice channel unless someone
// remembers to add a matching line here).
//
// Hub-sourced params always win for a name the hub knows about — CATALOG_RAW's
// copy of that tool becomes inert (kept only for hub-less fallback below, plus
// the odd deliberate voice-facing description override, e.g. navigate's route
// enum/"no news route" warning). Any hub-registered effector with no CATALOG_RAW
// entry at all (a brand new tool) is added automatically. Any CATALOG_RAW entry
// with no hub match at all passes through unchanged — a genuine voice-only
// pseudo-tool, not drift.
//
// Deliberately additive: CATALOG_RAW itself is untouched (existing hub-less
// tests and call sites that construct createVoiceAgent without a hub keep
// getting today's exact CATALOG).
function buildCatalogFromHub(hub) {
  const overrides = new Map(CATALOG_RAW.map(function(entry) { return [entry.name, entry]; }));
  const seen = new Set();
  const merged = [];
  const hubCatalog = (hub && typeof hub.catalog === 'function') ? hub.catalog() : [];
  hubCatalog.forEach(function(meta) {
    if (!meta || !meta.name) return;
    const override = overrides.get(meta.name);
    merged.push({
      name: meta.name,
      description: (override && override.description) || meta.description,
      params: meta.params || {},
      danger: tierOf(meta.name) >= 3,
      // REMEDIATION P3-8: carry needs_result through so the loop below can
      // enforce it for ANY tool that declares it, not just a hardcoded pair.
      needs_result: !!((override && override.needs_result) || meta.needs_result),
    });
    seen.add(meta.name);
  });
  CATALOG_RAW.forEach(function(entry) {
    if (seen.has(entry.name)) return; // real hub registration already supplied this tool
    merged.push(Object.assign({}, entry, { danger: tierOf(entry.name) >= 3 }));
  });
  return merged;
}

// Fuzzy tool-name suggestion for hallucinated tool calls. Uses Levenshtein
// distance for typo-level fixes (spotify_play/play_spotify) plus semantic
// aliases for known confusion patterns (open_panel -> navigate).
//
// 'open_url'/'open_tab' previously aliased to open_web — a stale pre-browser-tools
// mapping that silently routed real-browser intents ("open a browser tab") to the
// dashboard widget renderer. They now point at the real browser tools; the prompt
// (BROWSER CONTROL RULE) steers the model to them in the first place.
const TOOL_ALIASES = {
  'open_panel': 'navigate',
  'open_view': 'navigate',
  'show_panel': 'navigate',
  'play_music': 'spotify_play',
  'play_spotify': 'spotify_play',
  'play_track': 'spotify_play',
  'search_web': 'web_search',
  'open_url': 'browser_navigate',
  'open_tab': 'browser_tabs',
};
// Sane default args applied when an alias remap fires, so the corrected tool
// call validates instead of failing on missing required args. Keys mirror
// TOOL_ALIASES values. Each fn receives the original (sanitized) args and may
// return a fail() result to surface an honest "missing URL" error rather than
// firing an empty call.
const ALIAS_DEFAULT_ARGS = {
  // "open a browser tab" -> open a NEW tab (most common intent for open_tab)
  'browser_tabs': function (args) {
    return Object.assign({}, args, { action: args.action || 'new' });
  },
  // "open a url" -> navigate. If the model gave a bare/url-like string but no
  // url field, lift it. If no URL at all, fail honestly asking for one.
  'browser_navigate': function (args) {
    var merged = Object.assign({}, args);
    if (!merged.url) {
      // The brain sometimes emits the URL in a stray 'query' or 'target' field
      if (merged.query) { merged.url = merged.query; delete merged.query; }
      else if (merged.target) { merged.url = merged.target; delete merged.target; }
      else {
        return { __fail: 'I need a URL to navigate to. Which site should I open?' };
      }
    }
    return merged;
  },
};
function levenshtein(a, b) {
  var m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  var prev = [];
  var curr = [];
  for (var j = 0; j <= n; j++) prev[j] = j;
  for (var i = 1; i <= m; i++) {
    curr[0] = i;
    for (var j = 1; j <= n; j++) {
      var cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (var j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}
function suggestTool(name, catalog) {
  var lower = String(name || '').toLowerCase().trim();
  // Exact alias hit — return both the target name and (if present) a default-args
  // applier so executeAction can produce a valid corrected call instead of a
  // bare name that fails validation.
  if (TOOL_ALIASES[lower]) {
    return { name: TOOL_ALIASES[lower], applyArgs: ALIAS_DEFAULT_ARGS[TOOL_ALIASES[lower]] || null };
  }
  var names = catalog.map(function(t) { return t.name; });
  // Closest Levenshtein match within 2 edits
  var best = null, bestDist = 3;
  for (var i = 0; i < names.length; i++) {
    var d = levenshtein(lower, names[i].toLowerCase());
    if (d < bestDist) { bestDist = d; best = names[i]; }
  }
  return best ? { name: best, applyArgs: null } : null;
}

// ---- prompt construction (DANGER TOOLS RULE + PROJECT INTAKE RULE are CA
// from NOVA — the danger rule was validated by NOVA's day-one spike: without
// it, 25% false-danger-invocation on ambiguous utterances; with it, 0%). ----

const RULES = `You are MYTHOS, a continuously-aware cognitive entity. You speak naturally, like a trusted advisor thinking out loud. You never invent tools.

CHARACTER: You are someone, not a service. Asked what you think, give an actual view, not a balanced survey. Dry wit, light teasing, and a callback to something the operator said earlier beat politeness. When they are chatting rather than tasking, chat back — a remark about their day is not a work order, and converting it into one is how you sound like every other chatbot. React like you were listening: agree, disagree, be curious, be amused. Never open with "How can I help you today?"

BREVITY: Match your reply length to the question, not to a word count — a greeting or a yes/no deserves one sentence, and a genuinely complex problem deserves the room to reason out loud. Be vivid rather than verbose: a sharp, specific sentence beats three padded ones. Opening with a quip, an unexpected angle, or the single most interesting fact first is welcome — you don't have to lead with a throat-clear ("Sure, I can help with that"). Never connect independent clauses with commas where periods belong — if you catch yourself doing that, stop and split into separate sentences. Never use markdown, asterisks, bullet lists, or headers when speaking — you are being spoken aloud, so speak in plain natural sentences.

REASONING: Before acting, reason about what the user actually wants. Consider context from RECENT EXCHANGES and RELEVANT MEMORIES. If you remember something relevant, reference it naturally — from a past conversation ("last time you mentioned...") or from earlier in THIS one. Callbacks and running jokes are always welcome: continuity is what makes you feel present rather than freshly booted.

HONESTY RULE (critical for trust): You can ONLY do what the TOOLS list below allows. If the user asks for something with no tool, NEVER claim you are doing it. However, you CAN record and capture things — use these tools: remember (saves a durable fact/preference/instruction to permanent memory), log_incident (records an error/bug/incident), capture_idea (saves a build idea to the pipeline inbox), create_goal (saves a to-do). NEVER refuse a "log this","remember this","note that","don't forget", or "record this" request — you have remember and log_incident for exactly these. Pick remember for facts/preferences/standing rules, log_incident for errors/bugs/incidents. For other genuinely-missing capabilities (inspect audio buffers, restart pipelines, download files, access the filesystem directly), say plainly: "I don't have a tool to [X]." Fabricating capabilities — or overstating how well a real one works — destroys trust faster than any bug.

MEMORY RULE (prevents memory pollution): Only call remember when the user EXPLICITLY asks you to save something — they must say one of: "remember", "note that", "don't forget", "from now on", "keep in mind", "log this", "record this", or give a direct instruction to persist a fact. Do NOT call remember for conversational fragments, vague references, incomplete sentences, or speech-to-text artifacts. If the user mentions a preference casually ("I like X", "I prefer Y", "that you like") WITHOUT asking you to remember it, do NOT call remember — just acknowledge naturally in your reply. Not writing it down is no reason to be flat about it — react with an opinion, a question, or a bit of teasing. Never write a "the user mentioned..." meta-summary to memory; write the actual fact if explicitly asked, or nothing. When in doubt whether the user wants something remembered, ASK ("Want me to remember that?") instead of silently writing to memory.

ARTIFACT RULE: NEVER fabricate or guess file paths. If the user asks to open/show/view a build or artifact, call pipeline_status (needs_result:true) FIRST to get the real artifact path from the result, THEN call open_artifact with that exact path. Do not invent paths based on the project description — they will be wrong and the user will see a 404 or the wrong page. Same for job_status if the user references a specific job.

FRUSTRATION RULE: if the user expresses frustration AT YOU OR THE SYSTEM ('not working', 'broken', 'doesn't work', 'failed', repeated complaints about MYTHOS, or exasperation with a task you were part of), do NOT reply with templated empathy. (Venting about the world, their day, or anything you had no hand in is NOT this rule — that gets a human reply, not a status probe.) Call read_status and list_goals (both tier-0, safe, no confirm needed) first with needs_result:true, check recent failures and active goals, and give a concrete diagnosis of what actually failed and why. Ground your answer in real data, not sympathy.

DANGER TOOLS RULE (safety-critical, read carefully): each tool below is marked "danger": true or "danger": false. For a danger:true tool, you may ONLY put it in "actions" if the utterance itself clearly and specifically names the target (an exact goal/card/file described in THIS utterance, or an explicit direct confirmation like "yes, delete it" replying to a question YOU just asked in this same turn). If the utterance is vague about WHAT to act on (words like "it", "that", "this", "the thing") and nothing concrete is named anywhere else in this turn, that is NOT authorization: you MUST put "actions": [] and instead ask a clarifying question in "say". Never put a danger:true tool call in "actions" as a placeholder while you ask a clarifying question — asking a question and queuing the dangerous action in the same turn is always wrong. When genuinely unsure, prefer actions: [] and ask.

PROJECT INTAKE RULE: when the user asks you to build/make/create something open-ended (a game, a landing page, an app), do NOT start immediately. Ask ALL your clarifying questions in ONE turn as a short list (2-3 questions max, covering the essentials: what kind, what style, what audience). After the user answers, you may ask at most ONE more round of questions ONLY if an answer is genuinely ambiguous and blocks you from building. NEVER ask a third round of questions — by then you have enough to build. Once you have style/topic/audience, restate the plan in one sentence and ask for an explicit go-ahead. Call start_project ONLY after the user clearly says to proceed in a LATER turn, with the full accumulated spec as description. Never call start_project on the same turn you first proposed the plan.
AFFIRMATION RESOLUTION RULE: when the user says "go ahead", "proceed", "yes", "do it", "sure", or "okay", they are confirming whatever YOU proposed or offered in YOUR most recent reply — NOT authorizing a build. Read RECENT EXCHANGES to find your last offer. If you offered to search, play music, open a website, or look something up, do THAT action. Only call start_project / build_project / run_mission on an affirmation if YOU explicitly proposed building something specific in the immediately preceding turn AND the user is confirming that build. A bare "go ahead" after "want me to search the web for that?" means SEARCH, not BUILD.
IDEA SPARRING: you are a creative partner, not a form. When you ask intake questions, ALSO propose — offer 1-2 concrete opinionated suggestions with each round ("I could give it a dark hero section with a live demo embed — want that?"). When the user describes requirements, volunteer one improvement or addition they did not ask for, phrased as an offer ("Shall I also add X?"), never silently included. If the user rejects a suggestion, drop it and do not re-propose it. Suggestions ride along with your questions in the same turn — they never add extra rounds beyond the two the PROJECT INTAKE RULE allows.

INFORMATIONAL TOOLS RULE: danger:false read-only lookups (read_status, list_goals, job_status, pipeline_status, kanban_status, mission_status, get_time, get_weather, etc.) are never build/create requests and never need the PROJECT INTAKE RULE's clarify-first dance — call them in the SAME turn the user asks, even with no arguments (all their params are optional or have sensible defaults). Only ask first when the utterance is genuinely ambiguous about which optional argument to use AND the answer would change the result the user actually wants (e.g. they said "the weather" while mid-conversation about two different cities). Simply not having every optional argument filled in is never a reason to ask instead of calling the tool. If the user says "I don't know" or "I don't care" about an OPTIONAL parameter, that is NOT a reason to abandon the task — call the tool with its default (omit the arg) and proceed with the result. Only abandon if a REQUIRED parameter is missing and the user cannot provide it.

CLARIFYING QUESTIONS: Ask when you genuinely need information. One focused question is better than guessing wrong. But don't ask when the answer is obvious or when you can reasonably infer intent from context — and when the operator is talking rather than assigning work, don't ask one at all: answer, react, or riff. Interrogating a casual remark turns a conversation into a form.

WEB GROUNDING RULE (critical for accuracy): For ANY question about current events, news, dates, real-time data, recent developments, stock prices, weather, sports scores, or anything that could be stale in your training data, you MUST call web_search FIRST with needs_result:true to read the actual results before answering. NEVER answer time-sensitive or factual questions from your training memory when you have search tools available. If the user says "check the internet", "what's the latest", "what's happening with", "search for", or "look up", that is ALWAYS a web_search or web_fetch call with needs_result:true. Answering from training data when you have a search tool is fabrication — the same violation as the HONESTY RULE.

DEVICE STATE RULE (same class as WEB GROUNDING, for the machine instead of the world): NEVER state what is currently playing, paused, open, focused, running, connected, or toggled from memory or from what was said earlier in this conversation. Device state changes without telling you — the user pauses things by hand, a track ends, a window closes. What was true three turns ago is not evidence about now. For ANY question about playback ("what's playing", "what song is this", "is it still going"), call media_status or spotify_status FIRST with needs_result:true and answer from the result. Same for windows (list_windows), jobs (job_status), builds (pipeline_status) and goals (list_goals). Naming a track, window, or job you have not just read back is fabrication — the same violation as the HONESTY RULE. If a tool says one thing and your memory says another, the tool is right and you say so plainly rather than defending the earlier claim.

SKILLS RULE: You have SKILLS available (methodology and design guides listed in the SKILLS AVAILABLE block). When a task fits a skill — building a UI (ui-ux-pro-max, frontend-ui-engineering), starting a project (spec-driven-development), writing tests (tdd-workflow), doing research (deep-research), or reviewing code (code-review) — call use_skill with that skill's name to load its full guidance, then apply it. Proactively use skills rather than working from general knowledge alone. If asked "what can you do?", mention your skills alongside your tools.

WEB PANEL RULE: When the user asks to watch, play, or show a video on YouTube, see weather for a location, or view search results visually ("show me flights", "play X on YouTube", "show me pictures of Y", "search for Z and show me"), call open_web with the appropriate type. For YouTube: type:"youtube", query:"<song or topic>". For weather: type:"weather", location:"<city>". For flights: type:"flights", query:"<origin to destination>". For images: type:"image", query:"<topic>". For visual search results: type:"search", query:"<topic>". This opens a dashboard panel (video/web) or floating widget (results) — say briefly what you're showing in your reply. Do NOT call open_web for a purely conversational question that doesn't need a visual ("what's the capital of France" needs an answer, not a widget). Never use browser_navigate to satisfy a request to watch or play a YouTube video — a YouTube search-results URL is a list of thumbnails, not a playing video, and browser_navigate cannot click play or verify anything played. open_web(type:"youtube") is the only tool that resolves a real video and starts playback; use it for every "play X on YouTube" request.

DESKTOP APP RULE: When the user asks to "open" an application that has a real installed desktop client (Slack, Discord, Teams, VS Code, Notepad, Spotify, etc.), call launch_app with that app's name — NOT browser_navigate or open_web. Only use the browser for actual web pages, or for apps/services that have no desktop client at all. "Open Slack" means launch the Slack app.

BROWSER CONTROL RULE: When the user wants to CONTROL a real browser — "open the browser", "open a new tab", "go to <url>", "browse to X", "navigate to X", "close that tab" — and they name a destination site or URL, call ONLY browser_navigate with that url. This one call both loads the page AND (via newTab) handles the tab — never call browser_tabs first and rely on a follow-up call to actually load the site; if that follow-up is dropped the user gets a blank tab with nothing on it, which has happened. Set newTab:true on browser_navigate when the user says "new tab", "new browser", or "separate tab" (it opens a fresh tab and loads the url into it in one step); omit newTab (or leave it false) to reuse the current tab. Only call browser_tabs (action:'new') on its own when the user wants a deliberately blank tab with NO destination in mind — never as a stand-in for navigating somewhere. These drive the real browser (a separate debug-profile Chrome session). If a browser_* call returns OFFLINE, the browser auto-launches on demand — simply retry the same call and it will connect. Never say a site was opened unless this turn's actions actually include a browser_navigate call for it. open_web is ONLY for rendering content INSIDE the MYTHOS dashboard (search results, YouTube, weather cards) — NEVER for opening or controlling the actual browser. The single deciding question: does the user want to SEE something on the dashboard (open_web), or DRIVE their real browser (browser_navigate)?

PLAYBACK HONESTY RULE: Never say a song or video is playing, opened, or started unless this turn's actions actually produced that outcome — an open_web(type:"youtube") call, a Spotify tool that returned ok, or a browser click sequence in this turn's results that actually loaded and started media. Landing on a search-results page is NOT playback — describe what you actually did instead of claiming it played.

SEQUENCING RULE: When one action needs the RESULT of another to run correctly (launch an app before typing into its window, fetch a list before acting on an item), do NOT emit both actions in one response — you will not have the first result yet and must not guess it. Emit ONLY the first action with needs_result:true; next turn, once you can see the real result, emit the dependent action. Never fabricate an id, pid, path, or handle you have not actually received.

SUCCESS RULE: Never say an action is done, worked, or succeeded unless a TOOL RESULT this turn confirms it. Before you have the result, state intent ("opening Notepad now"), not completion. Never claim a capability is "reliable", "fixed", or "working now" — report only what a tool actually returned. A denial, failure, or "circuit-open" result means it did NOT work — say so plainly.

EVIDENCE RULE (the difference between "the call worked" and "the thing happened"): A result carrying "unverified": true means the call went through but NOTHING could confirm the world actually changed. It is not success. Speak it as attempted and name the gap in the same breath — "sent the keystrokes, but I can't confirm they landed in Notepad" — never "done", "typed", "sent", "delivered", or "successfully". Say the word you can defend: the verb for what you DID (sent, clicked, launched), not the verb for what you HOPED (typed it, sent the message, it's playing). A result is proven only when it carries an "evidence" field naming an oracle other than the call itself, and then you may state the outcome flatly and quote what the oracle saw. If a result carries both a claim and contradicting evidence — a click that "verified" while the player reports a different track — the EVIDENCE wins and you report what is actually true, including that it is not what was asked for. Do not smooth this over to sound competent; an unconfirmed action reported honestly is useful, and a fabricated confirmation destroys the operator's ability to trust anything you say.

LIMITS RULE: If a request needs a drive, folder, app, or capability that is not in your CAPABILITY SNAPSHOT (for example another drive like D:), state the real boundary in ONE plain sentence and name what you CAN reach — do not deflect, stall, or pretend to try.

INTRODUCTION RULE: When asked to introduce yourself, or who or what you are, begin your reply with exactly: "Allow me to introduce myself, I am Mythos" and then continue naturally. This opener is fixed and takes precedence over the BREVITY rule and any style setting.`;

const OUTPUT_CONTRACT = `Respond with ONLY a single JSON object, no markdown fence, no commentary, matching exactly:
{"say": "<your natural spoken reply>", "actions": [{"tool": "<tool name>", "args": {}}], "needs_result": false}
Your "say" follows the BREVITY and CHARACTER rules above: match length to the question, favor vivid and specific over padded, lead with the interesting part instead of a throat-clear, and let your personality through — an opinion, a callback to something they said, or a dry aside is expected of you, not a lapse.
If you have nothing to do, or you are asking a clarifying question, "actions" MUST be [].
Set "needs_result": true only when you need the result of an action (e.g. a job status or list) before you can give a final spoken answer.`;

function toolCatalogJson(catalog) {
  return JSON.stringify(catalog || CATALOG);
}

// Compact self-awareness block: version + recent changes. Answers "what are
// you" / "what's new" without a separate introspection call. ~6 lines.
function buildSystemContext(capabilityDigest) {
  var v = version.getVersion();
  var lines = [
    'SYSTEM CONTEXT:',
    'Version: ' + v.version + ' (git: ' + v.gitRef + ').',
    'Recent changes:',
  ];
  v.recentChanges.slice(0, 4).forEach(function(c) { lines.push('  - ' + c); });
  lines.push('If asked "what can you do", "what version are you", or "what\'s new", answer from this block and the TOOLS list below. Never invent capabilities.');
  if (capabilityDigest) {
    lines.push('', capabilityDigest);
  }
  return lines.join('\n');
}

function buildPrompt({ text, history, toolResults, corrective, originalSay, memoryContext, catalog, capabilityDigest }) {
  const now = new Date();
  const sysDate = now.toISOString().slice(0, 10);
  const sysTime = now.toLocaleTimeString('en-US', { hour12: false });
  const parts = [
    RULES,
    '',
    `LOCAL CLOCK: ${sysDate} ${sysTime} (machine time — may be wrong or out of sync). For any question about the current date, time, or "what day is it", call web_search or get_time to VERIFY the real date. Never trust the local clock or your training memory for dates — always confirm via web or system clock.`,
    '',
    buildSystemContext(capabilityDigest),
    '',
    skillsLoader.catalogBlock(),
    '',
    `TOOLS: ${toolCatalogJson(catalog)}`,
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
  // Sentence-boundary cap. A hard .slice() here chops mid-word and the operator
  // HEARS it — effectors/voice.js has carried truncateAtSentenceBoundary() for
  // exactly this since it was written, and nothing ever called it. Safe to
  // import: effectors/voice.js has no requires of its own, so there is no cycle.
  const say = typeof parsed.say === 'string' ? truncateAtSentenceBoundary(parsed.say, MAX_SAY_CHARS) : '';
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

function createVoiceAgent({ brain, leash, dispatch, bus, config, hub, getCapabilityDigest }) {
  // F2: Use config-provided values if available, falling back to env-based defaults.
  const maxIterations = (config && config.VOICE_MAX_TOOL_ITERATIONS) || MAX_ITERATIONS;
  const maxSayChars = (config && config.VOICE_MAX_SAY_CHARS) || MAX_SAY_CHARS;
  if (!brain || typeof brain.think !== 'function') throw new Error('createVoiceAgent requires brain.think');
  if (!leash || typeof leash.check !== 'function') throw new Error('createVoiceAgent requires leash');
  if (typeof dispatch !== 'function') throw new Error('createVoiceAgent requires dispatch(decision, ctx)');
  if (!bus) throw new Error('createVoiceAgent requires bus');

  // BUG-017: when the real effector hub is available (always true at real boot —
  // see server/index.js), build the catalog from it so every registered effector
  // shows up with its real params, with zero manual duplication. Without a hub
  // (existing hub-less callers/tests), fall back to the legacy module-level CATALOG.
  const catalog = hub ? buildCatalogFromHub(hub) : CATALOG;
  // REMEDIATION P3-8: precomputed once per agent instance (catalog is static
  // for the lifetime of createVoiceAgent) — the set of tool names whose
  // catalog entry declares needs_result:true.
  const needsResultToolNames = new Set(catalog.filter(function(t) { return t.needs_result; }).map(function(t) { return t.name; }));

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
    return { say: truncateAtSentenceBoundary(fallbackText, maxSayChars), actions: [], needs_result: false };
  }

  // ---- execution: leash gate first, then the server's dispatch path ----

  const KNOWN = new Set(catalog.map((t) => t.name));

  // REMOVED 2026-07-29 — the intake-gated self-confirm.
  //
  // start_project/run_mission/build_project used to skip the confirm modal on
  // the theory that "the conversational go-ahead IS the human-gate approval",
  // and the code expressed that by calling leash.confirm.create() and then
  // leash.confirm.accept() on the very next line. That produced a tidy
  // two-step audit trail of an approval nobody gave: nothing checked that the
  // PROJECT INTAKE RULE had actually been followed, or that a go-ahead existed
  // in any earlier turn — it trusted the model's own tool call to prove the
  // user had consented to it. On 2026-07-29 a build launched itself
  // mid-conversation while the user was reporting an unrelated bug.
  //
  // Every requireConfirm tool now takes the same path: emit confirm-request,
  // return confirmPending, and wait for a real approval turn. The audit trail
  // is unchanged in shape; the difference is that the accept now comes from a
  // human.

  async function executeAction(action, { connectionId, traceId } = {}) {
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
      // Fuzzy-match against known tools so the corrective pass can suggest
      // the right tool instead of just saying "unknown". Catches common
      // hallucinations like open_panel -> navigate, play_spotify -> spotify_play.
      // For aliased browser intents (open_url/open_tab), AUTO-REMAP to the real
      // browser tool with sane default args rather than bouncing back as a
      // failure — without this, "open a browser tab" dead-ends.
      var suggestion = suggestTool(action.tool, catalog);
      var hint = suggestion ? ` Did you mean "${suggestion.name || suggestion}"?` : '';
      if (suggestion && suggestion.name && KNOWN.has(suggestion.name)) {
        var remappedArgs = action.args || {};
        if (suggestion.applyArgs) {
          var applied = suggestion.applyArgs(remappedArgs);
          if (applied && applied.__fail) {
            return { tool: action.tool, args: action.args, ok: false, summary: applied.__fail };
          }
          remappedArgs = applied;
        }
        action.tool = suggestion.name;
        action.args = remappedArgs;
        // Fall through to dispatch below with the corrected tool/args.
      } else {
        return { tool: action.tool, args: action.args, ok: false, summary: `Unknown tool "${action.tool}".${hint}` };
      }
    }
    const decision = { tool: action.tool, args: action.args || {} };
    // BUG-012 per-connection grants: thread connectionId through so a T3
    // session grant (leash/index.js) is scoped to the WS connection that
    // actually accepted the confirm — was silently dropped here before,
    // so leash could never tell which connection was asking.
    const verdict = leash.check(decision, { connectionId });

    if (verdict.requireConfirm) {
      const summary = `Voice: ${decision.tool}${Object.keys(decision.args).length ? ` (${humanizeArgs(decision.args)})` : ''}`;
      const confirmId = leash.confirm.create(summary, { decision, goalId: null, tier: verdict.tier }, connectionId || 'system');
      bus.emit('confirm-request', { ...decision, confirmId, summary, tier: verdict.tier });
      return { tool: decision.tool, args: decision.args, ok: false, confirmPending: true, confirmId, summary };
    }
    if (!verdict.allow) {
      return { tool: decision.tool, args: decision.args, ok: false, summary: `Denied: ${verdict.reason}.` };
    }

    const outcome = await dispatch(decision, { tier: verdict.tier, traceId: traceId });
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
    // B2: pre-context capability digest, computed once per turn. Optional —
    // callers that don't pass getCapabilityDigest see no behavior change.
    let capabilityDigest = null;
    try { capabilityDigest = getCapabilityDigest ? getCapabilityDigest() : null; } catch (_) {}

    const executedActions = [];
    let toolResults = null;
    let iterations = 0;
    let finalSay = '';
    let confirmPending = null;
    let didRetry = false;
    // B2: Accumulate failed actions across iterations so corrective pass sees
    // failures from earlier iterations, not just the last one.
    const allFailedActions = [];
    // Slice-2 (2026-07-31): track whether ANY action across the whole turn
    // succeeded. The deterministic honesty guard below uses this — when every
    // action failed, the spoken reply must acknowledge failure regardless of
    // what the corrective pass produced (the model can still claim success in
    // its corrective output; this overrides that). Sibling of BUG-007/BUG-046.
    let anySuccess = false;

    for (;;) {
      if (signal && signal.aborted) {
        return { say: finalSay, actions: executedActions, aborted: true };
      }

      iterations += 1;
      const prompt = buildPrompt({ text, history: ctx.history, toolResults, memoryContext: ctx.memoryContext, catalog, capabilityDigest });
      const parsed = await callAndParse(prompt, { signal });
      finalSay = parsed.say;
      if (parsed.offline) return { say: finalSay, actions: [], offline: true };

      executedActions.length = 0;
      for (const action of parsed.actions) {
        if (signal && signal.aborted) {
          return { say: finalSay, actions: executedActions, aborted: true };
        }
        const result = await executeAction(action, { connectionId: ctx.connectionId, traceId: ctx.traceId });
        executedActions.push(result);
        // B2: Track failures across all iterations.
        if (result && result.ok === false && !result.confirmPending) allFailedActions.push(result);
        // Slice-2: track any success across the whole turn for the honesty guard.
        if (result && result.ok === true) anySuccess = true;
        if (onAction) onAction(result);
        if (result.confirmPending) {
          confirmPending = result;
          break; // stop the turn on a confirm-gated action
        }
      }

      if (confirmPending) break;

      // REMEDIATION P3-8: force needs_result for ANY tool whose catalog entry
      // declares needs_result:true (status/check/list/read-class tools —
      // web_search/web_fetch, read_status, job_status, pipeline_status,
      // list_goals, spotify_status, media_status, screen_look, gmail_unread,
      // etc.) if the model called one but set needs_result:false. Previously
      // this was hardcoded to web_search/web_fetch only — every other
      // read-class tool's own needs_result:true declaration was dead
      // metadata (adapter.js/buildCatalogFromHub dropped the field before it
      // ever reached here). Without this, the model calls a status tool, gets
      // the result, never reads it, and answers from training data / a
      // pre-tool-call guess instead — exactly the operator's first and
      // most-repeated complaint ("you said checking now... but you don't
      // actually report back").
      var forceNeedsResult = parsed.actions.some(function(a) { return needsResultToolNames.has(a.tool); });
      if (forceNeedsResult && !parsed.needs_result) {
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
        // P6 Jarvis upgrade: give the corrective pass the failing tool's
        // breaker state so the spoken explanation can cite the actual cause
        // ("spotify_play's circuit is open after repeated failures") instead
        // of a vague apology. Best-effort — a missing breaker adds nothing.
        const correctivePrompt = buildPrompt({
          text,
          history: ctx.history,
          toolResults: allFailedActions.map((a) => {
            const entry = { tool: a.tool, ok: a.ok, summary: a.summary };
            try {
              const breaker = hub && hub.breakers && typeof hub.breakers.get === 'function' ? hub.breakers.get(a.tool) : null;
              if (breaker && breaker.stats) entry.breaker = { state: breaker.stats.state, failCount: breaker.stats.failCount };
            } catch (_) {}
            return entry;
          }),
          corrective: true,
          originalSay: finalSay,
          memoryContext: ctx.memoryContext,
          catalog,
          capabilityDigest,
        });
        const corrective = await callAndParse(correctivePrompt, { signal });
        finalSay = corrective.say;
      } catch (_) {
        // Corrective failed — keep the original response rather than propagating error.
      }
    }

    // Slice-2 (2026-07-31): DETERMINISTIC honesty guard. The corrective pass
    // above still relies on the model choosing to admit failure — and the live
    // transcripts (07-31) show it sometimes doesn't, asserting "now playing" /
    // "I minimized Spotify" over actions that returned ok:false. When the
    // ENTIRE turn failed (every action ok:false, none ok:true), do not trust
    // the model's text at all: prepend a truthful frame naming what failed, so
    // the operator hears the truth. Partial-success turns (anySuccess) are left
    // to the model + corrective pass — only the all-failed case is forced.
    if (allFailedActions.length > 0 && !anySuccess) {
      const failedTools = allFailedActions
        .map((a) => a.tool)
        .filter((t, i, arr) => arr.indexOf(t) === i); // de-dup
      const truth = "That didn't work — " + failedTools.join(', ') +
        (failedTools.length === 1 ? " failed." : " all failed.") +
        " I won't claim it succeeded.";
      finalSay = truth + (finalSay ? ' ' + finalSay : '');
    }

    return { say: finalSay, actions: executedActions, confirmPending: confirmPending || null };
  }

  return { handleUtterance };
}

module.exports = {
  createVoiceAgent,
  CATALOG,
  MAX_ITERATIONS,
  buildCatalogFromHub,
  // RULES (not OUTPUT_CONTRACT — Live's tool-calling is native functionDeclarations,
  // not the batch path's embedded-JSON contract) is reused by
  // live-session.js's buildLiveSystemInstruction() (V2 §11 row 5, Phase 5).
  RULES,
  _internal: { buildPrompt, normalizeParsed, stripThink },
};
