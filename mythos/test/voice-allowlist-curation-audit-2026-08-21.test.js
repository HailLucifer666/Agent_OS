'use strict';

// test/voice-allowlist-curation-audit-2026-08-21.test.js
//
// The 2026-08-21 capability audit found tools the operator had asked for by
// voice that the Live model could not see. Operator decision, verbatim:
// "promote everything usable" — machinery-absent and never-exercised tools
// stay withheld. This locks the resulting curation so a later edit cannot
// quietly undo it.
//
// WHAT THE AUDIT MEASURED (Audit/*.jsonl call counts, not guesses):
//   use_skill      14 calls   — the exempt list called it "internal/debugging"
//   list_folder     4 calls
//   create_folder   2 calls   — and user-facts records the operator being told
//                               "the planned file management capability to
//                               create folders also failed"
//   search_files / move_file / copy_file / rename_file / clipboard_* /
//   calendar_upcoming: 0 calls — promoted on family symmetry, not on demand
//                               (see the family invariant below).
//
// A CORRECTION THIS FILE DELIBERATELY DOES NOT ENCODE.
// The remediation plan called create_folder/move_file/copy_file/rename_file
// being in NEITHER list "the BUG-110/177 drift class, not curation", and
// proposed a test asserting every registered tool appears in
// DEFAULT_ALLOWLIST ∪ VOICE_ALLOWLIST_EXEMPT. That is wrong and is not
// written here. Those four are T3, and allowlist-reachability.test.js
// deliberately stops at T2 ("T3/T4 are confirm-gated and curated separately").
// Being absent from both lists is the NORMAL state for a T3 tool — 21 T3 tools
// are allowlisted and many more are not. A universal-membership test would
// force every confirm-gated tool onto a list and destroy that boundary.
// Promotion here is therefore a curation decision the operator made, not a
// drift repair.
//
// Reachability is not permission: the leash tier gate still runs at dispatch,
// so a promoted T3 tool is visible to the model and still confirm-gated.
// gmail_send, whatsapp_send and write_file are already allowlisted on exactly
// that basis.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_ALLOWLIST, VOICE_ALLOWLIST_EXEMPT } = require('../src/core/voice/live-tools');
const { tierOf } = require('../src/core/leash/tiers');

const allow = new Set(DEFAULT_ALLOWLIST);
const exempt = new Set(VOICE_ALLOWLIST_EXEMPT);

// Promoted by the 2026-08-21 audit.
const PROMOTED = [
  'list_folder', 'search_files',
  'create_folder', 'move_file', 'copy_file', 'rename_file',
  'clipboard_read', 'clipboard_write',
  'calendar_upcoming',
  'use_skill',
];

// Still withheld ON PURPOSE, each for a reason that survived the audit.
// Kept here so "promote everything usable" cannot creep into "promote
// everything" without this test failing and forcing the argument to be made.
const STILL_WITHHELD = {
  delete_file: 'NEVER_TRUSTABLE in the leash — irreversible, no read-back oracle',
  run_command: 'T3 arbitrary execution, 0 ok / 1 fail all-time',
  spotify_search: 'spotify_play already searches AND plays; the two-step dance caused the 2026-08-09 wrong-track probing',
  scroll_at: 'the wandering-pointer behaviour the same incident was about',
  generate_deck: 'long-running producer with its own Forge/HUD surface',
  index_project: 'zero calls ever; opt-in power feature with its own UI',
  search_code: 'zero calls ever; opt-in power feature with its own UI',
  // phone_screenshot left this list 2026-09-08: its reason ("adb absent on this
  // machine") stopped being true when a OnePlus 7T was attached over USB and the
  // operator asked for the torch by voice. The whole phone_* group is promoted
  // below; tool-capability.js still withholds it whenever no device is attached.
};

// Promoted 2026-09-08 (phone attached, live-measured): the android bridge group
// that live-tools.js's exempt comment always said "moves together the day the
// phone adapter is curated in". phone_torch is new the same day.
const PROMOTED_PHONE_GROUP = [
  'phone_list_devices', 'phone_screenshot', 'phone_notifications', 'phone_contacts_search',
  'phone_app_launch', 'phone_app_close', 'phone_wifi_toggle', 'phone_bluetooth_toggle', 'phone_hotspot_toggle',
  'phone_torch',
];

