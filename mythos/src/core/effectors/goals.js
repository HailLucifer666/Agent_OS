'use strict';

// effectors/goals.js — Goals.md <-> GoalSystem bridge (NEW logic, not a NOVA CA).
// Goals.md stays the human-facing surface (positional checkbox list); GoalSystem
// (src/core/goals/index.js) is the cognition-facing surface (stable-id JSON).
// Join key is (text, created) — NOT positional index — because Goals.md ids are
// rewritten by reindex() on every mutation. See Spec Ambiguities Resolved #6.

var LINE_RE = /^- \[( |x)\] (.+?) · (.+?) · (\d{4}-\d{2}-\d{2}T[\d:.Z-]+)$/;
var BRIDGE_REL_PATH = 'Goals/.md-bridge.json';

function serializeLine(row) {
  return '- [' + (row.done ? 'x' : ' ') + '] ' + row.text + ' · ' + row.category + ' · ' + row.created;
}

function parseGoalsMd(text) {
  var lines = String(text || '').split(/\r?\n/).filter(function(l) { return l.trim().length > 0; });
  var rows = [];
  for (var i = 0; i < lines.length; i++) {
    var m = LINE_RE.exec(lines[i].trim());
    if (m) rows.push({ done: m[1] === 'x', text: m[2], category: m[3], created: m[4] });
  }
  return rows;
}

