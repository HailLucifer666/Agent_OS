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
  // 'monitor_snapshot' was removed 2026-07-31 (spec §9 snippet updated to
  // match): Wave 1's dead-code pass deleted the abtop-backed tool it named,
  // so the entry was dead policy that read as a shipped capability. The
  // T4 'kill_session' entry deleted in the same Wave 1 pass deliberately
  // STAYS — see test/tier-table-conformance.test.js's exemption comment.
  'mission_status':        0,
  'get_time':              0,
  'get_weather':           0,
  'get_directions':        0,  // §7.9 maps/routing — keyless OSRM+geocode, read-only
  'list_folder':           0,
  'read_file':             0,
  'clipboard_read':        0,  // Task 3 (step 5) — read-only
  'list_windows':          0,
  'ui_elements':           0,
  'screen_read_text':      0,  // §7.1 (step 5) — real OCR via Windows.Media.Ocr, read-only
  'browser_get_title':     0,
  'web_search':            0,  // read-only research — fetches public search results
  'web_fetch':             0,  // read-only fetch — retrieves public web page content
  'camera_look':           0,  // read-only — captures and describes camera frame
  'remember':              0,
  'log_incident':          0,
  'reminder_add':          0,  // read-only — creates a local reminder record
  'timer_add':             0,  // Task 5 (step 5) — same class as reminder_add above; a
                               // relative-time reminder additionally flagged to ring alertSound
  'reminder_list':         0,  // read-only — lists pending reminders
  'use_skill':             0,  // read-only — loads a skill's guidance text from disk
  'open_web':              0,  // read-only — opens a dashboard view (no destructive action)
  'recall_memory':         0,  // read-only — searches existing memory (recallHybrid), writes nothing
  'persona_status':        0,  // read-only — reports current personality dial settings
  'self_capabilities':     0,  // read-only — reports the boot-generated capabilities manifest
  'document_list':         0,  // read-only — lists ingested documents (doc-level metadata), §7.5
  'document_search':       0,  // read-only — semantic search over ingested document chunks, §7.5, writes nothing
  'search_code':           0,  // read-only — semantic search over indexed code chunks, §7.11, writes nothing
  'phone_list_devices':    0,  // Task 10 (step 6, Android bridge) — read-only, `adb devices -l` via the adapter's own live status

  // T1 — LOCAL WRITES (auto-allow, audit logged)
  'create_goal':           1,
  'propose_goal':          1,  // V5 (Phase 4): creates status:'proposed' only — inert until operator accepts
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
  'browser_wait_for':      1,  // Phase 4 — read-only wait for an element to appear
  'focus_window':          1,
  'pipeline_advance':      1,  // approve only — dangerWhen handles reject
  'gmail_unread':          1,
  'gmail_read':            1,
  'gmail_draft':           1,
  'calendar_upcoming':     1,  // §7.6 — reads private calendar data (Google Calendar,
                               // calendar.readonly scope); same privacy-audit class as
                               // gmail_unread/gmail_read above, not T0 like get_weather
  'reminder_cancel':       1,  // local write — cancels a pending reminder
  'timer_cancel':          1,  // Task 5 (step 5) — same as reminder_cancel above
  'spawn_widget':          1,  // local write — spawns a floating dashboard widget from a
                               // validated data-only spec (Item 11 generative UI)
  'set_persona_level':     1,  // local write — adjusts a personality dial in Identity/persona.json
  'manage_widget':         1,  // local write — hides/shows dashboard widgets (state in browser localStorage)
  'ambient_awareness':     1,  // local toggle — turns the ambient screen-awareness sensor on/off/status
  'daily_plan':            1,  // local write — reads/re-fires/quiets the daily planner's day file
  'document_ingest':       1,  // local write — chunks+embeds an uploaded doc into the vault-backed
                               // Documents store, §7.5; no destructive risk to the source file
  'index_project':         1,  // local write — chunks+embeds source files into the same Documents
                               // store, §7.11; reuses §7.5's index, not a second one
  // Task 10 (step 6, Android bridge) — same privacy-read class as gmail_unread/
  // calendar_upcoming above (screenshot/notifications/contacts read private
  // on-device data).
  'phone_screenshot':      1,
  'phone_notifications':   1,
  'phone_contacts_search': 1,

  // T2 — LOCAL ACTIONS (auto-allow within AUTONOMOUS_MAX_TIER, audit)
  'open_folder':           2,
  'launch_app':            2,
  'open_artifact':         2,  // BUG-008 — opens a file/URL via the OS (cmd start/open/xdg-open),
                               // read-only w.r.t. destructive risk; same category as open_folder/
                               // launch_app above, not the T3 confirm tier. Was previously unmapped
                               // and fell back to tierOf()'s T3 fail-safe.
  'media_key':             2,
  'clipboard_write':       2,  // Task 3 (step 5) — conflict resolution: Task 3's own spec
                               // proposed T1, V2 §7.8 proposed T2. Resolved T2 (the more
                               // conservative of the two, per leash/index.js's check(): T1
                               // and T2 both auto-allow at the default AUTONOMOUS_MAX_TIER=2,
                               // but T2 additionally gates behind AUTONOMOUS_MAX_TIER when an
                               // operator tightens it below 2, T1 never does). Semantically
                               // this silently overwrites OS-level shared clipboard state
                               // readable by every other app on the machine — the same "local
                               // action touching real system state outside MYTHOS's own
                               // store" class as set_volume/media_key above, not the T1 class
                               // of local writes to MYTHOS's own notes/goals/screenshots.
  'set_volume':            2,  // REMEDIATION P1-8 — exact system volume set (0-100), same
                               // risk class as media_key's volume_up/down/mute.
  'get_volume':            0,  // read-only, same class as media_status
  'ask_agent':             2,
  'browser_navigate':      2,
  'browser_tabs':          2,
  'browser_launch_debug':  2,  // Phase 6 — on-demand debug-browser launch, local action, no destructive risk
  'spotify_play_pause':    2,
  'spotify_next':          2,
  'spotify_previous':      2,
  'spotify_volume':        2,
  'spotify_status':        2,
  'send_key':              2,
  'media_status':          0,
  // Re-tiered T3 -> T2 (confirmation-policy pass): these write only to the
  // sandboxed vault/builds/ tree or drive Spotify locally — no destructive or
  // outward-facing risk, so a confirm popup on every "play a song"/"build me
  // a landing page" was pure friction, not safety. See BUGS.md for the audit
  // that identified them; the T3/T4 security-invariant tools below (compose_email,
  // gmail_send, delete_goal, close_window, hermes_task, ui_click, ui_type,
  // click_at, browser_click, browser_type, kill_session, browser_evaluate) are
  // deliberately untouched.
  'spotify_play':          2,
  'spotify_search':        2,
  // RE-TIERED BACK TO T3 (2026-07-29). The T3->T2 reasoning above no longer
  // holds for the build tools: as of the Hermes engine change every one of
  // these drives an external coding agent that runs real commands (Forge sets
  // HERMES_YOLO_MODE=1, which bypasses Hermes's own dangerous-command
  // approval), so "sandboxed to vault/builds/" is no longer a true description
  // of the blast radius. T2 also meant auto-allow under AUTONOMOUS_MAX_TIER —
  // which is how a build launched itself unasked mid-conversation on
  // 2026-07-29 while the user was reporting an unrelated bug. Spotify and the
  // docs-gen tools keep T2; they genuinely are local and bounded.
  'build_project':         3,  // P22 Forge — multi-file build; drives the Hermes CLI
  'revise_project':        3,  // P22 Forge — targeted regen; drives the Hermes CLI
  'pipeline_execute':      3,
  'kanban_assemble':       3,
  'kanban_build_card':     3,
  'start_project':         3,
  'run_mission':           3,
  // Phase 2 docs-gen — sandboxed vault writes under builds/docs/, no destructive risk.
  'generate_spreadsheet':  2,  // .xlsx via exceljs
  'generate_deck':         2,  // .pptx via pptxgenjs
  'generate_pdf':          2,  // .pdf via headless Chrome print-to-pdf; honest HTML fallback when absent
  'generate_image':        2,  // §7.10 — .png via Gemini native image-gen; honest failure when no image data/quota
  // Phase 3 desktop control — non-destructive window ops; right_click/drag are T3 below.
  'move_window':           2,  // non-destructive window move/resize
  'snap_window':           2,  // non-destructive window snap/min/max/restore
  'scroll_at':             2,  // non-destructive wheel scroll at a point
  'show_desktop':          2,  // 2026-07-24 fix sweep (FIX 5) — bulk-minimizes every window,
                               // same non-destructive/reversible risk class as snap_window's
                               // own 'minimize' position; unmapped names fail-safe to T3 via
                               // tierOf(), which would wrongly confirm-gate a danger:false tool.
  'set_wallpaper':         2,  // §7.7 (step 5) — non-destructive, fully reversible local
                               // action (same class as show_desktop/set_volume above),
                               // sandboxed path via from-computer.js's resolveSandboxed
  // Task 10 (step 6, Android bridge) — non-destructive local device actions,
  // same class as launch_app/media_key above: toggling a radio or launching/
  // closing an app is reversible and bounded, no confirm friction warranted.
  'phone_wifi_toggle':      2,
  'phone_bluetooth_toggle': 2,
  'phone_hotspot_toggle':   2,
  'phone_app_launch':       2,
  'phone_app_close':        2,

  // T3 — CONFIRM-ONCE-PER-GOAL (grant recorded, dies with goal)
  'delete_goal':           3,
  'project_status':        0,  // P22 Forge — read-only build status (tier 0; flat table, position cosmetic)
  'compose_email':         3,
  'close_window':          3,
  'gmail_send':            3,
  'ui_click':              3,  // ELEVATED — autonomous typing unpredictable
  'ui_type':               3,  // ELEVATED — same reasoning
  'click_at':              3,  // ELEVATED — autonomous clicking unpredictable
  'right_click_at':        3,  // Phase 3 — autonomous right-click, context menus unpredictable
  'drag':                  3,  // Phase 3 — autonomous drag, drop targets unpredictable
  'browser_click':         3,
  'browser_type':          3,
  'browser_fill_form':     3,  // Phase 4 — autonomous multi-field typing
  'hermes_task':           3,  // P7 — delegates to the hermes-agent sidecar, which runs real commands
  'run_command':           3,  // Phase 3 (V7) — allow-listed shell command; confirm-once-per-goal. v1 is allowlist+timeout, NOT a full sandbox
  'install_from_github':   3,  // clones + installs a GitHub repo; shares run_command's allowlist gate. Runs the
                               // repo's own build hooks (npm postinstall, setup.py), so it is at least as
                               // dangerous as run_command — never map it below T3
  'delete_artifact':       3,  // permanently deletes an artifact file + card (danger:true) — same
                               // unmapped-fail-safe bug class as open_artifact/BUG-008, mapped explicitly
                               // here so it resolves to T3 from the table, not tierOf()'s fail-safe
  // Folder read-write feature: write_file/create_folder/delete_file are the
  // write side of the sandboxed folder tools (list_folder/read_file are T0).
  // T3 (not T4) matches delete_artifact/delete_goal above — leash.check()'s
  // dangerWhen override caps at Math.max(tier,3) regardless, so there is no
  // clean per-call T4 escalation path today (e.g. "T4 only when overwriting an
  // existing file") without touching that shared gating logic; T3 confirm-
  // once-per-goal is the same policy already applied to every other
  // irreversible-but-sandboxed destructive tool.
  'write_file':            3,
  'create_folder':         3,
  'delete_file':           3,
  // Task 4 (step 5, desktop gaps) — move/copy/rename same class as
  // write_file/create_folder/delete_file above (irreversible-in-place inside
  // the sandbox, T3 confirm-once-per-goal); search_files is read-only, T0
  // matching list_folder/read_file.
  'move_file':             3,
  'copy_file':             3,
  'rename_file':           3,
  'search_files':          0,
  // Task 10 (step 6, Android bridge) — outward-facing/irreversible-from-here
  // actions (a real call, an opened-and-prefilled SMS/WhatsApp send needing
  // only a human tap, a write onto the phone's filesystem): T3 confirm-once-
  // per-goal, same class as compose_email/gmail_send/write_file above.
  'phone_sms_send':        3,
  'phone_call':            3,
  'phone_whatsapp_send':   3,
  'phone_file_push':       3,
  // Security-review correction (Task 10): phone_file_pull was originally T1
  // ("a read from the phone"), but from the PC-filesystem-integrity
  // standpoint `adb pull` WRITES (creates or overwrites) an arbitrary local
  // file chosen by resolveSandboxed() — content dictated entirely by
  // whatever the phone has at remotePath. That is the same risk class as
  // write_file (T3), not read_file (T0), and resolveSandboxed()'s
  // allowedRoots() always includes the project root itself. Re-tiered here
  // to match write_file/phone_file_push exactly.
  'phone_file_pull':       3,

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
