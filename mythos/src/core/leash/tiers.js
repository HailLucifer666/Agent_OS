'use strict';

// Canonical Tier Table (Conservative Merge) — MYTHOS-ARCHITECTURE.md §9.
// Keys are tool names as they appear in decision.tool; values are the tier
// (0-4). Every key here is copied verbatim from the spec — do not rename,
// re-tier, or drop any entry without updating the spec first.
const TIER_TABLE = {
  // T0 — READ ONLY (auto-allow, never audit)
  'navigate':              0,
  'close_panel':           0,
  'read_status':           0,
  'job_status':            0,
  'list_goals':            0,
  'pipeline_status':       0,
  'kanban_status':         0,
  'monitor_snapshot':      0,
  'mission_status':        0,
  'get_time':              0,
  'get_weather':           0,
  'list_folder':           0,
  'read_file':             0,
  'list_windows':          0,
  'ui_elements':           0,
  'browser_get_title':     0,
  'web_search':            0,  // read-only research — fetches public search results
  'web_fetch':             0,  // read-only fetch — retrieves public web page content
  'camera_look':           0,  // read-only — captures and describes camera frame
  'remember':              0,
  'log_incident':          0,
  'reminder_add':          0,  // read-only — creates a local reminder record
  'reminder_list':         0,  // read-only — lists pending reminders
  'use_skill':             0,  // read-only — loads a skill's guidance text from disk
  'open_web':              0,  // read-only — opens a dashboard view (no destructive action)
  'recall_memory':         0,  // read-only — searches existing memory (recallHybrid), writes nothing

  // T1 — LOCAL WRITES (auto-allow, audit logged)
  'create_goal':           1,
  'toggle_goal':           1,
  'capture_idea':          1,
  'kanban_add_card':       1,
  'kanban_move_card':      1,
  'write_note':            1,
  'screen_look':           1,
  'capture_screenshot':    1,
  'browser_screenshot':    1,
  'browser_get_text':      1,
  'browser_scroll':        1,
  'browser_go_back':       1,
  'focus_window':          1,
  'pipeline_advance':      1,  // approve only — dangerWhen handles reject
  'gmail_unread':          1,
  'gmail_read':            1,
  'gmail_draft':           1,
  'reminder_cancel':       1,  // local write — cancels a pending reminder
  'spawn_widget':          1,  // local write — spawns a floating dashboard widget from a
                               // validated data-only spec (Item 11 generative UI)

  // T2 — LOCAL ACTIONS (auto-allow within AUTONOMOUS_MAX_TIER, audit)
  'open_folder':           2,
  'launch_app':            2,
  'open_artifact':         2,  // BUG-008 — opens a file/URL via the OS (cmd start/open/xdg-open),
                               // read-only w.r.t. destructive risk; same category as open_folder/
                               // launch_app above, not the T3 confirm tier. Was previously unmapped
                               // and fell back to tierOf()'s T3 fail-safe.
  'media_key':             2,
  'ask_agent':             2,
  'browser_navigate':      2,
  'browser_tabs':          2,
  'spotify_play_pause':    2,
  'spotify_next':          2,
  'spotify_previous':      2,
  'spotify_volume':        2,
  'spotify_status':        2,
  'send_key':              2,
  'media_status':          0,

  // T3 — CONFIRM-ONCE-PER-GOAL (grant recorded, dies with goal)
  'delete_goal':           3,
  'pipeline_execute':      3,
  'kanban_assemble':       3,
  'kanban_build_card':     3,
  'start_project':         3,
  'run_mission':           3,
  'build_project':         3,  // P22 Forge — multi-file build
  'revise_project':        3,  // P22 Forge — targeted regen
  'project_status':        0,  // P22 Forge — read-only build status (tier 0; flat table, position cosmetic)
  'compose_email':         3,
  'close_window':          3,
  'gmail_send':            3,
  'ui_click':              3,  // ELEVATED — autonomous typing unpredictable
  'ui_type':               3,  // ELEVATED — same reasoning
  'click_at':              3,  // ELEVATED — autonomous clicking unpredictable
  'browser_click':         3,
  'browser_type':          3,
  'spotify_play':          3,
  'spotify_search':        3,

  // T4 — ALWAYS CONFIRM (never cached, human must approve every time)
  'kill_session':          4,
  'browser_evaluate':      4
};

// Phase 7's effector adapter (effectorFromTool) needs a name->tier lookup with
// the same "unmapped tool" fail-safe leash/index.js's check() applies inline —
// added here (not spec'd explicitly in §9's snippet) so both call sites agree
// on the number without each reimplementing the fallback. Unmapped -> 3, never
// 4 — matches check()'s "Unknown tool -> T3 fail-safe" exactly.
function tierOf(name) {
  var tier = TIER_TABLE[name];
  return tier === undefined ? 3 : tier;
}

module.exports = { TIER_TABLE: TIER_TABLE, tierOf: tierOf };