function createGoalsMdBridge({ fs, goalSystem, bus }) {
  if (!fs || typeof fs.readText !== 'function' || typeof fs.writeText !== 'function') {
    throw new Error('createGoalsMdBridge requires a vault fs-store with readText/writeText');
  }
  if (!goalSystem || typeof goalSystem.create !== 'function') {
    throw new Error('createGoalsMdBridge requires a GoalSystem instance');
  }

  function loadBridgeMap() {
    try { return fs.readJSON(BRIDGE_REL_PATH, []); } catch (_) { return []; }
  }
  function saveBridgeMap(map) {
    try { fs.writeJSON(BRIDGE_REL_PATH, map); }
    catch (err) { if (bus) bus.emit('health.anomaly', { kind: 'goals-bridge-save-failed', error: err.message }); }
  }
  function findGoalIdFor(map, row) {
    for (var i = 0; i < map.length; i++) {
      if (map[i].text === row.text && map[i].created === row.created) return map[i].goalId;
    }
    return null;
  }

  // sync() — call once at boot (and after any external Goals.md edit) to reconcile
  // Goals.md rows into GoalSystem, creating a user-service goal for any unmapped row.
  function sync() {
    var text = fs.readText('Goals.md', '');
    var rows = parseGoalsMd(text);
    var map = loadBridgeMap();
    var changed = false;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var goalId = findGoalIdFor(map, row);
      if (!goalId) {
        var goal = goalSystem.create({
          drive: 'user-service',
          title: row.text,
          status: row.done ? 'done' : 'active',
          reason: 'Goals.md:' + row.category
        });
        map.push({ goalId: goal.id, text: row.text, created: row.created });
        changed = true;
      } else {
        var goal2 = goalSystem.get(goalId);
        var wantStatus = row.done ? 'done' : 'active';
        if (goal2 && goal2.status !== wantStatus && goal2.status !== 'paused') {
          goalSystem.update(goalId, { status: wantStatus });
        }
      }
    }
    if (changed) saveBridgeMap(map);
    return { rows: rows.length, mapped: map.length };
  }

  // writeBack() — call after any GoalSystem mutation to a user-service goal (e.g. cortex
  // marks a goal done) so Goals.md reflects it. Only rewrites rows whose mapped goal's
  // status actually disagrees with the checkbox state; never reorders existing rows.
  function writeBack() {
    var text = fs.readText('Goals.md', '');
    var rows = parseGoalsMd(text);
    var map = loadBridgeMap();

    var out = rows.map(function(row) {
      var goalId = findGoalIdFor(map, row);
      if (!goalId) return row;
      var goal = goalSystem.get(goalId);
      if (!goal) return row;
      return { done: goal.status === 'done', text: row.text, category: row.category, created: row.created };
    });

    // Append any user-service goal that isn't in Goals.md yet (created directly via
    // create_goal effector call rather than an external Goals.md edit).
    var mappedIds = map.map(function(m) { return m.goalId; });
    var userServiceGoals = goalSystem.list({ drive: 'user-service' });
    for (var i = 0; i < userServiceGoals.length; i++) {
      var g = userServiceGoals[i];
      if (mappedIds.indexOf(g.id) === -1) {
        var created = new Date(g.createdAt).toISOString();
        out.push({ done: g.status === 'done', text: g.title, category: 'General', created: created });
        map.push({ goalId: g.id, text: g.title, created: created });
      }
    }

    var serialized = out.map(serializeLine).join('\n') + (out.length ? '\n' : '');
    fs.writeText('Goals.md', serialized);
    saveBridgeMap(map);
    return { rows: out.length };
  }

  // CROSS-PHASE FIX (consistency pass, P7 vs P9): P9's server/index.js requires
  // effectors.get('goals-effector') exposing listGoals/addGoal/toggleGoal/
  // deleteGoal/stats returning NOVA app/lib/goals.js's {id,text,category,done}
  // shape — this bridge originally only exposed sync/writeBack internally, never
  // a REST-facing surface. `id` here is the GoalSystem UUID (via the bridge map),
  // not a positional index — a strict improvement over NOVA's positional ids
  // (immune to reindex-on-delete drift), while keeping the field NAME identical
  // so P9's REST handlers need no shape translation.
  function listGoals() {
    var text = fs.readText('Goals.md', '');
    var rows = parseGoalsMd(text);
    var map = loadBridgeMap();
    return rows.map(function(row) {
      return { id: findGoalIdFor(map, row), text: row.text, category: row.category, done: row.done };
    });
  }

  function addGoal(text, category) {
    // BUG FIX (beyond the spec's 13 documented ambiguities — same "code as it actually
    // behaves, not as spec prose describes it" resolution style): the spec's literal
    // addGoal() pre-populated the bridge map with {goalId, text, created} BEFORE calling
    // writeBack(). writeBack()'s own "append any user-service goal not yet in Goals.md"
    // loop decides what to append by checking whether the goal's id is already IN the
    // map — so pre-adding it there made that loop's condition false, and the new goal's
    // checkbox row could never actually be written to Goals.md. Fix: goalSystem.create()
    // only; writeBack() already does the map.push() + Goals.md append correctly for any
    // user-service goal it doesn't yet recognize (see its own body below).
    goalSystem.create({
      drive: 'user-service',
      title: text,
      status: 'active',
      reason: 'goals-effector:addGoal'
    });
    writeBack();
    return listGoals();
  }

  function toggleGoal(id) {
    var goal = goalSystem.get(id);
    if (!goal) return listGoals();
    goalSystem.update(id, { status: goal.status === 'done' ? 'active' : 'done' });
    writeBack();
    return listGoals();
  }

  function deleteGoal(id) {
    var map = loadBridgeMap().filter(function(m) { return m.goalId !== id; });
    saveBridgeMap(map);
    goalSystem.remove(id);
    writeBack();
    return listGoals();
  }

  function stats() {
    var all = listGoals();
    return { total: all.length, done: all.filter(function(g) { return g.done; }).length, active: all.filter(function(g) { return !g.done; }).length };
  }

  return {
    sync: sync, writeBack: writeBack, parseGoalsMd: parseGoalsMd,
    listGoals: listGoals, addGoal: addGoal, toggleGoal: toggleGoal, deleteGoal: deleteGoal, stats: stats
  };
}

module.exports = { createGoalsMdBridge, parseGoalsMd };
