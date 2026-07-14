// goals/index.js — GoalSystem: CRUD, arbiter, planner, budget enforcement.
// Goals persist as individual JSON files in vault/Goals/<id>.json.
// CA patterns from NOVA tools-dashboard goals CRUD + BRAIN-MAP lane selection.

var crypto = require('crypto');
var { tryParseWithRepair } = require('../brain'); // D-48: robust plan-content parse fallback

var DRIVE_WEIGHTS = {
  'user-service': 1.0,
  'maintenance': 0.55,
  'curiosity': 0.25
};

function createGoalSystem({ fs, config, bus, memory, brain }) {
  var goals = new Map(); // id -> goal record (in-memory index)

  function nextId() {
    return 'goal-' + crypto.randomUUID();
  }

  // --- CRUD ---

  function create(opts) {
    var id = nextId();
    var now = Date.now();
    var goal = {
      id: id,
      drive: opts.drive || 'user-service',
      title: opts.title || 'Untitled goal',
      status: opts.status || 'proposed',
      priority: typeof opts.priority === 'number' ? opts.priority : 0.5,
      budget: {
        // D-49 fix: honor the GOAL_TOKEN_BUDGET/GOAL_ACTION_BUDGET config keys
        // (default 20000/25) instead of hardcoded 50000/50 that ignored them.
        tokens: (opts.budget && opts.budget.tokens) || (config && config.GOAL_TOKEN_BUDGET) || 50000,
        actions: (opts.budget && opts.budget.actions) || (config && config.GOAL_ACTION_BUDGET) || 50,
        deadline: (opts.budget && opts.budget.deadline) || null
      },
      spent: { tokens: 0, actions: 0 },
      parentId: opts.parentId || null,
      childIds: [],
      plan: [],
      grants: {},
      reason: opts.reason || '',
      createdAt: now,
      updatedAt: now,
      lastActionAt: null
    };
    goals.set(id, goal);
    saveGoal(id);
    if (bus) bus.emit('goal.created', { id: id, drive: goal.drive, title: goal.title });
    return goal;
  }

  function get(id) {
    return goals.get(id) || null;
  }

  function update(id, patch) {
    var goal = goals.get(id);
    if (!goal) return null;
    for (var key in patch) {
      if (key === 'id') continue; // immutable
      if (key === 'budget' && typeof patch[key] === 'object') {
        for (var bk in patch[key]) goal.budget[bk] = patch[key][bk];
      } else if (key === 'spent' && typeof patch[key] === 'object') {
        for (var sk in patch[key]) goal.spent[sk] = patch[key][sk];
      } else {
        goal[key] = patch[key];
      }
    }
    goal.updatedAt = Date.now();
    saveGoal(id);
    if (bus) bus.emit('goal.updated', { id: id, status: goal.status });
    return goal;
  }

  function remove(id) {
    var goal = goals.get(id);
    if (!goal) return false;
    // Remove from parent's childIds
    if (goal.parentId) {
      var parent = goals.get(goal.parentId);
      if (parent) {
        parent.childIds = parent.childIds.filter(function(cid) { return cid !== id; });
        saveGoal(goal.parentId);
      }
    }
    goals.delete(id);
    removeGoalFile(id);
    if (bus) bus.emit('goal.removed', { id: id });
    return true;
  }

  function list(filter) {
    filter = filter || {};
    var all = Array.from(goals.values());
    if (filter.status) all = all.filter(function(g) { return g.status === filter.status; });
    if (filter.drive) all = all.filter(function(g) { return g.drive === filter.drive; });
    return all;
  }

  // --- Active ---

  function getActive() {
    // Return the currently active goal (last one set by cortex)
    var active = list({ status: 'active' });
    return active.length > 0 ? active[0] : null;
  }

  function hasActive() {
    return list({ status: 'active' }).length > 0;
  }

  function getActiveGoals() {
    return list({ status: 'active' });
  }

  // --- Arbiter ---

  function arbitrate(perceptions, working) {
    var candidates = getActiveGoals();
    if (candidates.length === 0) return null;

    var maxActive = (config && config.MAX_ACTIVE_GOALS) || 5;
    if (candidates.length > maxActive) {
      candidates = candidates.slice(0, maxActive);
    }

    var scored = candidates.map(function(g) {
      var driveWeight = DRIVE_WEIGHTS[g.drive] || 0;
      var priority = g.priority;

      // Deadline urgency
      var urgency = 0;
      if (g.budget.deadline) {
        var remaining = (new Date(g.budget.deadline).getTime() - Date.now()) / 3600000;
        urgency = remaining < 1 ? 1.0 : remaining < 24 ? 0.5 : 0;
      }

      // Budget pressure
      var tokenPressure = g.budget.tokens > 0 ? 1 - (g.spent.tokens / g.budget.tokens) : 0;
      var actionPressure = g.budget.actions > 0 ? 1 - (g.spent.actions / g.budget.actions) : 0;
      var budgetPressure = Math.min(tokenPressure, actionPressure);

      // Salience boost from perceptions
      var salienceBoost = 0;
      for (var i = 0; i < perceptions.length; i++) {
        var p = perceptions[i];
        var rel = goalRelevance(p, g);
        if (rel > 0.3 && p.rankedSalience > salienceBoost) {
          salienceBoost = p.rankedSalience;
        }
      }

      // Sticky: bonus for current goal (anti-thrash)
      var sticky = (working && working.activeGoalId === g.id) ? 0.15 : 0;

      var score = driveWeight * 0.3 + priority * 0.3 + urgency * 0.15 +
                  budgetPressure * 0.1 + salienceBoost * 0.1 + sticky;

      return { goal: g, score: score };
    });

    scored.sort(function(a, b) { return b.score - a.score; });
    return scored[0] ? scored[0].goal : null;
  }

  function goalRelevance(perception, goal) {
    if (!perception || !goal) return 0;
    var goalText = ((goal.title || '') + ' ' + (goal.reason || '')).toLowerCase();
    var pText = ((perception.summary || '') + ' ' + (perception.channel || '')).toLowerCase();
    if (!goalText || !pText) return 0;
    var goalTerms = goalText.split(/\s+/).filter(Boolean);
    var pTerms = pText.split(/\s+/).filter(Boolean);
    var hits = 0;
    for (var i = 0; i < pTerms.length; i++) {
      if (goalTerms.indexOf(pTerms[i]) !== -1) hits++;
    }
    return pTerms.length > 0 ? hits / pTerms.length : 0;
  }

  // --- Planner ---

  async function plan(goal, ctx) {
    // 1. Check current plan for pending step
    if (goal.plan && goal.plan.length > 0) {
      for (var i = 0; i < goal.plan.length; i++) {
        if (goal.plan[i].status === 'pending') {
          return { tool: goal.plan[i].tool, args: goal.plan[i].args, rationale: 'plan-step' };
        }
      }
    }

    // 2. Procedural recall from Skills store
    if (ctx && ctx.memory && ctx.memory.skills) {
      try {
        var skills = await ctx.memory.skills.recall({ query: goal.title, limit: 1 });
        if (skills.length > 0 && skills[0].score > 0.6) {
          var skill = skills[0].record;
          if (skill.steps && skill.steps.length > 0) {
            var step = skill.steps[0];
            return { tool: step.tool, args: step.args, rationale: 'procedural-skill', offline: true };
          }
        }
      } catch (_) { /* skills store may not be available */ }
    }

    // 3. Budget check BEFORE Brain call
    if (goal.spent.tokens >= goal.budget.tokens) {
      goal.status = 'paused';
      goal.reason = 'budget-exhausted';
      saveGoal(goal.id);
      return null;
    }

    // 4. Brain call
    if (ctx && ctx.brain) {
      var lane = goal.drive === 'user-service' ? 'build' : 'simple';
      try {
        var result = await ctx.brain.think({
          lane: lane,
          messages: [{ role: 'user', content: 'Plan next action for goal: ' + goal.title }],
          schemaHint: '{ tool: string, args: object }',
          source: 'goal:' + goal.id
        });
        // D-48 fix: fall back to parsing result.content when the provider did
        // not populate result.parsed (a plan step used to silently return null).
        var parsed = result && result.parsed;
        if (!parsed && result && result.content) parsed = tryParseWithRepair(result.content);
        if (result && !result.offline && parsed && parsed.tool) {
          return { tool: parsed.tool, args: parsed.args || {}, rationale: 'brain-planned', done: false };
        }
      } catch (_) { /* brain offline */ }
    }

    return null;
  }

  // --- Budget ---

  function debitBudget(id, usage) {
    var goal = goals.get(id);
    if (!goal) return;
    goal.spent.tokens += (usage.tokens || 0);
    goal.spent.actions += (usage.actions || 0);
    goal.lastActionAt = Date.now();

    // Auto-pause on budget exhaustion
    if (goal.spent.tokens >= goal.budget.tokens || goal.spent.actions >= goal.budget.actions) {
      goal.status = 'paused';
      goal.reason = 'budget-exhausted';
      // health.anomaly — exact string, do not paraphrase. Added in Phase 6 so
      // healer.js's 'budget-pause' playbook has a real producer (Spec Ambiguities #9).
      if (bus) bus.emit('health.anomaly', { kind: 'budget-exhausted', target: id, evidence: { spent: goal.spent, budget: goal.budget } });
    }
    saveGoal(id);
    if (bus) bus.emit('goal.budget-debited', { id: id, spent: goal.spent });
  }

  function grantTier(id, tier) {
    var goal = goals.get(id);
    if (!goal) return;
    goal.grants[String(tier)] = true;
    saveGoal(id);
  }

  // --- Persistence ---

  function saveGoal(id) {
    var goal = goals.get(id);
    if (!goal || !fs) return;
    try {
      var relPath = 'Goals/' + id + '.json';
      fs.writeJSON(relPath, goal);
    } catch (_) { /* best-effort */ }
  }

  function removeGoalFile(id) {
    if (!fs) return;
    try {
      fs.removeFile('Goals/' + id + '.json');
    } catch (_) {}
  }

  async function init() {
    if (!fs) return;
    // Ensure Goals directory
    try { fs.ensureDir('Goals'); } catch (_) {}

    // Load existing goals from vault
    try {
      var files = fs.listFiles('Goals', '.json');
      for (var i = 0; i < files.length; i++) {
        try {
          var data = fs.readJSON(files[i].path, null);
          if (data && data.id) {
            goals.set(data.id, data);
          }
        } catch (_) { /* skip corrupt */ }
      }
    } catch (_) {}
  }

  // --- Stats ---

  function stats() {
    var all = Array.from(goals.values());
    var byStatus = {};
    var byDrive = {};
    for (var i = 0; i < all.length; i++) {
      var s = all[i].status || 'unknown';
      var d = all[i].drive || 'unknown';
      byStatus[s] = (byStatus[s] || 0) + 1;
      byDrive[d] = (byDrive[d] || 0) + 1;
    }
    return {
      total: all.length,
      active: byStatus.active || 0,
      byStatus: byStatus,
      byDrive: byDrive,
      totalTokensSpent: all.reduce(function(sum, g) { return sum + g.spent.tokens; }, 0),
      totalActionsSpent: all.reduce(function(sum, g) { return sum + g.spent.actions; }, 0)
    };
  }

  return {
    create, get, update, remove, list,
    getActive, hasActive, getActiveGoals,
    arbitrate, plan, debitBudget, grantTier,
    init, stats,
    _internal: { DRIVE_WEIGHTS, goalRelevance, goals: function() { return goals; } }
  };
}

module.exports = { createGoalSystem, DRIVE_WEIGHTS };
