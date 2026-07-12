// goals/index.js — GoalSystem: CRUD, arbiter, planner, budget enforcement.
// Goals persist as individual JSON files in vault/Goals/<id>.json.
// CA patterns from NOVA tools-dashboard goals CRUD + BRAIN-MAP lane selection.

var crypto = require('crypto');

var DRIVE_WEIGHTS = {
  'user-service': 1.0,
  'maintenance': 0.55,
  'curiosity': 0.25
};

// User-intake and human-gate tools the autonomous cortex must NEVER call —
// these exist for the operator (voice/dashboard), not the goal loop. Without
// this exclusion the planner dumps its own prompts and complaints into the
// pipeline inbox as "ideas", creates duplicate goals, and can approve its own
// human-gate cards. (Names verified against from-dashboard.js registrations.)
var AUTONOMOUS_EXCLUDED = [
  'capture_idea',      // pipeline inbox — human intake only
  'create_goal',       // goal creation — human/voice only (cortex serves goals, doesn't mint them)
  'kanban_add_card',   // kanban intake — human only
  'delete_goal',       // destructive, human-gated
  'delete_artifact',   // destructive, human-gated
  'navigate',          // dashboard routing — pointless + confusing when fired headless
  'open_artifact',     // opens system browser on the user's machine — human/voice only
  'pipeline_advance',  // the human gate itself — cortex approving its own cards defeats it
  'kill_session',      // irreversible process kill — human only
];

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
        tokens: opts.budget && opts.budget.tokens || 50000,
        actions: opts.budget && opts.budget.actions || 50,
        deadline: opts.budget && opts.budget.deadline || null
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
      // RC#1: build the available-tool list from the effector registry so the
      // planner can only choose real tools. Without this, the LLM hallucinated
      // names like 'clarify', 'ask_user', 'reason', 'search_files' that don't
      // exist — every one returned 'unknown-effector' and stalled the cortex.
      var toolList = '';
      if (ctx.effectors && typeof ctx.effectors.count === 'function') {
        var names = [];
        var iter = ctx.effectors.effectors;
        if (iter && typeof iter.keys === 'function') {
          names = Array.from(iter.keys()).filter(function(n) {
            return AUTONOMOUS_EXCLUDED.indexOf(n) === -1;
          });
        }
        toolList = 'You may ONLY choose a tool from this list (use the exact name):\n' +
          names.map(function(n) { return '  - ' + n; }).join('\n') +
          '\nDo NOT invent tool names. If none of these tools fit, return {"tool":"", "args":{}}.';
      }
      try {
        var result = await ctx.brain.think({
          lane: lane,
          messages: [{ role: 'user', content:
            toolList + '\n\nPlan next action for goal: ' + goal.title +
            '\nRespond as JSON: {"tool": "<exact tool name from the list>", "args": {<required params>}}'
          }],
          schemaHint: '{ tool: string, args: object }',
          source: 'goal:' + goal.id
        });
        if (result && !result.offline && result.parsed && result.parsed.tool) {
          // RC#1 validation: reject hallucinated tool names before dispatching.
          // If the model returned a tool not in the registry, return null (cortex
          // goes idle) instead of an unknown-effector failure loop.
          if (ctx.effectors && typeof ctx.effectors.count === 'function') {
            var regIter = ctx.effectors.effectors;
            var regNames = regIter && typeof regIter.keys === 'function' ? Array.from(regIter.keys()) : [];
            if (regNames.length > 0 && (regNames.indexOf(result.parsed.tool) === -1 ||
                AUTONOMOUS_EXCLUDED.indexOf(result.parsed.tool) !== -1)) {
              if (bus) bus.emit('health.anomaly', {
                kind: 'planner-hallucinated-tool', target: goal.id,
                evidence: { tool: result.parsed.tool, available: regNames.length }
              });
              return null;
            }
          }
          return { tool: result.parsed.tool, args: result.parsed.args || {}, rationale: 'brain-planned', done: false, _spentTokens: result.spentTokens || 0 };
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
