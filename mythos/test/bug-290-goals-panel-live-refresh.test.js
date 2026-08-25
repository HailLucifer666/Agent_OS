'use strict';

// BUG-290 — the Goals panel never saw a change it did not make itself.
//
// FROM THE OPERATOR'S LOGS, 2026-08-20:
//
//   19:27:05  toggle_goal {"query":"I'll get to work"}              -> ok
//   19:27:05  toggle_goal {"query":"I'll get that recipe sent"}     -> ok
//   19:27:05  toggle_goal {"query":"dig into that looping tool"}    -> ok
//   19:27:05  toggle_goal {"query":"get that song playing"}         -> ok
//   19:27:22  incident: "Goals visual state mismatch: completed goals show as
//                        active after successful toggle_goal calls."
//   19:28:59  ...and then six rest.goals.toggle calls: the operator redoing by
//             hand, through the HUD, what the voice path had already done.
//
// THE WRITES WERE FINE. Checked against the operator's live vault before
// touching any code: 20 rows in Goals.md, 20 mapped in .md-bridge.json, zero
// unmapped, every commitment row `[x]`, and the goal JSONs read status:"done".
// Nothing was lost. `views/goals.js` fetched once on open and re-rendered only
// in its own toggle/delete/add handlers, so a change from ANY other surface —
// voice, cortex, another window — was invisible until the panel was reopened.
//
// A plausible wrong answer was available and is recorded here so it is not
// re-derived: goals.js's `toggleGoal(id)` does `if (!goal) return listGoals()`,
// an inert no-op returned as a success, and `from-dashboard.toggle_goal` never
// checks the `degraded` marker that `deleteGoal` was hardened to set. That is a
// real latent defect and it is NOT what happened here — the vault proves the
// writes landed. It is left alone rather than folded into a rendering fix.
//
// The event was already on the wire the whole time: goals/index.js emits
// `goal.updated`, server/index.js collapses `goal.*` into a broadcast of type
// `goal-update`, and the neural-map canvas already subscribes to it. The Goals
// panel was the only goals surface not listening to the goals event.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const VIEW = path.join(ROOT, 'ui', 'public', 'js', 'views', 'goals.js');
const SERVER = path.join(ROOT, 'server', 'index.js');
const GOALS_CORE = path.join(ROOT, 'src', 'core', 'goals', 'index.js');

const view = fs.readFileSync(VIEW, 'utf8');

// No jsdom in this repo and ui/public is a no-build ES-module tree, so the
// automated guard here is a source-shape assertion — the same convention as
// chat-panel-toggle and electron-cursor-overlay. It is a weaker instrument than
// a render test and is paired with a real browser run, not a substitute for one.
describe('BUG-290: the Goals panel subscribes to goal updates', () => {
  it('imports the websocket subscribe helper', () => {
    assert.match(view, /import \{[^}]*\bsubscribe\b[^}]*\} from '\/js\/ws\.js'/,
      'goals.js must import subscribe from /js/ws.js');
  });

  it('subscribes to the goal-update broadcast', () => {
    assert.match(view, /subscribe\(\s*\[\s*'goal-update'\s*\]/,
      'goals.js must subscribe to goal-update');
  });

  it('the refresh re-fetches rather than patching state from the payload', () => {
    // The broadcast carries {id, status, title}; a row needs {id, text,
    // category, done} and the tiles need stats. Rebuilding those from a partial
    // payload would be a second source of truth for the same data.
    const handler = /subscribe\(\s*\[\s*'goal-update'\s*\][\s\S]{0,600}?\n  \}\);/.exec(view);
    assert.ok(handler, 'could not locate the goal-update handler');
    assert.match(handler[0], /load\(\)/, 'the handler must call load()');
    assert.ok(!/applyData\s*\(\s*msg/.test(handler[0]),
      'the handler must not build state straight from the broadcast payload');
  });

  it('the burst of updates is debounced against a named constant', () => {
    // Four toggles landed inside one second in the audited session, and boot
    // sync emits a batch. One refetch per event would be four round trips.
    assert.match(view, /const GOAL_REFRESH_DEBOUNCE_MS = \d+;/,
      'the debounce window must be a named constant, not a magic number');
    assert.match(view, /setTimeout\([\s\S]{0,120}?GOAL_REFRESH_DEBOUNCE_MS\)/,
      'the debounce constant must actually be the setTimeout delay');
  });

  it('render() returns a cleanup that unsubscribes and clears the pending timer', () => {
    // overlay-manager.js keeps a returned function as the panel's cleanup
    // (`if (typeof result === 'function') entry.cleanup = result`). Without it
    // every open/close leaks a subscription and a live timer that calls load()
    // into a mount that is gone.
    const tail = view.slice(view.lastIndexOf('await load();'));
    assert.match(tail, /return \(\) => \{/, 'render() must return a cleanup function');
    assert.match(tail, /unsub\(\)/, 'cleanup must unsubscribe');
    assert.match(tail, /clearTimeout\(reloadTimer\)/, 'cleanup must clear the pending refetch');
  });
});

describe('BUG-290: the name the panel listens for is the name the server sends', () => {
  it('the browser subscribe type matches the server broadcast type', () => {
    // Two files, one string. A rename on either side silently stops the panel
    // updating again, with nothing failing anywhere — exactly the shape of the
    // original bug, which is why this is asserted across the seam rather than
    // on one side of it.
    const server = fs.readFileSync(SERVER, 'utf8');
    // Match only the call's opening `{ type: '...'` — the payload that follows
    // has its own nested braces, so anything trying to span to the closing one
    // stops early and matches nothing.
    const broadcast = /broadcastAll\(\{\s*type:\s*'([a-z-]+)'/g;
    const types = new Set();
    let m;
    while ((m = broadcast.exec(server)) !== null) types.add(m[1]);
    assert.ok(types.has('goal-update'),
      'server/index.js no longer broadcasts goal-update; found: ' + [...types].sort().join(', '));
  });

  it('the server bridges the bus channel the goal store actually emits on', () => {
    const server = fs.readFileSync(SERVER, 'utf8');
    const core = fs.readFileSync(GOALS_CORE, 'utf8');
    assert.match(server, /bus\.subscribe\('goal\.\*'/,
      'server must bridge the goal.* channel to the browser');
    // The emit that a toggle actually goes through. goalsEffector.toggleGoal
    // calls goalSystem.update(), which emits this one.
    assert.match(core, /bus\.emit\('goal\.updated'/,
      'goalSystem.update must still emit goal.updated, or a toggle reaches no surface');
  });
});
