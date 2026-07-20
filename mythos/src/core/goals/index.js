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
  'gmail_send',        // sends email to real people — operator-gated
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
        tokens: opts.budget && opts.budget.tokens || (config && config.GOAL_TOKEN_BUDGET) || 20000,
        actions: opts.budget && opts.budget.actions || (config && config.GOAL_ACTION_BUDGET) || 25,
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
    // C4: Create new object instead of mutating in-place (immutability standard).
    var updated = Object.assign({}, goal);
    if (patch.budget && typeof patch.budget === 'object') {
      updated.budget = Object.assign({}, goal.budget, patch.budget);
    }
    if (patch.spent && typeof patch.spent === 'object') {
      updated.spent = Object.assign({}, goal.spent, patch.spent);
    }
    for (var key in patch) {
      if (key === 'id' || key === 'budget' || key === 'spent') continue;
      updated[key] = patch[key];
    }
    updated.updatedAt = Date.now();
    goals.set(id, updated);
    saveGoal(id);
    if (bus) bus.emit('goal.updated', { id: id, status: updated.status, title: updated.title });
    return updated;
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

    var scored = candidates.map(function(g) {
      var driveWeight = DRIVE_WEIGHTS[g.drive] || 0;
      var priority = g.priority;

      // Deadline urgency
      var urgency = 0;
      if (g.budget.deadline) {
        var remaining = (new Date(g.budget.deadline).getTime() - Date.now()) / 3600000;
        urgency = remaining < 1 ? 1.0 : remaining < 24 ? 0.5 : 0;
      }

      // Budget headroom: fraction of budget remaining (higher = more headroom).
      var tokenHeadroom = g.budget.tokens > 0 ? 1 - (g.spent.tokens / g.budget.tokens) : 0;
      var actionHeadroom = g.budget.actions > 0 ? 1 - (g.spent.actions / g.budget.actions) : 0;
      var budgetHeadroom = Math.min(tokenHeadroom, actionHeadroom);

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
                  budgetHeadroom * 0.1 + salienceBoost * 0.1 + sticky;

      return { goal: g, score: score };
    });

    scored.sort(function(a, b) { return b.score - a.score; });
    // D-51: cap AFTER sorting — previously sliced by insertion order before scoring
    if (scored.length > maxActive) scored = scored.slice(0, maxActive);
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
    // V3 (Phase 4): also gate on successRate so we don't keep replaying a
    // procedure that fails more often than it succeeds (threshold 0.5 = at
    // least as many successes as failures, weighted by the EMA in recordUse).
    // SKILL_MIN_SUCCESS_RATE lives in schema; default 0.5.
    if (ctx && ctx.memory && ctx.memory.skills) {
      try {
        // B-1 fix: recall() signature is (query, opts) — it called
        // .toLowerCase() on the first arg, so passing {query,limit} as the
        // first arg threw TypeError inside the try/catch, silently killing
        // the procedural-skill branch since the goal system shipped.
        var minSuccess = (config && config.SKILL_MIN_SUCCESS_RATE) || 0.5;
        var skills = await ctx.memory.skills.recall(goal.title, { limit: 3 });
        for (var si = 0; si < skills.length; si++) {
          if (skills[si].score <= 0.6) continue;
          var skillRec = skills[si].record;
          if (!skillRec.steps || skillRec.steps.length === 0) continue;
          // B-2 fix: respect the tracked successRate. Brand-new skills
          // (uses===0) pass through — they get a chance to prove themselves.
          if (skillRec.uses > 0 && (skillRec.successRate || 0) < minSuccess) continue;
          var sref = skillRec.id || skills[si].ref;
          var step0 = skillRec.steps[0];
          return {
            tool: step0.tool, args: step0.args,
            rationale: 'procedural-skill', offline: true,
            skillRef: sref            // V2: carried into dispatchAction for recordUse
          };
        }
      } catch (err) { if (bus) bus.emit('health.anomaly', { kind: 'skills-recall-failed', error: err.message }); }
    }

    // 3. Budget check BEFORE Brain call — check BOTH token and action budgets
    // to match debitBudget()'s dual-dimension check and prevent wasted actions.
    if (goal.spent.tokens >= goal.budget.tokens || goal.spent.actions >= goal.budget.actions) {
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
      // BUG-013: also filter out suppressed tools (circuit breaker opened).
      var toolList = '';
      if (ctx.effectors && typeof ctx.effectors.count === 'function') {
        var names = [];
        var iter = ctx.effectors.effectors;
        if (iter && typeof iter.keys === 'function') {
          names = Array.from(iter.keys()).filter(function(n) {
            // BUG-013: check if tool is suppressed via immune system
            var healer = require('../immune/healer');
            return AUTONOMOUS_EXCLUDED.indexOf(n) === -1 && !healer.isToolSuppressed(n);
          });
        }
        toolList = 'You may ONLY choose a tool from this list (use the exact name):\n' +
          names.map(function(n) { return '  - ' + n; }).join('\n') +
          '\nDo NOT invent tool names. If none of these tools fit, return {"tool":"", "args":{}}.';
      }
      try {
        // Skills hint: surface the curated skill catalog so the autonomous
        // planner knows methodology/design guides exist. use_skill is already
        // in the tool list above (registered as an effector); this block tells
        // the model WHICH skills are worth loading for this kind of work.
        var skillsHint = '';
        try {
          var sl = require('../skills/loader');
          var sBlock = sl.catalogBlock();
          if (sBlock) skillsHint = '\n\n' + sBlock;
        } catch (_) { /* skills loader unavailable — non-fatal */ }
        var result = await ctx.brain.think({
          lane: lane,
          messages: [{ role: 'user', content:
            toolList + skillsHint + '\n\nPlan next action for goal: ' + goal.title +
            '\n\nGROUNDING: If this goal involves current events, real-time data, news, dates, or anything that could be stale, use web_search or web_fetch FIRST to get real data before planning further actions.' +
            '\nRespond as JSON: {"tool": "<exact tool name from the list>", "args": {<required params>}}'
          }],
          schemaHint: '{ tool: string, args: object }',
          source: 'goal:' + goal.id,
          budget: { tokens: goal.budget.tokens - goal.spent.tokens, actions: goal.budget.actions - goal.spent.actions }
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
      } catch (err) { if (bus) bus.emit('health.anomaly', { kind: 'planner-brain-failed', error: err.message }); }
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
    } catch (err) {
      // C5: Emit anomaly so operator knows persistence is degraded.
      if (bus) bus.emit('health.anomaly', { kind: 'goal-save-failed', target: id, error: err.message });
    }
  }

  function removeGoalFile(id) {
    if (!fs) return;
    try {
      fs.removeFile('Goals/' + id + '.json');
    } catch (err) { if (bus) bus.emit('health.anomaly', { kind: 'goals-file-remove-failed', error: err.message }); }
  }

  async function init() {
    if (!fs) return;
    // Ensure Goals directory
    try { fs.ensureDir('Goals'); } catch (err) { if (bus) bus.emit('health.anomaly', { kind: 'goals-dir-init-failed', error: err.message }); }

    // Load existing goals from vault
    try {
      var files = fs.listFiles('Goals', '.json');
      for (var i = 0; i < files.length; i++) {
        try {
          var data = fs.readJSON(files[i].path, null);
          if (data && data.id) {
            // B1: Normalize loaded goals to prevent crashes on corrupt/legacy files.
            data.spent = data.spent || { tokens: 0, actions: 0 };
            data.budget = data.budget || { tokens: (config && config.GOAL_TOKEN_BUDGET) || 20000, actions: (config && config.GOAL_ACTION_BUDGET) || 25, deadline: null };
            data.plan = data.plan || [];
            data.childIds = data.childIds || [];
            data.grants = data.grants || {};
            data.drive = data.drive || 'user-service';
            data.status = data.status || 'proposed';
            // Validate drive against known weights
            if (!DRIVE_WEIGHTS[data.drive]) data.drive = 'user-service';
            goals.set(data.id, data);
          }
        } catch (err) { if (bus) bus.emit('health.anomaly', { kind: 'goals-load-corrupt', error: err.message }); }
      }
    } catch (err) { if (bus) bus.emit('health.anomaly', { kind: 'goals-list-files-failed', error: err.message }); }
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
