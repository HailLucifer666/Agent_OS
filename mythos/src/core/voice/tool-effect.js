'use strict';

// tool-effect.js — "does this tool change anything?", asked of every tool.
//
// OPERATOR DECISION D10, 2026-10-06. Read-only tools stay on the fast (Live)
// voice lane; everything else is answered by the validated text lane. "Read-only"
// is this file's question, NOT the leash tier. The leash tiers stay exactly as
// they are, because a tier answers a different question (how much confirmation
// an action needs) and re-tiering changes what the safety layer does.
//
// WHY THE TIER CANNOT ANSWER IT. tiers.js heads its tier-0 block "T0 — READ
// ONLY", and that label is false for ten of its 62 entries (listed under CHANGES
// below with what each changes): `remember` writes permanent memory, so a rule of
// "tier 0 stays fast" would reopen BUG-464's door. The design named six;
// classifying every entry found incident_status (appends a status line),
// mcp_list_tools (starts the MCP server if it is not running), navigate and
// close_panel (change the HUD) as well.
//
// THE RULE APPLIED. A tool is a READ when running it leaves nothing changed
// outside MYTHOS's own reply: no file, record, memory, setting, window, page,
// device, process or message. Network fetches and model calls that only return
// text are reads. A tool with several modes, any of which changes something
// (browser_tabs, daily_plan, ambient_awareness), is CHANGES: the call is judged
// before its mode is known to be harmless. Unsure means CHANGES — the cost of a
// wrong CHANGES is a slower answer, the cost of a wrong READ is an action taken
// on the fast lane.
//
// THE SET IS NOT HAND-KEPT HERE. This file holds the judgement per tool. Which
// tools must be judged is derived by test/tool-effect-classification.test.js
// from the leash's tier table and the Live catalog, so a new tool fails the suite
// until it is classified, and a removed one fails it until it is deleted here.
//
// NOT COVERED. This is classification only. Using it to pick the fast set (and
// subtracting evidence, web-lookup and memory tools, think_deeply and use_skill)
// is commit C4 of the validated-speech design; routing on it is C5.

const READS = Object.freeze([
  // tier 0
  'browser_check_captcha', 'browser_get_title', 'browser_media_state', 'browser_video_list',
  'camera_look', 'clipboard_read', 'commitment_list', 'cua_get_window_state', 'cua_list_windows',
  'desktop_task_status', 'document_answer', 'document_list', 'document_search', 'get_app_volume',
  'get_directions', 'get_time', 'get_volume', 'get_weather', 'job_status', 'kanban_status',
  'list_folder', 'list_goals', 'list_incidents', 'list_windows', 'mcp_list_servers', 'media_status',
  'mission_status', 'note_read', 'note_search', 'okf_list', 'persona_status', 'phone_list_devices',
  'pipeline_status', 'project_status', 'read_file', 'read_status', 'read_system_specs',
  'recall_memory', 'reminder_list', 'resume_interrupted_answer', 'screen_read_text', 'search_code',
  'search_files', 'self_capabilities', 'suggest_procedures', 'system_status', 'think_deeply',
  'ui_elements', 'use_skill', 'web_fetch', 'web_search', 'whatsapp_contacts',
  // tier 1
  'browser_get_text', 'browser_snapshot', 'browser_wait_for', 'calendar_upcoming', 'gmail_read',
  'gmail_unread', 'phone_contacts_search', 'phone_notifications', 'screen_look',
  // tier 2
  'spotify_search', 'spotify_status',
]);

