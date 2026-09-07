'use strict';

// Canonical Tier Table (Conservative Merge) — MYTHOS-ARCHITECTURE.md §9.
// Keys are tool names as they appear in decision.tool; values are the tier
// (0-4). Every key here is copied verbatim from the spec — do not rename,
// re-tier, or drop any entry without updating the spec first.
const TIER_TABLE = {
  // Desktop wrappers persist task state; all leaves retain independent checks.
  desktop_task_start: 1, desktop_task_status: 0, desktop_task_control: 1,
  browser_video_list: 0, browser_media_state: 0, browser_media_control: 2,
  // T0 — READ ONLY (auto-allow, never audit)
  'navigate':              0,
  'close_panel':           0,
  'read_status':           0,
  // E5: a stateless os.cpus()/totalmem() read of THIS host. Same tier as
  // read_status — it reads, it cannot act, and it touches nothing outside
  // the process. Without an entry here the leash's unknown-tool fail-safe
  // gates it at T3, which would put a confirm prompt in front of "how much
  // RAM does this machine have".
  'read_system_specs':     0,
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
  // think_deeply (2026-08-14) — asks the reasoning lane a question and returns
  // the answer. Touches nothing: no filesystem, no network beyond the same
  // provider chain every other brain call already uses, no world state. Same
  // class as document_answer (also T0, also brain-backed). Without an entry
  // here the unknown-tool fail-safe would gate "think about this" at T3 and put
  // a confirm prompt in front of a question.
  'think_deeply':          0,
  'list_windows':          0,
  // BUG-102: the cua-driver tools had NO entries at all, so tierOf()'s unknown-
  // tool fail-safe put a pure window listing on T3 and voice had to ask for
  // approval mid-troubleshooting. Reads are 0 here; the two acting cua tools sit
  // with their pc-child equivalents further down (focus_window / click_at).
  'cua_list_windows':      0,
  'cua_get_window_state':  0,
  'ui_elements':           0,
  'screen_read_text':      0,  // §7.1 (step 5) — real OCR via Windows.Media.Ocr, read-only
  'browser_get_title':     0,
  'web_search':            0,  // read-only research — fetches public search results
  'web_fetch':             0,  // read-only fetch — retrieves public web page content
  'camera_look':           0,  // read-only — captures and describes camera frame
  // Turning the CAMERA ON is not a read. It is T3-with-confirm and also
  // NEVER_TRUSTABLE (leash/index.js), which together mean it can never
  // auto-allow: not by operator-present trust, not by a session grant, not via
  // TRUSTED_TOOLS. Added 2026-08-10 with camera_look's promotion to the voice
  // allowlist — the point of that promotion is that "can you see me?" gets an
  // honest path, and the point of this tier is that a MISHEARD "can you see me?"
  // cannot open a webcam without the operator saying yes.
  'camera_on':             3,
  'remember':              0,
  'forget_fact':           2,  // BUG-160 — deletes a durable memory: local write, reversible only by re-remembering, so a notch above remember
  'log_incident':          0,
  'list_incidents':        0,  // BUG-171 — read-only replay of the incident log
  'incident_status':       0,  // BUG-171 — appends a status line next to log_incident's own line; same class
  'reminder_add':          0,  // read-only — creates a local reminder record
  'timer_add':             0,  // Task 5 (step 5) — same class as reminder_add above; a
                               // relative-time reminder additionally flagged to ring alertSound
  'reminder_list':         0,  // read-only — lists pending reminders
  'use_skill':             0,  // read-only — loads a skill's guidance text from disk
  'open_web':              0,  // read-only — opens a dashboard view (no destructive action)
  'recall_memory':         0,  // read-only — searches existing memory (recallHybrid), writes nothing
  'suggest_procedures':    0,  // BUG-358: guidance only; individual actions retain their own tiers.
  // Notes (memory/notes.js, 2026-08-14). Reads are T0 like recall_memory /
  // read_file above; note_take is T1 — a local write into MYTHOS's own notes
  // directory, same class as write_note, not the T3 class of write_file (which
  // can reach any sandboxed root, including mythos/.env).
  'note_read':             0,
  'note_search':           0,
  'note_take':             1,
  'persona_status':        0,  // read-only — reports current personality dial settings
  'self_capabilities':     0,  // read-only — reports the boot-generated capabilities manifest
  'document_list':         0,  // read-only — lists ingested documents (doc-level metadata), §7.5
  'document_search':       0,  // read-only — semantic search over ingested document chunks, §7.5, writes nothing
  'document_answer':       0,  // read-only — answers a question grounded in ingested document chunks + cites them, §7.5, writes nothing
  'search_code':           0,  // read-only — semantic search over indexed code chunks, §7.11, writes nothing
  'phone_list_devices':    0,  // Task 10 (step 6, Android bridge) — read-only, `adb devices -l` via the adapter's own live status
  // Task B3 — on-demand self-knowledge digest (host metrics + provider health +
  // spend stats + adapter ONLINE/OFFLINE). Same class as read_system_specs/
  // read_status above: a stateless read of THIS process's own state, no dollar
  // figures, cannot act.
  'system_status':         0,

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
  'browser_snapshot':      1,  // Snapshot-and-refs — reads the page as an a11y tree with element
                               // refs. Read-only, same class as browser_get_text/browser_screenshot;
                               // it changes nothing, it is what the model reads BEFORE deciding what
                               // to change. Gating it would leave the act tools with nothing to aim
                               // at, which is how a model ends up inventing selectors.
  'focus_window':          1,
  'cua_bring_to_front':    1,  // BUG-102 — the cua-driver twin of focus_window
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
  // open_file (2026-08-21): same class as open_folder — hands a path to the
  // shell and shows the operator something. Explicit because an unlisted name
  // falls to the T3 fail-safe, which would confirm-gate every document open.
  'open_file':             2,
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
  'set_app_volume':        2,  // BUG-127 — one app's own Core Audio session volume. Strictly
                               // NARROWER than set_volume (which moves the whole machine), so
                               // it cannot warrant a higher tier than the tool it replaces.
  'get_volume':            0,  // read-only, same class as media_status
  'get_app_volume':        0,  // BUG-161 — read-only twin of set_app_volume, same class as get_volume
  'set_app_mute':          2,  // BUG-161 — one app's own mute flag; same class as set_app_volume
  'ask_agent':             2,
  'browser_navigate':      2,
  'browser_tabs':          2,
  'browser_launch_debug':  2,  // Phase 6 — on-demand debug-browser launch, local action, no destructive risk
  'browser_dismiss_overlays': 2,  // Phase 6 — clicks, so not a read; but only visible controls whose
                               // label is on a bounded dismissal list and only inside a dialog/banner/
                               // fixed overlay, and it reports every element it clicked. Same local,
                               // bounded, non-destructive class as browser_scroll/browser_tabs rather
                               // than the arbitrary-target browser_click.
  'browser_check_captcha': 0,  // Phase 6 — reads the page to see whether a human-verification
                               // challenge is present. Pure read; the ANSWER is "stop and ask the
                               // operator", which is the opposite of an action.
  'browser_switch':        2,  // BUG-107 — disconnects + relaunches, but only a browser MYTHOS itself
                                // launched (never one it merely attached to); routes through
                                // browser_launch_debug internally, same risk class, same tier
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
  // gmail_send, delete_goal, close_window, dsh_task, ui_click, ui_type,
  // click_at, browser_click, browser_type, kill_session, browser_evaluate) are
  // deliberately untouched.
  //
  // BUG-119 (2026-08-06): browser_click, browser_type and browser_fill_form
  // keep their T3 tier here — they were added to leash/index.js's
  // SESSION_GRANTABLE instead, on the operator's explicit approval. That is a
  // narrower change: the first use in a connection still raises a confirm, and
  // an accept then holds for SESSION_GRANT_TTL_MS on that connection and that
  // tool alone. Re-tiering them to T2 would have auto-allowed them everywhere,
  // including the autonomous loop, and was not what was approved.
  'spotify_play':          2,
  'spotify_search':        2,
  // RE-TIERED BACK TO T3 (2026-07-29). The T3->T2 reasoning above no longer
  // holds for the build tools: every one of these drives an external coding
  // agent that runs real commands, so "sandboxed to vault/builds/" is no longer
  // a true description of the blast radius.
  //
  // MECHANISM UPDATED BY W6 (2026-08-22), TIER DELIBERATELY NOT CHANGED. This
  // used to say Forge sets `HERMES_YOLO_MODE=1`, bypassing Hermes's own
  // dangerous-command approval. Under `dsh` the equivalent is
  // `autoApprove: true` -> `DSH_PERMISSION_MODE=workspace-write`, which is a
  // NARROWER grant: writes are confined to the cwd the runner hands it, and
  // `danger-full-access` is never passed. A narrower grant is NOT a reason to
  // re-tier, and the tier is staying at 3 — because the second reason below
  // never depended on the write radius at all. T2 also meant auto-allow under AUTONOMOUS_MAX_TIER —
  // which is how a build launched itself unasked mid-conversation on
  // 2026-07-29 while the user was reporting an unrelated bug. Spotify and the
  // docs-gen tools keep T2; they genuinely are local and bounded.
  'build_project':         3,  // P22 Forge — multi-file build; drives the build-engine CLI
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
  'app_reply':             2,  // WAVE 7 — composes a reply into an already-open chat app's
                               // message box and STOPS. T2 rather than ui_type's T3 because
                               // it cannot send: there is no code path to Enter in
                               // from-app-reply.js, the text stays visible on screen, and the
                               // human closes the loop. Nothing leaves the machine, which is
                               // the same risk class as typing into a local window — and it is
                               // strictly safer than the ui_type it wraps, since it refuses
                               // unless it has proven the caret is in a real editable box.
  // Task 10 (step 6, Android bridge) — non-destructive local device actions,
  // same class as launch_app/media_key above: toggling a radio or launching/
  // closing an app is reversible and bounded, no confirm friction warranted.
  'phone_wifi_toggle':      2,
  'phone_bluetooth_toggle': 2,
  'phone_hotspot_toggle':   2,
  'phone_app_launch':       2,
  'phone_app_close':        2,

  // T3 — CONFIRM-ONCE-PER-GOAL (grant recorded, dies with goal)
  //
  // READ THE TIER TOGETHER WITH leash/index.js's TRUSTED LIST (2026-08-06). T3
  // no longer means "a prompt always fires". A curated set of local, reversible
  // T3 tools below — the browser interaction tools, ui_click/ui_type/click_at/
  // see_and_click/cua_click, and close_window — auto-allows with NO confirm when
  // a real operator connection is driving (voice or the Live session), audited
  // as 'operator-present-trusted'. Anything acting on its own passes no
  // connectionId and still confirms for the very same tools, so the tier here is
  // still exactly right for the autonomous path. Do not "simplify" any of them
  // to T2 on the strength of that trust: T2 auto-allows for the autonomous loop
  // too, which is the mistake documented in the build-tool re-tier note above.
  // leash/index.js's NEVER_TRUSTABLE pins which T3 entries can never be trusted.
  'delete_goal':           3,
  'project_status':        0,  // P22 Forge — read-only build status (tier 0; flat table, position cosmetic)
  'compose_email':         3,
  'close_window':          3,
  'gmail_send':            3,
  'ui_click':              3,  // ELEVATED — autonomous typing unpredictable
  'ui_type':               3,  // ELEVATED — same reasoning
  'click_at':              3,  // ELEVATED — autonomous clicking unpredictable
  'cua_click':             3,  // BUG-102 — same blast radius as click_at above
  // Same blast radius as click_at: it ends in a real mouse click at a real
  // coordinate. Reading the screen first makes it better AIMED, not safer.
  'see_and_click':         3,
  'right_click_at':        3,  // Phase 3 — autonomous right-click, context menus unpredictable
  'drag':                  3,  // Phase 3 — autonomous drag, drop targets unpredictable
  'browser_click':         3,
  'browser_type':          3,
  'browser_fill_form':     3,  // Phase 4 — autonomous multi-field typing
  // Snapshot-and-refs toolkit (2026-08-06). Same tier as their siblings above:
  // each one drives the operator's REAL logged-in browser, so each is a T3
  // confirm the first time and session-grantable thereafter per BUG-119.
  'browser_upload_file':   3,  // reads a file off disk and hands it to a web page — the
                               // widest blast radius here, additionally confined to the
                               // operator-configured BROWSER_UPLOAD_DIR at the effector
                               // (a tier alone would not stop a path outside it)
  'browser_select_option': 3,  // sets a form value, same class as browser_type
  'browser_press_key':     3,  // Enter submits forms; allowlisted keys only, no free text
  'browser_hover':         1,  // reveals a menu, changes nothing — read-shaped, same class
                               // as browser_scroll
  'dsh_task':              3,  // delegates to the build engine (DeepSeek Harness), which runs real commands
  'run_command':           3,  // Phase 3 (V7) — allow-listed shell command; confirm-once-per-goal. v1 is allowlist+timeout, NOT a full sandbox
  'install_from_github':   3,  // clones + installs a GitHub repo; shares run_command's allowlist gate. Runs the
                               // repo's own build hooks (npm postinstall, setup.py), so it is at least as
                               // dangerous as run_command — never map it below T3
  // MCP transport (effectors/from-mcp.js). The listing tools are read-only;
  // mcp_call_tool is T3 and must never drop below it. An MCP server runs with
  // the operator's own privileges and MYTHOS's guards — RUN_COMMAND_ALLOWLIST,
  // allowedRoots, the shell-metachar reject — apply to MYTHOS's effectors, NOT
  // to a call routed through this transport. Desktop Commander's write_file
  // reaches the whole disk; browser-use's tools drive a real browser. So the
  // tier is the only gate, and it is deliberately the same as run_command's.
  'mcp_list_servers':      0,
  'mcp_list_tools':        0,
  'mcp_call_tool':         3,
  // Open Knowledge Format (effectors/from-okf.js). Reading a bundle is inert.
  // Writing one creates files, so it sits with generate_spreadsheet/
  // generate_deck at T2 rather than T0 — sandboxed under vault/Knowledge, but
  // still a real write the operator should see.
  'okf_list':              0,
  'okf_import':            0,
  'okf_export':            2,
  // Strix security scanning (effectors/from-strix.js). Runs a real autonomous
  // pentest against a target. T3 (confirm-once-per-goal), and the effector adds
  // a hard authorization gate on top: no `authorized_by`, no run. Never below
  // T3 — same class as run_command/install_from_github.
  'security_scan':         3,
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
  // WhatsApp from the DESKTOP app. Strictly more consequential than its phone
  // sibling above: phone_whatsapp_send only pre-fills and waits for a human tap,
  // whereas this one presses Enter, so the message actually leaves. A message
  // sent to the wrong human is not recoverable — T3, never auto-allowed.
  'whatsapp_send':         3,
  // Names only, no numbers, no side effects.
  'whatsapp_contacts':     0,
  // Writes a phone number into the vault that whatsapp_send will later message
  // without asking again — a wrong digit here misdirects every future message to
  // that name, so it is confirmed once at save time rather than silently accepted.
  'whatsapp_contact_save': 3,
  // Wave 4 (2026-08-13): destructive by nature (removes the ability to
  // message someone by name) — same T3 as the save it undoes, never
  // auto-allowed.
  'whatsapp_contact_delete': 3,
  // Security-review correction (Task 10): phone_file_pull was originally T1
  // ("a read from the phone"), but from the PC-filesystem-integrity
  // standpoint `adb pull` WRITES (creates or overwrites) an arbitrary local
  // file chosen by resolveSandboxed() — content dictated entirely by
  // whatever the phone has at remotePath. That is the same risk class as
  // write_file (T3), not read_file (T0), and resolveSandboxed()'s
  // allowedRoots() always includes the project root itself. Re-tiered here
  // to match write_file/phone_file_push exactly.
  'phone_file_pull':       3,
  // Task B5 (fire-action field) — approving is the single human-confirm
  // moment that grants the reminder's own outward-facing action tool
  // (goals.grantTier, tool-scoped array only — never tier-wide) so it can
  // fire later unattended. T3 means leash.check() always requires a confirm
  // for THIS call (it never carries a prior grant naming itself), matching
  // "approve-a-plan-once, not approve-each": one confirm here, zero at fire
  // time. Never lower this tier — that would let a reminder's action grant
  // itself with no human in the loop.
  'reminder_approve_action': 3,

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
