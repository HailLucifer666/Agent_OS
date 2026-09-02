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
const { checkToolCapability } = require('./tool-capability');

// Function-calling accuracy degrades with very large tool sets, and MYTHOS registers
// well over a hundred tools (exact figure: scripts/sync-test-count.js — never pin the
// number here; a pinned count is stale the moment an effector lands).
// This is the curated high-traffic default; override with LIVE_TOOL_ALLOWLIST.
const DEFAULT_ALLOWLIST = [
  'navigate','close_panel','read_status','read_system_specs','open_web',
  // Task B3 — on-demand "how's the system" mid-conversation: host metrics,
  // provider health, spend stats, adapter status in one read-only call.
  'system_status',
  // 2026-08-14 (BUG-222): promoted out of VOICE_ALLOWLIST_EXEMPT, on this
  // list's own stated criterion — "promote an entry the day a session actually
  // needs it from voice". That day arrived, twice over, in one session.
  //
  // The exemption's reasoning was that "read_status/self_capabilities-style
  // summaries cover these; not a distinct spoken verb of their own". Both
  // halves were wrong. read_status reports RUNTIME state (goals, adapters,
  // spend); it has never carried the tool catalog. And "what can you do?" is
  // about as distinct a spoken verb as exists — the operator asked it, and,
  // with no tool able to answer, the model fell back to describing web_search
  // over and over. This is the withheld-read-tool shape the camera_look and
  // whatsapp_send comments above already document, aimed at the one tool whose
  // whole job is knowing what every other tool is.
  //
  // It is also the ONLY route to "what changed / what did you fix?".
  // identity/capabilities.js regenerates vault/Identity/capabilities.md every
  // boot from the live hub catalog, adapter states and RECENT GIT CHANGES, so
  // the honest answer already exists on disk at every boot — it just had no
  // reader on the voice surface. T0, read-only, no act-side sibling to pair.
  'self_capabilities',
  'create_goal','list_goals','toggle_goal','delete_goal',
  'capture_idea','pipeline_status','pipeline_advance',
  'kanban_status','kanban_add_card','kanban_move_card',
  'start_project','build_project','project_status','job_status','open_artifact',
  // BUG-267 (2026-09-02) — NAMED IN THE PROMPT, NEVER DECLARED. The ticket
  // named one instance (use_skill, already promoted on 2026-08-21) and the
  // reason it gave — "the spoken surface is told to call a function that was
  // never declared to it" — covers a wider set. Deriving that set from the
  // reason instead of from the ticket found three more, and both of these:
  //
  //   mission_status  RULES' INFORMATIONAL TOOLS RULE lists it among the
  //     read-only lookups the model must "call in the SAME turn the user asks"
  //     — beside read_status, list_goals, job_status, pipeline_status,
  //     kanban_status, get_time and get_weather, every one of which IS declared.
  //     T0, read-only. It was the only name in its own sentence that the
  //     spoken surface could not reach.
  //   run_mission  RULES' AFFIRMATION RESOLUTION RULE names it beside
  //     start_project and build_project, both declared. T3 AND NEVER_TRUSTABLE,
  //     so declaring it changes nothing about safety: the leash demands an
  //     explicit confirm on every call and cannot be talked out of it.
  //     start_project is the precedent — also NEVER_TRUSTABLE, also declared.
  'mission_status','run_mission',
  'get_time','get_weather','get_directions','web_search','web_fetch',
  // BUG-171: list_incidents/incident_status are the read + close half of
  // log_incident. Allowlisting the write without them is exactly the
  // read-tool-missing-next-to-its-act-tool shape this list has been bitten by
  // before — and it is what made Incidents/ a place reports went to die.
  'remember','forget_fact','log_incident','list_incidents','incident_status','recall_memory',
  // Notes (2026-08-14). All three ship together, act tool WITH both its read
  // tools, per this list's own rule: a withheld read tool next to an act tool
  // does not make the model decline, it makes it substitute the nearest
  // reachable tool and narrate the result (the camera_look/screen_look
  // incident). Without note_read/note_search, "what's in my project note"
  // would reach remember/recall_memory — MYTHOS's own asserted facts — and be
  // reported as the operator's note.
  'note_take','note_read','note_search',
  // 2026-08-14 (BUG-219, the butter-chicken session). The operator asked MYTHOS to
  // type a recipe into Notepad and save it. ctrl+s is unwinnable on MSIX Notepad —
  // proven, narrow, and NOT fixable from this side (adapters/CLAUDE.md: do not add
  // more UIA rungs) — so the model spent five minutes on ctrl+s and four File-menu
  // clicks, then closed the window and lost the text. It never had a tool that
  // could put content at a path the operator named.
  //
  // note_take (above) already covers "write this down", but it owns the filename:
  // it derives one from the title and writes into the notes vault. "Save it as
  // butter-chicken.txt on my desktop" is a different request, and until now it was
  // not expressible on the voice surface at all — write_file was in NEITHER list,
  // which is drift rather than a curation decision.
  //
  // read_file comes with it rather than staying exempt, per this list's own
  // any-act-tool-ships-with-its-read-tool rule: without it the model can write a
  // file and has no way to confirm what landed, which is the shape that produces
  // narrated guesses (see the ui_elements and camera_look comments). write_file is
  // T3/danger and stays operator-confirmed at the leash — this promotion changes
  // what is REACHABLE, not what is permitted.
  'write_file','read_file',
  // think_deeply (2026-08-14). This one is not a drift fix — the tool was built
  // FOR this list. The Live conversation model is capped at Flash tier on a free
  // key (all six bidiGenerateContent models are Flash; Pro Live is 404) and
  // live-session.js / live-tool-adapter.js make ZERO brain.think calls, so no
  // amount of lane re-ranking can improve a spoken answer. Delegating to the
  // reasoning lane through a tool is the only mechanism that exists, and it is
  // worth nothing if the tool is unreachable from the surface that needs it.
  // T0, read-only, no act-side sibling to pair.
  'think_deeply',
  // 2026-08-13: timer_add/timer_cancel joined this line from
  // VOICE_ALLOWLIST_EXEMPT. They were exempt as "not yet asked for in a live
  // session" — but commit 0bd8408 then rewrote reminder_add's description to say
  // "Do NOT use this for a timer ... use timer_add for those instead; it rings,
  // this tool never does", and timer_add's to say "Use this — never
  // reminder_add — for ANY 'set a timer for N minutes'". On the voice surface
  // timer_add did not exist, so a spoken "set a timer for 5 minutes" reached a
  // model that had been told the only tool it could see was the wrong one. This
  // list's own rule (a read/act pair is promoted together, never split) applies
  // just as much to a pair where one tool's description mandates the other:
  // naming an unreachable tool is not a remedy, it is a dead end with a hint.
  'reminder_add','reminder_list','reminder_cancel','reminder_approve_action',
  'timer_add','timer_cancel',
  'gmail_unread','gmail_read','gmail_draft','gmail_send',
  // spotify_previous was missing while spotify_next was present — "go back" /
  // "last song" had no tool, the exact read/act-sibling asymmetry this list
  // keeps being bitten by (whatsapp_send, ui_elements, cua_bring_to_front).
  'spotify_play','spotify_play_pause','spotify_next','spotify_previous','spotify_volume','spotify_status',
  // 2026-08-09 (inc-1786236236673-2): snap_window is T2, fully implemented from
  // PowerShell (ShowWindow SW_MINIMIZE) up through effector and tier table, and
  // was on NEITHER list — pure drift, not curation. With no minimize tool at all
  // the Live model improvised `send_key win+down`, which reported success and
  // did nothing. close_window was reachable the whole time, which is what made
  // the gap look like a broken tool rather than a missing one. move_window is
  // its exact-rectangle sibling and ships in the same commit for the same reason.
  'media_status','launch_app','focus_window','list_windows','close_window','snap_window','move_window',
  // "show desktop" / "minimize everything" — same window-management verb family,
  // and the only tool that does it in one call.
  'show_desktop',
  // open_folder's own description says it "is the ONLY way to open a folder —
  // never pass a path to launch_app". launch_app is reachable and this was not,
  // so that instruction pointed at a tool the model could not call: the BUG-099
  // "a hint naming an unreachable tool is not a remedy" shape.
  'open_folder',
  // System volume, act + read together. spotify_volume's description ends "For
  // the SYSTEM volume use set_volume instead" and media_key's says "for an exact
  // target level use set_volume" — two reachable tools handing the model an
  // unreachable remedy. get_volume comes with it as the read oracle rather than
  // staying exempt, per this list's own any-act-tool-ships-with-its-read-tool rule.
  'set_volume','get_volume','media_key',
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
  // Wave 4 (2026-08-13): whatsapp_contact_delete is the destructive sibling of
  // whatsapp_contact_save (both T3, same reasoning) — omitting it left Live
  // able to save a bad contact but never remove one.
  'whatsapp_send','whatsapp_contacts','whatsapp_contact_save','whatsapp_contact_delete','app_reply',
  'screen_look','screen_read_text','capture_screenshot',
  // The webcam pair, promoted out of VOICE_ALLOWLIST_EXEMPT on 2026-08-10 after
  // the incident that list's own comment invited ("promote if usage shows up").
  //
  // What withholding camera_look actually produced: the operator asked "can you
  // see me?" and, with no camera tool in reach, the model called screen_look with
  // query "Can I see the operator through the webcam?" — a DESKTOP capture aimed
  // at a webcam question. It then described the HUD's own camera-preview panel
  // inside that screenshot, concluded it could see the operator, contradicted its
  // own correct "I can't get a live video feed" from thirty seconds earlier, and
  // went on to invent "a black smartphone" and "a small dog" for "what am I
  // holding?". Withholding a read tool did not make the model decline; it made it
  // substitute the nearest reachable tool and narrate the result. Same lesson as
  // browser_snapshot and whatsapp_send above, now with a camera attached.
  //
  // camera_on is the confirm-gated opener (T3, NEVER_TRUSTABLE — see leash/
  // tiers.js and leash/index.js): "can you see me" with the camera off must be
  // able to ASK, not silently fail. It can never auto-allow, so a misheard
  // utterance cannot open a webcam.
  'camera_look','camera_on',
  'browser_navigate','browser_click','browser_type','browser_get_text',
  // BUG-267 (2026-09-02), third instance of the same omission. RULES' BROWSER
  // INTERACTION RULE says in as many words: "Pass that ref to browser_click,
  // browser_type or browser_fill_form" — and only the third was undeclared, so
  // the one tool the rule names for job-application forms was the one the
  // spoken surface could not call. Same tier (3), same SESSION_GRANTABLE and
  // operator-present-trusted status as the two beside it, so there is no safety
  // property that distinguishes it from them.
  'browser_fill_form',
  // Snapshot-and-refs (2026-08-06). browser_snapshot is the READ half of every
  // browser interaction: the model takes a snapshot, sees the page as an
  // accessibility tree with element refs, and acts on a ref instead of guessing
  // a CSS selector. This repo has already learned that omitting a read tool
  // next to its act tools makes the model invent the act tool's inputs — which
  // is precisely the guessed-selector failure mode the whole snapshot design
  // exists to end. It ships allowlisted in the same commit as the tool.
  'browser_snapshot',
  // The rest of the interaction surface, same reasoning: the model can only use
  // what it can reach. Without these, "fill out this job application" degrades
  // to typing into whatever has focus and hoping — the exact improvisation
  // BUG-110 and the whatsapp_send gap were both about.
  'browser_upload_file','browser_select_option','browser_press_key','browser_hover',
  // Obstacles. browser_check_captcha in particular has to be reachable: the
  // model can only STOP at a challenge it is able to detect, and a bypass
  // attempt on the operator's own logged-in browser is how real accounts get
  // banned.
  'browser_dismiss_overlays','browser_check_captcha',
  // BUG-099: browser_navigate can now refuse a wrong-browser request and tell
  // the model to "call browser_launch_debug with browser:brave" — an instruction
  // it could not follow, because the launcher was not reachable from this path.
  // browser_get_title is its read oracle (which page is actually here), and
  // browser_tabs is what the 2026-08-05 session needed and did not have when the
  // operator asked to clean up a stray YouTube tab.
  'browser_launch_debug','browser_get_title','browser_tabs',
  // BUG-107: the wrong-browser refusal above ("attached to Brave, not Chrome")
  // was a correct-but-dead-end message with no remedy the model could act on.
  // browser_switch IS that remedy (disconnect + close the MYTHOS-launched
  // browser + launch the requested one); withholding it here would leave
  // checkBrowserTarget's own advice ("call browser_switch") unfollowable —
  // the same "a hint naming an unreachable tool is not a remedy" gap BUG-099
  // fixed for browser_launch_debug.
  'browser_switch',
  'set_persona_level','ask_agent',
  // 2026-08-21 capability audit — operator decision: "promote everything
  // usable"; machinery-absent and never-exercised tools stay withheld.
  //
  // Measured demand from Audit/*.jsonl, not assumed: use_skill 14 calls,
  // list_folder 4, create_folder 2 — and user-facts records the operator
  // being told "the planned file management capability to create folders
  // also failed". The rest of the family had 0 calls and is promoted on the
  // symmetry rule this file already states below: "promoting one alone is
  // what creates the gaps this file documents". A session that can create a
  // folder but cannot rename it is the same read/act asymmetry read_file vs
  // write_file already cost us.
  //
  // NOT a drift repair. create_folder/move_file/copy_file/rename_file are T3,
  // and allowlist-reachability.test.js deliberately stops at T2 — absence
  // from both lists is the NORMAL state for a confirm-gated tool, so the
  // "in neither list" observation is curation working, not BUG-110 drift.
  // Reachability is not permission: the leash still confirm-gates every T3
  // call, exactly as it already does for the allowlisted write_file,
  // gmail_send and whatsapp_send.
  'list_folder','search_files','create_folder','move_file','copy_file','rename_file',
  'clipboard_read','clipboard_write',
  // calendar_upcoming: 0 calls, but tool-capability.js already gates every
  // calendar_* name on googleOAuth, so while the refresh token is dead it is
  // withheld as UNAVAILABLE with a named reason rather than answering wrongly.
  // Promoting it now means it appears the moment the OAuth app is published,
  // instead of needing a second edit nobody remembers to make.
  'calendar_upcoming',
  // use_skill: 14 calls all-time. The exemption called it "internal/debugging
  // surface", which the call log contradicts outright.
  'use_skill',
  // open_file (2026-08-21): the demand evidence is the 2026-08-20 transcript —
  // "open the file you were just discussing" — answered with "I can't access
  // the...", because no verb existed. A new verb is useless if the model cannot
  // see it, so it is declared in the same change that adds it.
  'open_file',
];

