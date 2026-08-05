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
  'get_time','get_weather','get_directions','web_search','web_fetch',
  'remember','log_incident','recall_memory',
  'reminder_add','reminder_list','reminder_cancel','reminder_approve_action',
  'gmail_unread','gmail_read','gmail_draft','gmail_send',
  'spotify_play','spotify_play_pause','spotify_next','spotify_volume','spotify_status',
  'media_status','launch_app','focus_window','list_windows','close_window',
  // ui_elements is NOT optional next to ui_click. Withholding it (as this list did
  // until 2026-08-02) leaves the model holding ui_click(pid, elementPath) with no
  // way on earth to OBTAIN an elementPath — so it invents them. Every
  // "Element path index N out of range (parent has 0 children)" in
  // vault/Episodic/2026-08-02.jsonl is a fabricated path checked against a tree the
  // model was never allowed to read, not a stale path and not lazy Chromium a11y.
  // Any click tool added here must ship with its corresponding read tool.
  'ui_elements','ui_click','ui_type','send_key','click_at','see_and_click',
  // The Chromium-capable read+click pair. Their own descriptions say to use them
  // "when pc-child ui_elements returns no usable named element (common for
  // Chromium/CEF/Electron apps like Spotify desktop, YouTube web, Electron
  // overlays)" — advice the Live model could not follow, because none of the three
  // were reachable from this path while cua-driver was ONLINE and serving Spotify.
  // BUG-110: cua_bring_to_front was the one cua-driver tool left off this list
  // -- its pc-child twin focus_window is reachable, and its three cua_*
  // siblings above already are, so its absence was drift, not a choice.
  'cua_list_windows','cua_get_window_state','cua_click','cua_bring_to_front',
  // whatsapp_send was missing while its sibling gmail_send was present, so MYTHOS
  // truthfully answered "I don't currently have a tool to send WhatsApp messages"
  // and then improvised with ui_type into whatever box had focus. app_reply is the
  // generic form of the same job (reply into whatever chat app is already open).
  'whatsapp_send','whatsapp_contacts','whatsapp_contact_save','app_reply',
  'screen_look','screen_read_text','capture_screenshot',
  'browser_navigate','browser_click','browser_type','browser_get_text',
  // BUG-099: browser_navigate can now refuse a wrong-browser request and tell
  // the model to "call browser_launch_debug with browser:brave" — an instruction
  // it could not follow, because the launcher was not reachable from this path.
  // browser_get_title is its read oracle (which page is actually here), and
  // browser_tabs is what the 2026-08-05 session needed and did not have when the
  // operator asked to clean up a stray YouTube tab.
  'browser_launch_debug','browser_get_title','browser_tabs',
  'set_persona_level','ask_agent',
];

// BUG-110: a T0/T1 (read-only or local-write, auto-allow) effector missing
// from BOTH this list and DEFAULT_ALLOWLIST is a silent voice-reachability
// gap of get_directions's exact shape -- test/bug-110-t0-t1-allowlist-reachability
// .test.js fails loudly if one appears. Each group below is a deliberate
// curation choice (the tool-count/accuracy tradeoff noted above), not an
// oversight; promote an entry to DEFAULT_ALLOWLIST the day a session actually
// needs it from voice.
const VOICE_ALLOWLIST_EXEMPT = [
  // Sandboxed folder/file/clipboard reads -- desktop power-user surface, not
  // asked for in normal conversation; their write-side siblings are already T3.
  'list_folder','read_file','search_files','clipboard_read',
  // Status/introspection singletons -- read_status/self_capabilities-style
  // summaries cover these; not a distinct spoken verb of their own.
  'get_volume','mission_status','persona_status','self_capabilities',
  // Loads a skill's guidance text from disk -- internal/debugging surface.
  'use_skill',
  // Not yet asked for in a live session; promote if usage shows up.
  'camera_look','timer_add','timer_cancel',
  // Documents/code-search (§7.5, §7.11) -- opt-in power feature with its own
  // UI surface, not curated into the default voice set.
  'document_list','document_search','document_answer','document_ingest',
  'search_code','index_project',
  // MCP transport listing -- introspection for an optional, often-empty
  // MCP_SERVERS config; mcp_call_tool itself is T3 and correctly absent here.
  'mcp_list_servers','mcp_list_tools',
  // Open Knowledge Format bundle tools -- not a spoken verb.
  'okf_list','okf_import',
  // Android bridge (Task 10, step 6) -- debugging/status reads for an
  // optional adapter, not yet part of the curated voice surface.
  'phone_list_devices','phone_screenshot','phone_notifications','phone_contacts_search',
  // Dashboard/system writes with their own UI (kanban/widgets/daily brief) --
  // reachable through the HUD; withheld from voice to keep the tool count down.
  'write_note','spawn_widget','manage_widget','ambient_awareness','daily_plan',
  // Browser helper reads not curated alongside the browser_* set above.
  'browser_screenshot','browser_scroll','browser_go_back','browser_wait_for',
  // §7.6 calendar read -- gated behind the same missing-write gap BUG-104
  // documents; exempted rather than exposing a read with no companion action.
  'calendar_upcoming',
  // create_goal already covers the voice-reachable case; propose_goal's inert
  // 'proposed' status is an internal/autonomous-arbiter path (see goals.create
  // usage elsewhere in this batch).
  'propose_goal',
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

module.exports = { buildFunctionDeclarations, DEFAULT_ALLOWLIST, VOICE_ALLOWLIST_EXEMPT, _internal: { parseParam, toDeclaration } };
