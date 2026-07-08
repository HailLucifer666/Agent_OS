// tools-dashboard.js — voice tool catalog over the dashboard's existing lib modules.
// Each tool is a pure-ish function: (args) -> { ok, result, uiActions?[] }, never throws
// (internal errors are caught and returned as { ok:false, result: reason }).
//
// IMPORTANT id-scheme fact (verified in goals.js): goal ids are POSITIONAL — reindex()
// rewrites every goal's id to its array index on every mutation. toggle_goal/delete_goal
// therefore re-fetch the current goal list INSIDE this call, right before acting, and
// resolve the target by matching `query` against goal text — never by trusting an id/index
// carried over from an earlier turn's context (a stale index could now point at a different
// goal after an intervening add/delete elsewhere).
//
// kanban.js ids are STABLE (`card-${Date.now()}-${random}`, never reindexed), so
// kanban_move_card does a plain lookup-by-id; no re-fetch-and-compare staleness guard is
// needed there (see kanban.js — do not over-engineer this into looking like the goals case).

const goals = require('../goals');
const kanban = require('../kanban');
const pipeline = require('../pipeline');
const orchestrator = require('../orchestrator');
const abtop = require('../collectors/abtop');
const probes = require('../probes');
const agentActions = require('../agent-actions');
const { ALL_ROUTES, SYNONYMS } = require('./routes');

function ok(result, uiActions) {
  return uiActions ? { ok: true, result, uiActions } : { ok: true, result };
}
function fail(reason) {
  return { ok: false, result: reason };
}

// Finds the best case-insensitive substring match for `query` against a list of items,
// using `getText(item)` to extract the comparable text. Returns { item, index } or null.
function findByQuery(items, query, getText) {
  if (!query || !query.trim()) return null;
  const q = query.trim().toLowerCase();
  for (let i = 0; i < items.length; i += 1) {
    if (getText(items[i]).toLowerCase().includes(q)) return { item: items[i], index: i };
  }
  return null;
}

// ---- navigate ----

function navigate({ route }) {
  try {
    const raw = String(route || '').trim().toLowerCase();
    const resolved = ALL_ROUTES.includes(raw) ? raw : (SYNONYMS[raw] || null);
    if (!resolved || !ALL_ROUTES.includes(resolved)) {
      return fail(`"${route}" is not a known dashboard view.`);
    }
    return ok({ route: resolved }, [{ action: 'navigate', route: resolved }]);
  } catch (err) {
    return fail(err.message);
  }
}

// ---- open_artifact ----

async function open_artifact({ path, title }) {
  try {
    if (!path || !String(path).trim()) {
      return fail('An artifact path is required.');
    }
    const rawPath = String(path).trim();
    let targetUrl = rawPath;
    if (rawPath.startsWith('/vault/') || rawPath.startsWith('vault/')) {
      const port = process.env.PORT || 4477;
      const normalized = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
      targetUrl = `http://localhost:${port}${normalized}`;
    }
    const platform = process.platform;
    let cmd;
    if (platform === 'win32') {
      cmd = ['cmd', '/c', 'start', '', targetUrl];
    } else if (platform === 'darwin') {
      cmd = ['open', targetUrl];
    } else {
      cmd = ['xdg-open', targetUrl];
    }
    const { spawnSync } = require('child_process');
    const result = spawnSync(cmd[0], cmd.slice(1), { shell: platform === 'win32', detached: true, stdio: 'ignore' });
    if (result.error) throw result.error;
    const display = title || rawPath;
    return ok({ opened: true, url: targetUrl, display }, [{ action: 'navigate', route: 'pipeline' }]);
  } catch (err) {
    return fail(`Could not open artifact: ${err.message}`);
  }
}

// ---- status / jobs ----

async function read_status() {
  try {
    const status = await probes.getStatus();
    const jobs = orchestrator.listJobs().slice(-5);
    return ok({ status, recentJobs: jobs });
  } catch (err) {
    return fail(err.message);
  }
}

function job_status({ jobId }) {
  try {
    if (jobId) {
      const job = orchestrator.getJob(jobId);
      if (!job) return fail(`No job found with id ${jobId}.`);
      return ok({ job });
    }
    const jobs = orchestrator.listJobs();
    const last = jobs[jobs.length - 1] || null;
    return ok({ job: last });
  } catch (err) {
    return fail(err.message);
  }
}

// ---- goals ----

function create_goal({ text, category }) {
  try {
    if (!text || !text.trim()) return fail('Goal text is required.');
    const list = goals.addGoal(text, category);
    return ok({ goals: list, stats: goals.stats() });
  } catch (err) {
    return fail(err.message);
  }
}