// BUG-110/BUG-177: a T0/T1/T2 (auto-allow) effector missing
// from BOTH this list and DEFAULT_ALLOWLIST is a silent voice-reachability
// gap of get_directions's exact shape -- test/allowlist-reachability.test.js
// fails loudly if one appears. Since 2026-08-09 that gate also covers T2 (see
// BUG-177 / snap_window). Each group below is a deliberate
// curation choice (the tool-count/accuracy tradeoff noted above), not an
// oversight; promote an entry to DEFAULT_ALLOWLIST the day a session actually
// needs it from voice.
const VOICE_ALLOWLIST_EXEMPT = [
  // Sandboxed folder/file/clipboard reads -- desktop power-user surface, not
  // asked for in normal conversation; their write-side siblings are already T3.
  // clipboard_write (T2) joins its read here for the same reason and to keep the
  // pair symmetric: promoting one alone is what creates the gaps this file
  // documents. (open_folder was in this family and was promoted on 2026-08-09 --
  // see its comment in DEFAULT_ALLOWLIST.)
  // (read_file left this group on 2026-08-14: write_file became reachable, and a
  // write with no read-back is the asymmetry this whole file is a monument to.)
  // (this group LEFT on 2026-08-21 — list_folder/search_files/clipboard_read/
  // clipboard_write are now in DEFAULT_ALLOWLIST with the file-management
  // writes, see that entry. The group is empty rather than deleted so the
  // reasoning above stays readable next to what overturned it.)
  // Status/introspection singletons -- read_status-style summaries cover these;
  // not a distinct spoken verb of their own.
  // (get_volume left this group on 2026-08-09: it is set_volume's read oracle,
  // and set_volume became reachable. self_capabilities left it on 2026-08-14 —
  // see its DEFAULT_ALLOWLIST entry; the claim that read_status covered it was
  // simply false, and it is the only reader of the boot-written capabilities
  // manifest.)
  // (mission_status left this group on 2026-09-02, BUG-267. The claim above —
  // "read_status-style summaries cover these" — is the same claim that was made
  // for self_capabilities and was simply false, and here RULES' own
  // INFORMATIONAL TOOLS RULE names mission_status in a list of lookups the
  // model must call in the same turn it is asked, beside seven siblings that
  // were all declared. A tool the prompt instructs by name is not covered by
  // another tool's summary. It was on BOTH lists for the length of one commit
  // and two guards caught it — this file's own both-lists sanity check and the
  // 2026-08-21 curation audit's.)
  'persona_status',
  // BUG-161: get_app_volume is the read oracle set_app_volume/spotify_volume
  // call internally to step a per-app level through a read-back. Neither of
  // its act-side siblings (set_app_volume, set_app_mute) is on the voice
  // allowlist either — "turn Spotify down" reaches this machinery through
  // spotify_volume — so exempting it creates no read/act asymmetry of the
  // kind this repo has been bitten by. Promote all three together the day a
  // session actually asks to set a non-Spotify app's volume by voice.
  // set_app_volume/set_app_mute are the act siblings that comment already names.
  // All three stay together: promoting one without the others is what creates a
  // read/act asymmetry, and "turn Spotify down" reaches this machinery through
  // spotify_volume today. System-wide volume is set_volume, which IS reachable.
  'get_app_volume','set_app_volume','set_app_mute',
  // (use_skill LEFT on 2026-08-21. It was exempted as "internal/debugging
  // surface"; the audit counted 14 real calls, so that framing was simply
  // wrong. See its DEFAULT_ALLOWLIST entry.)
  // (timer_add/timer_cancel LEFT this group on 2026-08-13 — not because usage
  // showed up, but because reminder_add's description now redirects the model to
  // timer_add by name, and it was not reachable. See their DEFAULT_ALLOWLIST
  // entry. camera_look left the same group on 2026-08-10.)
  // Documents/code-search (§7.5, §7.11) -- opt-in power feature with its own
  // UI surface, not curated into the default voice set.
  'document_list','document_search','document_answer','document_ingest',
  'search_code','index_project',
  // MCP transport listing -- introspection for an optional, often-empty
  // MCP_SERVERS config; mcp_call_tool itself is T3 and correctly absent here.
  'mcp_list_servers','mcp_list_tools',
  // Open Knowledge Format bundle tools -- not a spoken verb.
  'okf_list','okf_import','okf_export',
  // Android bridge (Task 10, step 6) -- debugging/status reads AND device
  // controls for an optional adapter, not yet part of the curated voice surface.
  // The whole group moves together the day the phone adapter is curated in.
  'phone_list_devices','phone_screenshot','phone_notifications','phone_contacts_search',
  'phone_app_launch','phone_app_close','phone_wifi_toggle','phone_bluetooth_toggle','phone_hotspot_toggle',
  // Artifact generation (image/deck/pdf/spreadsheet) -- long-running producers
  // with their own HUD/Forge surface and their own artifact plumbing; a spoken
  // "make me a deck" belongs to a goal/build flow, not a one-shot Live call.
  // generate_image is the likeliest first promotion if a session asks for it.
  'generate_image','generate_deck','generate_pdf','generate_spreadsheet',
  // Desktop cosmetics -- not conversational.
  'set_wallpaper',
  // Wheel-scroll at a coordinate. click_at/see_and_click/ui_click cover the
  // curated pointer surface; scrolling a results list by voice is precisely the
  // wandering behaviour the 2026-08-09 Spotify incident was about, so this stays
  // off the voice surface deliberately rather than by oversight.
  'scroll_at',
  // spotify_play already searches AND plays, and (since 2026-08-09) takes the
  // literal first result. A bare search returns text the model would then have
  // to act on in a second step -- the two-step dance is what produced the
  // wrong-track probing, so the read half stays off voice on purpose.
  'spotify_search',
  // Dashboard/system writes with their own UI (kanban/widgets/daily brief) --
  // reachable through the HUD; withheld from voice to keep the tool count down.
  'write_note','spawn_widget','manage_widget','ambient_awareness','daily_plan',
  // Browser helper reads not curated alongside the browser_* set above.
  'browser_screenshot','browser_scroll','browser_go_back','browser_wait_for',
  // (calendar_upcoming LEFT on 2026-08-21 — see DEFAULT_ALLOWLIST. The BUG-104
  // "read with no companion action" worry is now handled one layer down:
  // tool-capability.js withholds every calendar_* name with a named reason
  // whenever the Google OAuth triple is absent.)
  // create_goal already covers the voice-reachable case; propose_goal's inert
  // 'proposed' status is an internal/autonomous-arbiter path (see goals.create
  // usage elsewhere in this batch).
  'propose_goal',
];

