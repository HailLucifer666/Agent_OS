'use strict';
// live-tools.js — convert MYTHOS's effector catalog into Gemini functionDeclarations.
//
// AD-3: declarations derive from buildCatalogFromHub(hub) — the real registry — so a
// newly-registered effector reaches the Live channel with zero manual duplication.
// Never hand-maintain a parallel list here.
//
// Nothing is ever silently dropped: an unparseable param becomes a string with its
// original prose as the description. A dropped param is a tool that fails at runtime
// for reasons nobody can see.

const { buildCatalogFromHub } = require('./voice-agent');

// Function-calling accuracy degrades with very large tool sets, and MYTHOS registers 107.
// This is the curated high-traffic default; override with LIVE_TOOL_ALLOWLIST.
const DEFAULT_ALLOWLIST = [
  'navigate','close_panel','read_status','open_web',
  'create_goal','list_goals','toggle_goal','delete_goal',
  'capture_idea','pipeline_status','pipeline_advance',
  'kanban_status','kanban_add_card','kanban_move_card',
  'start_project','build_project','project_status','job_status','open_artifact',
  'get_time','get_weather','web_search','web_fetch',
  'remember','log_incident','recall_memory',
  'reminder_add','reminder_list','reminder_cancel',
  'gmail_unread','gmail_read','gmail_draft','gmail_send',
  'spotify_play','spotify_play_pause','spotify_next','spotify_volume','spotify_status',
  'media_status','launch_app','focus_window','list_windows','ui_click','ui_type','send_key',
  'screen_look','screen_read_text','capture_screenshot',
  'browser_navigate','browser_click','browser_type','browser_get_text',
  'set_persona_level','ask_agent',
];

const OPTIONAL_RE = /\(optional\)/i;
const TYPE_RE = /^\s*(string|number|integer|boolean|object|array)\b/i;
const ENUM_RE = /'([^']+)'/g;

// 'number (optional) - exact target 0-100'  ->  {type:'number', description:'exact target 0-100'}
// "'approve' | 'reject'"                    ->  {type:'string', enum:['approve','reject']}
function parseParam(name, spec) {
  const raw = String(spec == null ? '' : spec);
  const optional = OPTIONAL_RE.test(raw);
  const typeMatch = raw.match(TYPE_RE);
  let type = typeMatch ? typeMatch[1].toLowerCase() : 'string';
  if (type === 'integer') type = 'number'; // Gemini schema uses NUMBER/INTEGER; NUMBER is safe

  const enumVals = [];
  let m;
  const enumRe = new RegExp(ENUM_RE.source, 'g');
  while ((m = enumRe.exec(raw)) !== null) enumVals.push(m[1]);

  // Description = the prose minus the type token and the (optional) marker.
  const description = raw
    .replace(TYPE_RE, '')
    .replace(OPTIONAL_RE, '')
    .replace(/^[\s\-—:|]+/, '')
    .trim() || name;

  const schema = { type, description };

  // Gemini's Schema REQUIRES `items` on an ARRAY. Without it the API rejects the
  // entire setup frame — not just the offending tool — so one array param with no
  // item type silently disabled every S2S session. Found live 2026-07-31 on the
  // first real connection: close code 1007, "function_declarations[5].parameters
  // .properties[elementPath].items: missing field".
  //
  // ponytail: hardcoded string items, no inference. All three array params in the
  // catalog today are string arrays (ui_click/ui_type elementPath, run_command
  // args), and the obvious inference is a trap — elementPath's own prose reads
  // "array of number strings", so matching /array of (\w+)/ would type it as
  // number and break the tool at call time instead of at setup. Ceiling: a genuine
  // array-of-number param would need a real item-type token in the param spec
  // (e.g. 'array<number> - ...') and a branch here to read it.
  if (type === 'array') schema.items = { type: 'string' };

  // Only treat quoted tokens as an enum when they look like a closed set, not prose.
  if (enumVals.length >= 2 && enumVals.every((v) => v.length <= 24)) schema.enum = enumVals;
  return { schema, optional };
}

function toDeclaration(entry) {
  const properties = {};
  const required = [];
  const params = entry.params || {};
  for (const key of Object.keys(params)) {
    const { schema, optional } = parseParam(key, params[key]);
    properties[key] = schema;
    if (!optional) required.push(key);
  }
  const decl = {
    name: entry.name,
    description: String(entry.description || entry.name).slice(0, 1024),
  };
  if (Object.keys(properties).length) {
    decl.parameters = { type: 'object', properties };
    if (required.length) decl.parameters.required = required;
  }
  return decl;
}

function buildFunctionDeclarations(hub, opts) {
  const options = opts || {};
  const catalog = buildCatalogFromHub(hub);
  const allow = options.allowlist && options.allowlist.length
    ? new Set(options.allowlist)
    : new Set(DEFAULT_ALLOWLIST);

  const declared = [], withheld = [];
  for (const entry of catalog) {
    if (!entry || !entry.name) continue;
    if (allow.has(entry.name)) declared.push(toDeclaration(entry));
    else withheld.push(entry.name);
  }
  // AD-5 in spirit: a silent cap reads as full coverage. Say what was withheld.
  if (options.log && withheld.length) {
    options.log(`live-tools: declared ${declared.length}, withheld ${withheld.length} — ${withheld.join(', ')}`);
  }
  return { declarations: declared, withheld };
}

module.exports = { buildFunctionDeclarations, DEFAULT_ALLOWLIST, _internal: { parseParam, toDeclaration } };
