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
  'write_file',        // writes/overwrites user files — operator-gated (voice/dashboard only)
  'create_folder',     // creates user folders — operator-gated
  'delete_file',       // permanently deletes a user file — operator-gated
];

// B4 (2026-08-14): the literal 20000 was written out twice here, and both copies
// had to agree with schema.js's GOAL_TOKEN_BUDGET default while nothing checked
// that they did — the same defect class as Wave A's hand-tuned preroll ring. It is
// named once now, and goal-budget-calibration.test.js pins it equal to the schema
// default. It is only reachable when `config` is absent (tests); production always
// has a config, and .env.example ships the same number a third time because that
// file is copied to .env and would otherwise override the schema silently.
//
// See schema.js for the measurement: two goals spent ~31,200 tokens over 2 actions
// and auto-paused 5s after creation against the old 20,000.
const GOAL_TOKEN_BUDGET_FALLBACK = 250000;

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
        tokens: opts.budget && opts.budget.tokens || (config && config.GOAL_TOKEN_BUDGET) || GOAL_TOKEN_BUDGET_FALLBACK,
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

  // Phase 4 / Area A (V3): autonomous goal completion + procedure distillation.
  //
  // Pre-Phase-4: the cortex never marked a goal done. Status transitions to
  // 'done' happened only via the human-facing bridge (toggleGoal, Goals.md
  // checkbox sync). No 'goal.completed' event existed. Distilling a successful
  // execution into a reusable Skill was impossible — the raw material (action
  // episodics) sat in memory with no producer to read it.
  //
  // complete(id, opts?) is the autonomous path. It:
  //   1. sets status:'done' + reason + completedAt
  //   2. emits 'goal.completed' (new event name — conforms to bus naming)
  //   3. distills the goal's action history into a Skill via ONE bounded brain
  //      call on the 'simple' lane (idle-skip: skipped when no brain, no
  //      memory.skills, < 2 action episodics, or distillation fails — honest
  //      fallback, never fabricates a skill)
  //
  // Distillation is fire-and-forget (no await from the caller's perspective):
  // it must not block goal completion. Returns the updated goal synchronously.
  function complete(id, opts) {
    var goal = goals.get(id);
    if (!goal) return null;
    opts = opts || {};
    var prevStatus = goal.status;
    goal.status = 'done';
    goal.reason = opts.reason || 'completed';
    goal.completedAt = Date.now();
    saveGoal(id);
    if (bus) bus.emit('goal.completed', {
      id: id, title: goal.title, prevStatus: prevStatus,
      spent: goal.spent, budget: goal.budget
    });
    // Kick off distillation asynchronously — the caller doesn't wait on it.
    if (brain && memory && memory.skills && memory.episodic) {
      distillIntoSkill(goal).catch(function (err) {
        if (bus) bus.emit('health.anomaly', {
          kind: 'goal-distill-failed', target: id, error: err && err.message
        });
      });
    }
    return goal;
  }

  // Distill a completed goal's action history into a reusable Skill.
  // Reads the goal's action episodics, asks the brain for a compact procedure,
  // writes it via memory.skills.write(). Best-effort for local fs / parse
  // failures (silent null), but brain.think THROWS are propagated to the
  // caller (complete()'s .catch) — operators should know when distillation
  // infrastructure is broken, not just silently absent.
  async function distillIntoSkill(goal) {
    if (!brain || !memory || !memory.skills || !memory.episodic) return null;
    // Pull the goal's action history. We can't filter by goalId in episodic
    // directly (action episodics don't carry it today), so we use the recent
    // action window + the goal's title as a semantic filter.
    var actions = [];
    try {
      actions = memory.episodic.recall(goal.title, { kind: 'action', limit: 20 }) || [];
    } catch (_) { return null; }
    if (!actions || actions.length < 2) return null;   // not enough to distill

    // Compact the action trace for the brain prompt.
    var trace = actions.map(function (a, i) {
      var rec = a.record || a;
      var okFlag = rec.outcome === 'ok' ? 'ok' : 'FAIL';
      return (i + 1) + '. [' + okFlag + '] ' + (rec.summary || rec.tool || 'unknown');
    }).join('\n');

    // brain.think can throw on real infrastructure errors (provider misconfig,
    // network). The brain itself returns {offline:true} for routine offline —
    // those are silent. A throw propagates so complete()'s .catch emits an
    // anomaly. Don't wrap this call.
    var result = await brain.think({
      lane: 'simple',
      messages: [{ role: 'user', content:
        'A goal just completed successfully. Distill the action trace into a reusable procedure.\n' +
        'Goal: ' + goal.title + '\n' +
        'Action trace:\n' + trace + '\n\n' +
        'Respond as JSON: {"name": "<short-kebab-name>", "when": "<one-line trigger condition>", ' +
        '"steps": [{"tool": "<tool-name>", "args": {<required-params>}}, ...]}\n' +
        'Only include steps that SUCCEEDED. Skip exploration/probing steps. Keep it to 2-6 steps.'
      }],
      schemaHint: '{ name: string, when: string, steps: Array<{tool:string,args:object}> }',
      source: 'goal-distill:' + goal.id
    });
    if (!result || result.offline || result.aborted || !result.parsed) return null;
    var p = result.parsed;
    if (!p.name || !Array.isArray(p.steps) || p.steps.length === 0) return null;

    try {
      return memory.skills.write(p.name, {
        when: [p.when || goal.title],
        steps: p.steps,
        successCriteria: [],
        uses: 0,
        successRate: 0
      });
    } catch (_) { return null; }
  }

  // The symmetric counterpart to distillIntoSkill: when a goal's steps fail,
  // distill WHY into a durable Lesson the planner can ground against next time
  // (Layer 3 reads these via memory.lessons.recall). Mirrors distillIntoSkill's
  // shape exactly — same episodic window, same 'simple' lane, same fire-and-
  // forget contract (caller doesn't await). Only the prompt + the write target
  // differ (lessons instead of skills; "what to avoid" instead of "what worked").
  // Only called from markPlanStepDone when a step has failed AND we have ≥2
  // failure episodics to learn from — no point distilling a single transient flake.
  async function distillFailureIntoLesson(goal) {
    if (!brain || !memory || !memory.lessons || !memory.episodic) return null;
    var actions = [];
    try {
      actions = memory.episodic.recall(goal.title, { kind: 'action', limit: 20 }) || [];
    } catch (_) { return null; }
    // Keep only failures — success steps are irrelevant to a lesson about what's broken.
    var fails = actions.filter(function(a) {
      var r = a && (a.record || a);
      return r && r.outcome === 'fail';
    });
    if (!fails || fails.length < 2) return null;

    var trace = fails.slice(0, 12).map(function(a, i) {
      var rec = a.record || a;
      return (i + 1) + '. FAIL ' + (rec.summary || rec.tool || 'unknown') +
        (rec.detail ? ' — ' + String(rec.detail).slice(0, 160) : '');
    }).join('\n');

    var result = await brain.think({
      lane: 'simple',
      messages: [{ role: 'user', content:
        'A goal has been failing repeatedly. Distill ONE actionable lesson about what to do differently.\n' +
        'Goal: ' + goal.title + '\n' +
        'Failure trace:\n' + trace + '\n\n' +
        'Respond as JSON: {"lesson": "<one line: the failure mode and the fix>", ' +
        '"avoid": "<one line: which tool/approach to avoid>"}\n' +
        'Be concrete and specific. Do not blame the model; name the actual tool/arg/environment cause.'
      }],
      schemaHint: '{ lesson: string, avoid: string }',
      source: 'goal-fail-distill:' + goal.id
    });
    if (!result || result.offline || result.aborted || !result.parsed) return null;
    var p = result.parsed;
    var text = String(p.lesson || p.avoid || '').trim();
    if (!text) return null;
    try {
      return memory.lessons.recordFailure({ tool: p.avoid || '', goalTitle: goal.title }, text, { source: 'goal-failure' });
    } catch (_) { return null; }
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

  // Phase 4 / Area A (B-3): the planner used to be stateless — plan() returned
  // ONE next action every tick and forgot the rest. With V2/V3 we now persist
  // multi-step plans into goal.plan so:
  //   - procedural-skill steps execute in order (not just step[0] forever)
  //   - brain-returned plans survive across ticks (stateless → stateful)
  // Each step: { tool, args, status: 'pending'|'done'|'failed', rationale,
  //              skillRef?, _spentTokens? }
  // markPlanStepDone() advances the queue and is called from dispatchAction
  // after each step's outcome is recorded.

  async function plan(goal, ctx) {
    // 1. Check current plan for pending step
    if (goal.plan && goal.plan.length > 0) {
      for (var i = 0; i < goal.plan.length; i++) {
        if (goal.plan[i].status === 'pending') {
          var step = goal.plan[i];
          var decision = { tool: step.tool, args: step.args, rationale: step.rationale || 'plan-step' };
          if (step.skillRef) decision.skillRef = step.skillRef;
          return decision;
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
          // B-3 + V3 fix: persist the WHOLE skill procedure into goal.plan so
          // subsequent ticks step through it in order, not just step[0] forever.
          // Each step is marked 'pending' and advanced by markPlanStepDone().
          goal.plan = skillRec.steps.map(function (s) {
            return {
              tool: s.tool, args: s.args,
              rationale: 'procedural-skill',
              status: 'pending',
              skillRef: sref
            };
          });
          saveGoal(goal.id);
          var firstStep = goal.plan[0];
          firstStep.status = 'executing';
          saveGoal(goal.id);
          return {
            tool: firstStep.tool, args: firstStep.args,
            rationale: 'procedural-skill', offline: true,
            skillRef: sref
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
      // Learning loop (Layer 3): before spending a brain call, consult the
      // Lessons store + the recallCache the cortex already built (and which
      // this function previously discarded — see cortex/index.js:246-249) for
      // prior failures on this goal/approach. If the same (tool+argsHash+
      // goalTitle) failure has crossed GOAL_FAIL_PAUSE_THRESHOLD, pause the
      // goal with reason:'repeated-failure' instead of re-planning forever
      // (symmetric to the budget-exhausted pause above). Otherwise inject a
      // grounded "this failed before" block so the brain chooses differently.
      var failBlock = '';
      try {
        var failThreshold = Number((config && config.GOAL_FAIL_PAUSE_THRESHOLD) || 3);
        var lessonHits = [];
        if (ctx.memory && ctx.memory.lessons && typeof ctx.memory.lessons.recall === 'function') {
          lessonHits = ctx.memory.lessons.recall(goal.title, {
            limit: Number((config && config.LESSON_RECALL_LIMIT) || 5),
            trigger: { goalTitle: goal.title }
          }) || [];
        }
        // Also fold in outcome:'fail' entries from the recall cache the cortex
        // built for this tick. recallCache is currently computed-and-discarded
        // by this function; this is the read that closes that gap.
        var cacheFails = [];
        if (ctx.recallCache && Array.isArray(ctx.recallCache)) {
          cacheFails = ctx.recallCache.filter(function(h) {
            var r = h && (h.record || h);
            return r && r.outcome === 'fail';
          });
        }
        // Hard pause: a single lesson record whose count crossed the threshold.
        var hardPause = null;
        for (var li = 0; li < lessonHits.length; li++) {
          if ((lessonHits[li].count || 1) >= failThreshold) { hardPause = lessonHits[li]; break; }
        }
        if (hardPause) {
          goal.status = 'paused';
          goal.reason = 'repeated-failure';
          saveGoal(goal.id);
          if (bus) bus.emit('health.anomaly', {
            kind: 'recurring-failure', target: goal.id,
            detail: 'goal paused after ' + hardPause.count + ' repeated failures: ' + (hardPause.snippet || '').slice(0, 160)
          });
          return null;
        }
        if (lessonHits.length || cacheFails.length) {
          var lines = [];
          for (var lj = 0; lj < lessonHits.length && lines.length < 4; lj++) {
            lines.push('  - [x' + (lessonHits[lj].count || 1) + '] ' + (lessonHits[lj].snippet || '').slice(0, 180));
          }
          for (var cj = 0; cj < cacheFails.length && lines.length < 6; cj++) {
            var fr = cacheFails[cj].record || cacheFails[cj];
            lines.push('  - past FAIL: ' + String(fr.summary || fr.tool || 'unknown').slice(0, 180));
          }
          failBlock = '\n\n⚠️ PRIOR FAILURES on this goal — do NOT repeat these approaches unchanged:\n' + lines.join('\n') +
            '\nChoose a different tool, adjust args, or abandon the approach. Repeating a known-failing approach will pause this goal.';
        }
      } catch (_) { /* grounding is advisory — never block planning on it */ }

      var lane = goal.drive === 'user-service' ? 'build' : 'simple';
      // RC#1: build the available-tool list from the effector registry so the
      // planner can only choose real tools. Without this, the LLM hallucinated
      // names like 'clarify', 'ask_user', 'reason', 'search_files' that don't
      // exist — every one returned 'unknown-effector' and stalled the cortex.
      // BUG-013: also filter out suppressed tools (circuit breaker opened).
      // FIX A: render params alongside each tool name via ctx.effectors.catalog()
      // (hub.js's real {name, description, params} source, already consumed by
      // voice's buildCatalogFromHub) instead of a bare name list. A name-only list
      // gave the brain no way to know a tool's real arg shape, so it hallucinated
      // args by pattern-matching other tools (e.g. propose_goal({goal,steps}) —
      // copied from run_mission({goal}) — when the handler actually reads {text}),
      // which always failed and stalled the goal on an endless re-plan loop.
      var toolList = '';
      if (ctx.effectors && typeof ctx.effectors.catalog === 'function') {
        var healer = require('../immune/healer');
        var entries = ctx.effectors.catalog().filter(function(e) {
          // BUG-013: also filter out suppressed tools (circuit breaker opened).
          return AUTONOMOUS_EXCLUDED.indexOf(e.name) === -1 && !healer.isToolSuppressed(e.name);
        });
        toolList = 'You may ONLY choose a tool from this list (use the exact name and args):\n' +
          entries.map(function(e) {
            var paramsText = e.params && Object.keys(e.params).length
              ? Object.keys(e.params).map(function(p) { return p + ': ' + e.params[p]; }).join(', ')
              : '';
            return '  - ' + e.name + '(' + paramsText + ')' + (e.description ? ' — ' + e.description : '');
          }).join('\n') +
          '\nDo NOT invent tool names or args. If none of these tools fit, return {"tool":"", "args":{}}.';
      } else if (ctx.effectors && typeof ctx.effectors.count === 'function') {
        // REMEDIATION P2-10: without a real catalog(), fall back to the
        // original bare name-only list rather than silently leaving toolList
        // empty — an empty list gave the brain NO guidance at all, worse than
        // the pre-FIX-A behavior this was meant to improve on.
        var healerFallback = require('../immune/healer');
        var iter = ctx.effectors.effectors;
        var names = iter && typeof iter.keys === 'function'
          ? Array.from(iter.keys()).filter(function(n) {
              return AUTONOMOUS_EXCLUDED.indexOf(n) === -1 && !healerFallback.isToolSuppressed(n);
            })
          : [];
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
            toolList + skillsHint + failBlock + '\n\nPlan next action for goal: ' + goal.title +
            '\n\nGROUNDING: If this goal involves current events, real-time data, news, dates, or anything that could be stale, use web_search or web_fetch FIRST to get real data before planning actions.' +
            // V3 (Phase 4): allow the brain to OPTIONALLY return a multi-step
            // plan. If it returns steps, we persist them to goal.plan and they
            // execute in order across subsequent ticks (markPlanStepDone). If
            // it returns tool+args only (the original shape), that still works.
            '\nRespond as JSON: {"tool": "<exact tool name>", "args": {<required params>}, "plan"?: [{"tool": "...", "args": {...}}, ...]}' +
            '\nUse "plan" only when you can confidently sequence 2-6 steps now. Otherwise return just tool+args.'
          }],
          schemaHint: '{ tool: string, args: object, plan?: Array<{tool:string,args:object}> }',
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
          // V3 (Phase 4): if the brain returned a multi-step "plan", validate
          // each step's tool name and persist to goal.plan. Only the first step
          // is dispatched this tick; subsequent ticks pick up the rest via the
          // plan-step branch at the top of plan(). Single-step returns (no
          // "plan" field) work exactly as before.
          if (Array.isArray(result.parsed.plan) && result.parsed.plan.length > 1) {
            var validSteps = [];
            var brainPlanValid = true;
            for (var pi = 0; pi < result.parsed.plan.length; pi++) {
              var ps = result.parsed.plan[pi];
              if (!ps || !ps.tool || AUTONOMOUS_EXCLUDED.indexOf(ps.tool) !== -1) {
                brainPlanValid = false; break;
              }
              if (regNames && regNames.length > 0 && regNames.indexOf(ps.tool) === -1) {
                brainPlanValid = false; break;
              }
              validSteps.push({
                tool: ps.tool, args: ps.args || {},
                rationale: 'brain-planned', status: 'pending'
              });
            }
            if (brainPlanValid && validSteps.length > 1) {
              goal.plan = validSteps;
              saveGoal(goal.id);
            }
            // Even on plan-validation failure we still dispatch the validated
            // top-level tool — just don't persist the queue.
          }
          return { tool: result.parsed.tool, args: result.parsed.args || {}, rationale: 'brain-planned', done: false, _spentTokens: result.spentTokens || 0 };
        }
      } catch (err) { if (bus) bus.emit('health.anomaly', { kind: 'planner-brain-failed', error: err.message }); }
    }

    return null;
  }

  // Phase 4 / Area A (B-3): advance the plan queue after a step finishes.
  // Called by dispatchAction once the action outcome is recorded. Marks the
  // current 'executing' step done|failed and clears the queue if every step
  // has resolved (so plan() will re-plan fresh next tick).
  // `unverified` is the evidence contract's third outcome (see
  // effectors/dispatch-action.js): the effector returned ok:true but could NOT
  // prove the world changed. It must resolve the step WITHOUT scoring it —
  // 'done' would launder an unproven action into a success, and 'failed' would
  // (wrongly) charge failCount and trip distillFailureIntoLesson below. It must
  // also not be left 'pending': plan() dispatches the first pending step every
  // tick, so leaving it pending re-runs a real world-changing action (typing,
  // clicking) forever. Hence a third terminal status, counted as resolved by
  // the allDone sweep but excluded from every failure signal.
  function markPlanStepDone(goalId, success, unverified) {
    var goal = goals.get(goalId);
    if (!goal || !goal.plan || goal.plan.length === 0) return;
    var idx = -1;
    for (var i = 0; i < goal.plan.length; i++) {
      if (goal.plan[i].status === 'executing' || goal.plan[i].status === 'pending') {
        idx = i; break;
      }
    }
    if (idx === -1) return;
    var scoredFailure = !success && !unverified;
    goal.plan[idx].status = unverified ? 'unverified' : (success ? 'done' : 'failed');
    // Track per-goal failure count so plan()'s repeated-failure pause (Layer 3)
    // and distillFailureIntoLesson (Layer 4) have a signal to key on.
    if (scoredFailure) {
      goal.failCount = (goal.failCount || 0) + 1;
    }
    // Clear the queue when all steps have resolved so plan() re-plans fresh.
    var allDone = goal.plan.every(function (s) {
      return s.status === 'done' || s.status === 'failed' || s.status === 'unverified';
    });
    if (allDone) goal.plan = [];
    saveGoal(goal.id);
    // Learning loop (Layer 4): when a step fails AND the goal has accumulated
    // repeated failures, asynchronously distill a lesson. Fire-and-forget so the
    // dispatch path isn't blocked — same contract as complete()→distillIntoSkill.
    // The threshold mirrors REFLECTION_ACTION_MIN's intent: don't distill a
    // single transient flake, wait for a real pattern.
    if (scoredFailure && brain && memory && memory.lessons && goal.failCount >= 2) {
      distillFailureIntoLesson(goal).catch(function (err) {
        if (bus) bus.emit('health.anomaly', {
          kind: 'goal-fail-distill-failed', target: goal.id, error: err && err.message
        });
      });
    }
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

  // grantTier(id, tier, tools) — record that a human approved `tools` at `tier`
  // for this goal, so those specific actions don't re-prompt for the rest of the
  // goal's life.
  //
  // SECURITY: `tools` is REQUIRED and the grant is scoped to it. This used to
  // store a bare `true`, which leash.check() honoured for every tool at that
  // tier — so approving one Forge build plan silently handed the goal a
  // standing pass for gmail_send, delete_file, run_command, phone_call and
  // every other T3 tool that later carried the same goalId (reachable via
  // engagements' LLM-authored action stages and via cortex's autonomous ticks).
  // A grant now names what was approved, and nothing else matches.
  //
  // Stored as an ARRAY, not a Set: the goal record is persisted as JSON and a
  // Set serialises to {}. Missing/empty/non-array `tools` grants nothing — the
  // fail-closed direction, since a grant we cannot describe is a grant we
  // cannot safely honour.
  function grantTier(id, tier, tools) {
    var goal = goals.get(id);
    if (!goal) return;
    var list = Array.isArray(tools)
      ? tools.filter(function(t) { return typeof t === 'string' && t.length > 0; })
      : [];
    if (list.length === 0) {
      if (bus) bus.emit('health.anomaly', { kind: 'goal-grant-empty', target: id, evidence: { tier: tier } });
      return;
    }
    var key = String(tier);
    var existing = Array.isArray(goal.grants[key]) ? goal.grants[key] : [];
    var merged = existing.slice();
    for (var i = 0; i < list.length; i++) {
      if (merged.indexOf(list[i]) === -1) merged.push(list[i]);
    }
    goal.grants[key] = merged;
    saveGoal(id);
    if (bus) bus.emit('goal.tier-granted', { id: id, tier: tier, tools: merged });
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
            data.budget = data.budget || { tokens: (config && config.GOAL_TOKEN_BUDGET) || GOAL_TOKEN_BUDGET_FALLBACK, actions: (config && config.GOAL_ACTION_BUDGET) || 25, deadline: null };
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
    complete, markPlanStepDone,
    init, stats,
    _internal: { DRIVE_WEIGHTS, goalRelevance, goals: function() { return goals; } }
  };
}

module.exports = { createGoalSystem, DRIVE_WEIGHTS };