function list_goals() {
  try {
    return ok({ goals: goals.listGoals(), stats: goals.stats() });
  } catch (err) {
    return fail(err.message);
  }
}

// toggle_goal / delete_goal: re-fetch goals.listGoals() fresh, right here, right before
// acting — see the module-level comment for why this is load-bearing.
function toggle_goal({ query }) {
  try {
    const current = goals.listGoals();
    const match = findByQuery(current, query, (g) => g.text);
    if (!match) return fail(`No goal matching "${query}" found.`);
    const list = goals.toggleGoal(match.item.id);
    return ok({ goals: list, toggled: match.item.text });
  } catch (err) {
    return fail(err.message);
  }
}

function delete_goal({ query }) {
  try {
    const current = goals.listGoals();
    const match = findByQuery(current, query, (g) => g.text);
    if (!match) return fail(`No goal matching "${query}" found.`);
    const list = goals.deleteGoal(match.item.id);
    return ok({ goals: list, deleted: match.item.text });
  } catch (err) {
    return fail(err.message);
  }
}

// ---- pipeline ----

function capture_idea({ text }) {
  try {
    if (!text || !text.trim()) return fail('Idea text is required.');
    const card = pipeline.capture(text);
    return ok({ card });
  } catch (err) {
    return fail(err.message);
  }
}

function pipeline_status() {
  try {
    return ok({ board: pipeline.listAll() });
  } catch (err) {
    return fail(err.message);
  }
}

function findPipelineCardByQuery(query) {
  const board = pipeline.listAll();
  for (const stage of Object.keys(board)) {
    const match = findByQuery(board[stage], query, (c) => c.text || '');
    if (match) return { card: match.item, stage };
  }
  return null;
}

function pipeline_advance({ query, action }) {
  try {
    const found = findPipelineCardByQuery(query);
    if (!found) return fail(`No pipeline card matching "${query}" found.`);
    if (action === 'approve') {
      const card = pipeline.approve(found.card.id);
      return ok({ card, board: pipeline.listAll() });
    }
    if (action === 'reject') {
      pipeline.reject(found.card.id);
      return ok({ board: pipeline.listAll() });
    }
    return fail(`Unknown pipeline action "${action}".`);
  } catch (err) {
    return fail(err.message);
  }
}

function pipeline_execute({ query }) {
  try {
    const found = findPipelineCardByQuery(query);
    if (!found) return fail(`No pipeline card matching "${query}" found.`);
    const result = agentActions.executePipelineCard(found.card.id);
    return ok(result);
  } catch (err) {
    return fail(err.message);
  }
}

// ---- kanban ----

function kanban_status() {
  try {
    return ok({ board: kanban.listBoard() });
  } catch (err) {
    return fail(err.message);
  }
}

function kanban_add_card({ title, lane }) {
  try {
    if (!title || !title.trim()) return fail('Card title is required.');
    const card = kanban.addCard(title, lane);
    return ok({ card, board: kanban.listBoard() });
  } catch (err) {
    return fail(err.message);
  }
}

// kanban ids are stable (never reindexed) — plain lookup-by-id via findByQuery on the
// current board is sufficient; no staleness guard needed (see module-level comment).
function kanban_move_card({ query, lane }) {
  try {
    const board = kanban.listBoard();
    const match = findByQuery(board.cards, query, (c) => c.title || '');
    if (!match) return fail(`No kanban card matching "${query}" found.`);
    const card = kanban.moveCard(match.item.id, lane);
    return ok({ card, board: kanban.listBoard() });
  } catch (err) {
    return fail(err.message);
  }
}

function kanban_assemble({ goal }) {
  try {
    const result = agentActions.assembleKanbanPlan(goal);
    return ok(result);
  } catch (err) {
    return fail(err.message);
  }
}

function kanban_build_card({ query }) {
  try {
    const board = kanban.listBoard();
    const match = findByQuery(board.cards, query, (c) => c.title || '');
    if (!match) return fail(`No kanban card matching "${query}" found.`);
    const result = agentActions.buildKanbanCard(match.item.id);
    return ok(result);
  } catch (err) {
    return fail(err.message);
  }
}

// ---- ask_agent ----
// dispatch is injected by voice-agent.js (which owns the actual provider-dispatch call,
// reused from server.js's handleChat) so this module stays free of WS/transport concerns
// and does not import server.js. See voice-agent.js's ASK_AGENT_DISPATCH wiring.
let askAgentDispatch = null;
function setAskAgentDispatch(fn) {
  askAgentDispatch = fn;
}