// Wave 4 (2026-08-13) — the "wrong-channel guard". This list's own comments
// have documented the same shape (BUG-171 class) five separate times before
// this table existed: an act-tool promoted to DEFAULT_ALLOWLIST without the
// read/list tool that lets the model verify or reference what it acted on
// (log_incident without list_incidents/incident_status; ui_click without
// ui_elements; set_volume without get_volume; ...). Each was found by an
// operator noticing the model improvising, not by anything automated. This
// codifies the rule those comments state in prose: an act-tool ships with at
// least one of its listed counterparts, or a custom LIVE_TOOL_ALLOWLIST that
// drops one half of a pair is now caught below instead of silently reproducing
// the same class of gap.
const ACT_TOOL_READ_COUNTERPARTS = {
  whatsapp_send: ['whatsapp_contacts'],
  whatsapp_contact_save: ['whatsapp_contacts'],
  whatsapp_contact_delete: ['whatsapp_contacts'],
  log_incident: ['list_incidents', 'incident_status'],
  reminder_add: ['reminder_list'],
  reminder_cancel: ['reminder_list'],
  ui_click: ['ui_elements'],
  ui_type: ['ui_elements'],
  click_at: ['ui_elements'],
  see_and_click: ['ui_elements'],
  cua_click: ['cua_list_windows', 'cua_get_window_state'],
  cua_bring_to_front: ['cua_list_windows', 'cua_get_window_state'],
  set_volume: ['get_volume'],
  media_key: ['get_volume'],
  // 2026-08-14: write_file joined the allowlist so "save it as X" is expressible
  // at all. A write with no read-back is the same shape as ui_click without
  // ui_elements — the model cannot verify what landed, so it narrates.
  write_file: ['read_file'],
};