describe('voice allowlist curation (2026-08-21 capability audit)', () => {
  it('the lists parsed and are non-trivial (negative control)', () => {
    // Without this, every membership assertion below could pass against an
    // empty or half-loaded module and read as coverage.
    assert.ok(allow.size > 50, 'DEFAULT_ALLOWLIST looks empty/short: ' + allow.size);
    assert.ok(exempt.size > 20, 'VOICE_ALLOWLIST_EXEMPT looks empty/short: ' + exempt.size);
  });

  it('a tool is never on both lists at once', () => {
    // The two lists mean opposite things. A name on both is a contradiction,
    // and is the exact bookkeeping slip a promotion makes easy: adding to
    // DEFAULT_ALLOWLIST while forgetting to delete the exempt entry.
    const both = DEFAULT_ALLOWLIST.filter((n) => exempt.has(n));
    assert.deepEqual(both, [], 'names on BOTH lists: ' + JSON.stringify(both));
  });

  for (const name of PROMOTED) {
    it('"' + name + '" is reachable from voice', () => {
      assert.ok(
        allow.has(name),
        name + ' was promoted by the 2026-08-21 audit and must stay in DEFAULT_ALLOWLIST'
      );
      assert.ok(!exempt.has(name), name + ' must no longer be listed as exempt');
    });
  }

  it('the phone_* group moves together (2026-09-08): every member reachable, none still exempt', () => {
    const missing = PROMOTED_PHONE_GROUP.filter((n) => !allow.has(n));
    const stillExempt = PROMOTED_PHONE_GROUP.filter((n) => exempt.has(n));
    assert.deepEqual(missing, [], 'phone group partially promoted — missing from DEFAULT_ALLOWLIST: ' + JSON.stringify(missing));
    assert.deepEqual(stillExempt, [], 'phone group members left on the exempt list: ' + JSON.stringify(stillExempt));
  });

  // The file's own doctrine, stated in the exempt list: "promoting one alone is
  // what creates the gaps this file documents." The file-management verbs are
  // one family — a session that can create a folder but cannot rename it hits
  // the same read/act asymmetry read_file/write_file already cost this repo.
  it('the file-management family moves together, never partially', () => {
    const family = ['list_folder', 'search_files', 'create_folder', 'move_file', 'copy_file', 'rename_file'];
    const reachable = family.filter((n) => allow.has(n));
    assert.equal(
      reachable.length,
      family.length,
      'file-management family is partially promoted, which is the asymmetry this file warns about. ' +
        'Missing: ' + JSON.stringify(family.filter((n) => !allow.has(n)))
    );
  });

  it('the clipboard pair moves together', () => {
    assert.equal(
      allow.has('clipboard_read'), allow.has('clipboard_write'),
      'clipboard read and write must be promoted or withheld as a pair'
    );
  });

  for (const [name, why] of Object.entries(STILL_WITHHELD)) {
    it('"' + name + '" stays withheld — ' + why, () => {
      assert.ok(
        !allow.has(name),
        name + ' is deliberately NOT voice-reachable: ' + why +
          '. If that changed on purpose, delete this entry and say why in live-tools.js.'
      );
    });
  }

  // Guards the argument the promotion rests on, not just its outcome. If
  // someone later "fixes" the allowlist by dropping every T3 entry, this fails
  // and points at the reasoning rather than leaving it to be rediscovered.
  it('T3 tools are allowed on the voice surface — reachability is not permission', () => {
    const t3Allowed = DEFAULT_ALLOWLIST.filter((n) => tierOf(n) === 3);
    assert.ok(
      t3Allowed.length >= 20,
      'expected many T3 tools to be voice-reachable and still confirm-gated by the leash; found ' +
        t3Allowed.length + '. Reachability is not permission — see gmail_send/whatsapp_send/write_file.'
    );
    assert.ok(t3Allowed.includes('create_folder'), 'create_folder (T3) should be among them after this audit');
  });
});
