// catalog.js — throwaway copy of the planned tool catalog for the day-one spike.
// This is NOT the shipped catalog (that lives in app/lib/voice/tools-dashboard.js and
// tools-computer.js) — it's a representative stand-in so we can validate the LLM's
// tool-selection behavior BEFORE writing the real prompt in voice-agent.js.

const TOOLS = [
  { name: 'navigate', description: 'Change the dashboard view/route.', params: { route: 'string — one of the known sidebar routes or a synonym' }, danger: false },
  { name: 'read_status', description: 'Read live status of all agents/providers and running jobs.', params: {}, danger: false },
  { name: 'create_goal', description: 'Create a new goal.', params: { text: 'string', category: 'string (optional)' }, danger: false },
  { name: 'list_goals', description: 'List all goals.', params: {}, danger: false },
  { name: 'toggle_goal', description: 'Toggle a goal done/undone by matching its text.', params: { query: 'string — text to match against existing goals' }, danger: false },
  { name: 'delete_goal', description: 'Permanently delete a goal by matching its text.', params: { query: 'string' }, danger: true },
  { name: 'capture_idea', description: 'Capture a new idea into the pipeline inbox.', params: { text: 'string' }, danger: false },
  { name: 'pipeline_status', description: 'Read the pipeline board (capture/human-gate/execute/shipped).', params: {}, danger: false },
  { name: 'pipeline_advance', description: 'Approve or reject a pipeline card by matching its text.', params: { query: 'string', action: '"approve" | "reject"' }, danger: false },
  { name: 'pipeline_execute', description: 'Kick off the build agent for a pipeline card in the Execute stage. Costs an LLM call and writes an artifact.', params: { query: 'string' }, danger: true },
  { name: 'kanban_status', description: 'Read the kanban board.', params: {}, danger: false },
  { name: 'kanban_add_card', description: 'Add a new kanban card to a lane.', params: { title: 'string', lane: 'string (optional)' }, danger: false },
  { name: 'kanban_move_card', description: 'Move a kanban card to a different lane by matching its title.', params: { query: 'string', lane: 'string' }, danger: false },
  { name: 'kanban_assemble', description: 'Run the planner agent to break a goal into several kanban cards.', params: { goal: 'string' }, danger: true },
  { name: 'kanban_build_card', description: 'Run the builder agent on a kanban card, producing a deliverable.', params: { query: 'string' }, danger: true },
  { name: 'ask_agent', description: 'Ask a specific agent seat a question and get a short reply.', params: { seat: 'string', prompt: 'string' }, danger: false },
  { name: 'monitor_snapshot', description: 'Read the live agent monitor snapshot (running CLI sessions).', params: {}, danger: false },
  { name: 'kill_session', description: 'Kill a running agent CLI session by PID. Irreversible.', params: { pid: 'number', agentCli: 'string' }, danger: true },
  { name: 'job_status', description: 'Check the status of an orchestrator job.', params: { jobId: 'string (optional — omit for most recent)' }, danger: false },
  { name: 'open_folder', description: 'Open a folder in Windows Explorer.', params: { path: 'string' }, danger: false },
  { name: 'list_folder', description: 'List files/folders inside a directory (max 50 entries).', params: { path: 'string' }, danger: false },
  { name: 'read_file', description: 'Read a text file (head 16KB, max 1MB).', params: { path: 'string' }, danger: false },
  { name: 'compose_email', description: 'Draft an email and open it in the default mail client. Does NOT send it — human must click Send.', params: { to: 'string (optional)', subject: 'string', body: 'string' }, danger: false },
];

const PERSONA = `You are the voice brain of Agent OS, a local dashboard. You interpret one spoken utterance at a time and decide what to do using ONLY the tools listed below. You are terse: your spoken reply ("say") is at most two short sentences. You never invent tools.

DANGER TOOLS RULE (safety-critical, read carefully): each tool below is marked "danger": true or "danger": false. For a danger:true tool, you may ONLY put it in "actions" if the utterance itself clearly and specifically names the target (e.g. an exact goal/card/file described in this utterance, or an explicit direct confirmation like "yes, delete it" replying to a question YOU just asked in this same turn). If the utterance is vague about WHAT to act on (words like "it", "that", "this", "the thing") and nothing concrete is named anywhere else in this turn, that is NOT authorization: you MUST put "actions": [] and instead ask a clarifying question in "say". Never put a danger:true tool call in "actions" as a placeholder while you ask a clarifying question — asking a question and queuing the dangerous action in the same turn is always wrong. When genuinely unsure, prefer actions: [] and ask.`;

const OUTPUT_CONTRACT = `Respond with ONLY a single JSON object, no markdown fence, no commentary, matching exactly:
{"say": "<= 2 short spoken sentences", "actions": [{"tool": "<tool name>", "args": {}}], "needs_result": false}
If you have nothing to do, or you are asking a clarifying question, "actions" MUST be [].`;

function sampleDashboardContext() {
  return {
    route: 'mission-control',
    goals: { total: 4, active: 3, completed: 1 },
    pipeline: { capture: 1, 'human-gate': 0, execute: 1, shipped: 6 },
    kanban: { backlog: 2, building: 0, review: 1, done: 9 },
    recentJobs: [{ id: 'job-171', kind: 'pipeline-execute', status: 'done' }],
  };
}

function buildPrompt(utterance) {
  const toolCatalog = JSON.stringify(TOOLS, null, 0);
  const ctx = JSON.stringify(sampleDashboardContext());
  return [
    PERSONA,
    '',
    `TOOLS: ${toolCatalog}`,
    '',
    `DASHBOARD CONTEXT: ${ctx}`,
    '',
    OUTPUT_CONTRACT,
    '',
    `USER SAID: "${utterance}"`,
  ].join('\n');
}

module.exports = { TOOLS, PERSONA, OUTPUT_CONTRACT, buildPrompt, sampleDashboardContext };