// Pure — exported so a test can pin the rule against DEFAULT_ALLOWLIST AND
// against any custom allowlist without needing a hub/catalog. Returns the
// act-tools present in `allowSet` with NONE of their read counterparts present.
function findMissingReadCounterparts(allowSet) {
  const gaps = [];
  for (const actTool of Object.keys(ACT_TOOL_READ_COUNTERPARTS)) {
    if (!allowSet.has(actTool)) continue;
    const counterparts = ACT_TOOL_READ_COUNTERPARTS[actTool];
    if (!counterparts.some((c) => allowSet.has(c))) {
      gaps.push({ tool: actTool, missing: counterparts });
    }
  }
  return gaps;
}

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

// buildFunctionDeclarations(hub, {allowlist, capability, log})
//
// `capability` is an optional snapshot from core/voice/tool-capability.js. When
// present, a tool whose MACHINERY is absent on this machine is withheld even
// though it is allowlisted — see that file for the incident (a fresh install
// firing gmail_unread with no OAuth keys, phone tools with no adb, browser tools
// with no CDP, all before the operator had spoken). Omitting it keeps the exact
// pre-existing behaviour, which is what every test and every headless caller that
// has no adapters to report gets.
function buildFunctionDeclarations(hub, opts) {
  const options = opts || {};
  const catalog = buildCatalogFromHub(hub);
  const allow = options.allowlist && options.allowlist.length
    ? new Set(options.allowlist)
    : new Set(DEFAULT_ALLOWLIST);
  const snapshot = options.capability || null;

  // Wave 4 — the wrong-channel guard. A custom LIVE_TOOL_ALLOWLIST (env
  // override) is the one path that can reintroduce a BUG-171-class gap that
  // DEFAULT_ALLOWLIST itself no longer has, since it is hand-typed and not
  // reviewed against this rule the way a change to this file is. Logged as
  // its own line, separate from withheld/unavailable — this is a WARNING
  // about the allowlist's shape, not a report of what the catalog did.
  if (options.log) {
    const gaps = findMissingReadCounterparts(allow);
    for (const gap of gaps) {
      options.log(`live-tools: WARNING — ${gap.tool} is allowlisted with none of its read/list ` +
        `counterpart(s) (${gap.missing.join(', ')}) present. This is the BUG-171 shape: the model can ` +
        `act but has no reachable way to verify or reference what it acted on.`);
    }
  }

  const declared = [], withheld = [], unavailable = [];
  for (const entry of catalog) {
    if (!entry || !entry.name) continue;
    if (!allow.has(entry.name)) { withheld.push(entry.name); continue; }
    if (snapshot) {
      const cap = checkToolCapability(entry.name, snapshot);
      if (!cap.ok) { unavailable.push({ name: entry.name, rule: cap.rule, reason: cap.reason }); continue; }
    }
    declared.push(toDeclaration(entry));
  }
  // AD-5 in spirit: a silent cap reads as full coverage. Say what was withheld.
  //
  // The two lists are logged SEPARATELY because they mean opposite things:
  // `withheld` is a curation decision about this list, and `unavailable` is a
  // machine that is not set up. Merging them is how a missing adb would read as
  // "someone chose not to expose the phone tools".
  if (options.log && withheld.length) {
    options.log(`live-tools: declared ${declared.length}, withheld ${withheld.length} — ${withheld.join(', ')}`);
  }
  if (options.log && unavailable.length) {
    options.log(`live-tools: withheld ${unavailable.length} allowlisted tool(s) as UNAVAILABLE on this machine — `
      + unavailable.map((u) => `${u.name} (${u.reason})`).join('; '));
  }
  return { declarations: declared, withheld, unavailable };
}

module.exports = {
  buildFunctionDeclarations,
  DEFAULT_ALLOWLIST,
  VOICE_ALLOWLIST_EXEMPT,
  ACT_TOOL_READ_COUNTERPARTS,
  findMissingReadCounterparts,
  _internal: { parseParam, toDeclaration },
};