const CHANGES = Object.freeze({
  // tier 0 — the entries the "READ ONLY" heading mislabels
  remember: 'writes a permanent fact into memory (BUG-464)',
  reminder_add: 'creates a reminder record',
  timer_add: 'creates a timer record',
  log_incident: 'writes an incident record',
  incident_status: 'appends a status line to an incident',
  okf_import: 'imports records into the vault',
  open_web: 'opens a dashboard card or the default browser',
  navigate: 'changes the HUD view',
  close_panel: 'closes a HUD panel',
  mcp_list_tools: 'starts the MCP server when it is not running',
  // tier 1
  desktop_task_start: 'starts a desktop task',
  desktop_task_control: 'pauses, resumes or stops a desktop task',
  commitment_dismiss: 'marks a commitment dismissed',
  note_take: 'writes a note',
  create_goal: 'creates a goal',
  propose_goal: 'creates a proposed goal',
  toggle_goal: 'changes a goal status',
  capture_idea: 'writes an idea record',
  kanban_add_card: 'adds a kanban card',
  kanban_move_card: 'moves a kanban card',
  write_note: 'writes a note',
  capture_screenshot: 'saves a PNG into the vault',
  browser_screenshot: 'captures the page; treated as changing until shown to write nothing',
  browser_scroll: 'scrolls the page',
  browser_go_back: 'navigates the page back',
  browser_hover: 'moves the pointer over the page, which can trigger page effects',
  focus_window: 'brings a window to the front',
  cua_bring_to_front: 'brings a window to the front',
  pipeline_advance: 'advances a pipeline stage',
  gmail_draft: 'saves an email draft',
  reminder_cancel: 'cancels a reminder',
  timer_cancel: 'cancels a timer',
  spawn_widget: 'spawns a dashboard widget',
  set_persona_level: 'changes a personality setting',
  manage_widget: 'hides or shows widgets',
  ambient_awareness: 'turns the ambient screen sensor on or off',
  daily_plan: 'can re-run or quiet the daily planner',
  document_ingest: 'adds a document to the store',
  index_project: 'indexes files into the store',
  phone_screenshot: 'captures the phone screen; treated as changing until shown to write nothing',
  // tier 2
  browser_media_control: 'plays, pauses or seeks page media',
  forget_fact: 'deletes a memory fact',
  open_folder: 'opens a folder window',
  open_file: 'opens a file in an app',
  launch_app: 'launches an application',
  open_artifact: 'opens an artifact',
  media_key: 'sends a media key',
  clipboard_write: 'writes the clipboard',
  set_volume: 'changes the system volume',
  set_app_volume: 'changes an app volume',
  set_app_mute: 'mutes or unmutes an app',
  ask_agent: 'runs another agent seat; treated as changing',
  browser_navigate: 'navigates the browser',
  browser_tabs: 'can open, close or switch tabs',
  browser_launch_debug: 'launches a debug browser',
  browser_dismiss_overlays: 'clicks page overlays away',
  browser_switch: 'switches the controlled browser',
  spotify_play_pause: 'changes playback',
  spotify_next: 'changes the track',
  spotify_previous: 'changes the track',
  spotify_volume: 'changes Spotify volume',
  spotify_play: 'starts playback',
  send_key: 'sends a keystroke',
  generate_spreadsheet: 'writes a file',
  generate_deck: 'writes a file',
  generate_pdf: 'writes a file',
  generate_image: 'writes a file',
  move_window: 'moves a window',
  snap_window: 'snaps a window',
  scroll_at: 'scrolls under the pointer',
  show_desktop: 'minimises windows',
  set_wallpaper: 'changes the wallpaper',
  app_reply: 'replies inside an app',
  phone_wifi_toggle: 'toggles phone Wi-Fi',
  phone_bluetooth_toggle: 'toggles phone Bluetooth',
  phone_hotspot_toggle: 'toggles the phone hotspot',
  phone_app_launch: 'launches a phone app',
  phone_app_close: 'closes a phone app',
  okf_export: 'writes an export file',
  // tier 3
  camera_on: 'turns the webcam on',
  build_project: 'builds a project',
  revise_project: 'revises a project',
  pipeline_execute: 'runs a pipeline',
  kanban_assemble: 'assembles kanban work',
  kanban_build_card: 'builds a kanban card',
  start_project: 'starts a project',
  run_mission: 'runs a mission',
  delete_goal: 'deletes a goal',
  compose_email: 'composes an email',
  close_window: 'closes a window',
  gmail_send: 'sends an email',
  ui_click: 'clicks',
  ui_type: 'types',
  click_at: 'clicks',
  cua_click: 'clicks',
  see_and_click: 'clicks',
  right_click_at: 'right-clicks',
  drag: 'drags',
  browser_click: 'clicks the page',
  browser_type: 'types into the page',
  browser_fill_form: 'fills a form',
  browser_upload_file: 'uploads a file',
  browser_select_option: 'selects an option',
  browser_press_key: 'presses a key in the page',
  dsh_task: 'runs the build engine',
  run_command: 'runs a command',
  install_from_github: 'installs software',
  mcp_call_tool: 'runs an MCP tool',
  security_scan: 'runs a scanner',
  delete_artifact: 'deletes an artifact',
  write_file: 'writes a file',
  create_folder: 'creates a folder',
  delete_file: 'deletes a file',
  move_file: 'moves a file',
  copy_file: 'copies a file',
  rename_file: 'renames a file',
  phone_sms_send: 'sends an SMS',
  phone_call: 'places a call',
  phone_whatsapp_send: 'sends a WhatsApp message',
  phone_file_push: 'writes a file to the phone',
  phone_file_pull: 'writes a local file',
  whatsapp_send: 'sends a WhatsApp message',
  whatsapp_contact_save: 'saves a contact',
  whatsapp_contact_delete: 'deletes a contact',
  reminder_approve_action: 'grants a reminder its action',
  // tier 4
  kill_session: 'kills a process',
  browser_evaluate: 'runs script in the page',
});

const READ_SET = new Set(READS);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// Unknown or unclassified means "changes something": fail closed.
function changesAnything(tool) {
  return !READ_SET.has(tool);
}

function unclassifiedTools(tools) {
  return [...new Set(tools)].filter((t) => !READ_SET.has(t) && !has(CHANGES, t)).sort();
}

module.exports = { READS, CHANGES, changesAnything, unclassifiedTools };