async function ask_agent({ seat, prompt }) {
  try {
    if (!askAgentDispatch) return fail('ask_agent is not wired up in this context.');
    if (!seat || !prompt || !prompt.trim()) return fail('seat and prompt are required.');
    const reply = await askAgentDispatch(seat, prompt);
    const capped = String(reply || '').slice(0, 600);
    return ok({ seat, reply: capped });
  } catch (err) {
    return fail(err.message);
  }
}

// ---- monitor ----

function monitor_snapshot() {
  try {
    return ok(abtop.getState());
  } catch (err) {
    return fail(err.message);
  }
}

async function kill_session({ pid, agentCli }) {
  try {
    if (!pid || !agentCli) return fail('pid and agentCli are required.');
    await abtop.killSession({ pid: Number(pid), agentCli });
    return ok({ killed: true, pid });
  } catch (err) {
    return fail(err.message);
  }
}

// ---- tool catalog table (name/description/params/danger), consumed by voice-agent.js
// to build the compact JSON-schema block in its prompt. ----
const TOOLS = [
  { name: 'navigate', description: 'Change the dashboard view/route.', params: { route: 'string' }, danger: false, fn: navigate },
  { name: 'open_artifact', description: 'Open a build result in the system browser. Use this for /vault/builds/... paths instead of browser_navigate when browser automation is offline.', params: { path: 'string', title: 'string (optional)' }, danger: false, fn: open_artifact },
  { name: 'read_status', description: 'Read live status of all agents/providers and recent jobs.', params: {}, danger: false, fn: read_status },
  { name: 'job_status', description: 'Check the status of an orchestrator job (most recent if jobId omitted).', params: { jobId: 'string (optional)' }, danger: false, fn: job_status },
  { name: 'create_goal', description: 'Create a new goal.', params: { text: 'string', category: 'string (optional)' }, danger: false, fn: create_goal },
  { name: 'list_goals', description: 'List all goals.', params: {}, danger: false, fn: list_goals },
  { name: 'toggle_goal', description: 'Toggle a goal done/undone by matching its text.', params: { query: 'string' }, danger: false, fn: toggle_goal },
  { name: 'delete_goal', description: 'Permanently delete a goal by matching its text.', params: { query: 'string' }, danger: true, fn: delete_goal },
  { name: 'capture_idea', description: 'Capture a new idea into the pipeline inbox.', params: { text: 'string' }, danger: false, fn: capture_idea },
  { name: 'pipeline_status', description: 'Read the pipeline board (capture/human-gate/execute/shipped).', params: {}, danger: false, fn: pipeline_status },
  { name: 'pipeline_advance', description: 'Approve or reject a pipeline card by matching its text.', params: { query: 'string', action: '"approve" | "reject"' }, danger: false, fn: pipeline_advance, dangerWhen: (args) => args && args.action === 'reject' },
  { name: 'pipeline_execute', description: 'Run the build agent for a pipeline card in the Execute stage.', params: { query: 'string' }, danger: true, fn: pipeline_execute },
  { name: 'kanban_status', description: 'Read the kanban board.', params: {}, danger: false, fn: kanban_status },
  { name: 'kanban_add_card', description: 'Add a new kanban card to a lane.', params: { title: 'string', lane: 'string (optional)' }, danger: false, fn: kanban_add_card },
  { name: 'kanban_move_card', description: 'Move a kanban card to a different lane by matching its title.', params: { query: 'string', lane: 'string' }, danger: false, fn: kanban_move_card },
  { name: 'kanban_assemble', description: 'Run the planner agent to break a goal into several kanban cards.', params: { goal: 'string' }, danger: true, fn: kanban_assemble },
  { name: 'kanban_build_card', description: 'Run the builder agent on a kanban card, producing a deliverable.', params: { query: 'string' }, danger: true, fn: kanban_build_card },
  { name: 'ask_agent', description: 'Ask a specific agent seat a question and get a short reply.', params: { seat: 'string', prompt: 'string' }, danger: false, fn: ask_agent },
  { name: 'monitor_snapshot', description: 'Read the live agent monitor snapshot (running CLI sessions).', params: {}, danger: false, fn: monitor_snapshot },
  { name: 'kill_session', description: 'Kill a running agent CLI session by PID. Irreversible.', params: { pid: 'number', agentCli: 'string' }, danger: true, fn: kill_session },
];

module.exports = {
  TOOLS,
  setAskAgentDispatch,
  // exported individually for direct unit testing
  navigate, open_artifact, read_status, job_status,
  create_goal, list_goals, toggle_goal, delete_goal,
  capture_idea, pipeline_status, pipeline_advance, pipeline_execute,
  kanban_status, kanban_add_card, kanban_move_card, kanban_assemble, kanban_build_card,
  ask_agent, monitor_snapshot, kill_session,
};
