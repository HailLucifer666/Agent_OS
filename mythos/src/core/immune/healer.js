'use strict';

// immune/healer.js — playbook-driven auto-remediation. Playbooks are DATA, never
// code eval. Per-playbook cooldownMs is the ONLY de-duplication mechanism: upstream
// producers (probes.js, watchdog.js) are allowed — expected — to re-emit the same
// anomaly on every poll; cooldown is what keeps that from becoming a heal storm.

// Task C2 (2026-08-12 live-session finding): reprobe-build-engine's own comment
// says it is "Always ok:true — the action's job is to re-probe and report, not
// to guarantee Hermes comes back online". That is exactly the effector-reports-
// success-without-an-oracle defect dispatch-action.js's evidence contract
// already rejects everywhere else — 'healed: build-engine-failed' was
// announced at 01:05:05 and 02:24:22 while the identical anomaly kept firing
// for another minute (four recurrences each) because the real cause
// (a missing OPENAI_API_KEY) was nothing a reprobe could fix. 60000ms matches
// that observed recurrence window (all four repeats landed inside the same
// minute) and is deliberately equal to this playbook's own cooldownMs below,
// so a verification never outlives the window the cooldown already blocks
// re-application for.
const BUILD_ENGINE_VERIFY_MS = 60000;

// Task C2 review follow-up: probe-provider (used by rotate-nim-key below) is
// structurally the same defect as reprobe-build-engine — registry.refresh()
// returns { ok: true, result: { probedAt } } unconditionally; probedAt is a
// timestamp, not an online/down verdict, so ok:true is no more proof nim
// actually came back than reprobe-build-engine's ok:true was proof Hermes
// did. There is no logged incident giving an observed recurrence window for
// this one (unlike build-engine-reprobe's four-repeats-in-a-minute), so this
// reuses the playbook's own cooldownMs as the verification window — same
// reasoning as build-engine-reprobe, just without evidence to justify a
// different number.
const PROVIDER_ROTATE_VERIFY_MS = 60000;

// F1: a terminally-failed tool stays out of the planner's catalog until the
// process restarts — which is exactly when the operator's remedy (re-auth,
// new key in .env) takes effect anyway. 24h is "the rest of this session"
// expressed as a TTL, so the existing restoreTimer needs no special case.
const TERMINAL_SUPPRESS_MS = 24 * 60 * 60 * 1000;

const SEED_PLAYBOOKS = [
  {
    // The id is load-bearing in stored audit rows (briefing-facts reads
    // playbookId) so it is deliberately NOT renamed with the match.
    id: 'rotate-nim-key',
    // B3: the title IS spoken (BUG-162 added titles so the announcer could say
    // WHAT was healed), so widening the match to any provider made the old
    // "NVIDIA provider key rotation" a spoken falsehood for a mistral or groq
    // outage. It was already inaccurate: the probe-provider action below ignores
    // its args entirely and calls registry.refresh(true) — a global re-probe, not
    // a key rotation. The title now says what the action does.
    title: 'provider re-probe after a reported outage',
    // B3 (2026-08-14): was `target: { eq: 'nim' }`. groq and mistral both went
    // down that day (15:50:37) and got no-match — the immune system watched two
    // providers fail and had nothing to do about either, because the only
    // provider-down playbook was hardcoded to the one provider whose key can be
    // rotated. `$target` makes the action follow the provider that actually
    // failed. rotateKey stays true because probe-provider only rotates when a
    // second key exists for that provider (NIM_API_KEY_2) and is a no-op
    // otherwise, so widening the match cannot invent a rotation.
    //
    // The irony worth recording: nim IS the one provider this playbook did match,
    // it was broken all day, and B1 — 8 seconds of dead time on every vision call
    // — is the consequence of nothing acting on that.
    //
    // Bounded deliberately: the match widens, the ceilings do not. cooldownMs and
    // the pendingVerifications recurrence path below are unchanged, so three
    // providers flapping cannot become three remediations a second.
    when: { kind: 'provider-down' },
    then: [{ do: 'probe-provider', args: { provider: '$target', rotateKey: true } }],
    cooldownMs: 60000,
    // Task C2: probe-provider's ok:true is not proof nim is back — see the
    // comment above. Hold the claim open for verifyMs, same mechanism as
    // build-engine-reprobe.
    verifyMs: PROVIDER_ROTATE_VERIFY_MS
  },
  {
    id: 'stall-restart',
    title: 'cortex restart after a stall',
    when: { kind: 'cortex-stall' },
    then: [{ do: 'restart-cortex' }],
    cooldownMs: 30000
  },
  {
    id: 'quota-guard',
    title: 'voice-lane degrade on low Groq quota',
    when: { kind: 'quota-low', target: { eq: 'groq' } },
    then: [{ do: 'degrade-lane', args: { lane: 'voice', removeProvider: 'groq' } }],
    cooldownMs: 300000
  },
  {
    id: 'mem-consolidate',
    title: 'memory consolidation after growth',
    // 50000000 must equal monitor.js's MEMORY_GROWTH_BYTES — see Spec Ambiguities
    // Resolved #19; immune.test.js asserts the two literals stay in sync.
    when: { kind: 'memory-growth', target: { bytes: { gt: 50000000 } } },
    then: [{ do: 'consolidate-memory' }],
    cooldownMs: 600000
  },
  {
    id: 'budget-pause',
    title: 'goal pause on exhausted budget',
    when: { kind: 'budget-exhausted' },
    then: [{ do: 'pause-goal', args: { reason: 'budget-exhausted' } }],
    cooldownMs: 0 // no cooldown — immediate, every time
  },
  {
    id: 'effector-flapping-breaker',
    title: 'suppression of a flapping tool',
    when: { kind: 'effector-flapping' },
    then: [{ do: 'suppress-tool', args: { tool: '$target' } }],
    cooldownMs: 60000
  },
  // F1 (2026-08-15): a terminal failure is not a flap. The hub keeps the breaker
  // CLOSED and refuses to dispatch the tool again, so the 60s cooldown that the
  // flapping playbook uses would only put a dead tool back in the planner's
  // catalog every minute for the rest of the session. ttlMs is the whole point
  // of this entry existing separately.
  {
    id: 'effector-terminal-suppress',
    title: 'suppression of a terminally-failed tool',
    when: { kind: 'effector-terminal' },
    then: [{ do: 'suppress-tool', args: { tool: '$target', ttlMs: TERMINAL_SUPPRESS_MS } }],
    cooldownMs: 0
  },
  // REMEDIATION P2-10 (2026-07-29 audit, item 11): search-provider-failed and
  // build-engine-failed both returned 'no-match' — the immune system detected
  // the two failures that actually mattered in the audited session and had
  // nothing to do about either. web_search() already retries across its own
  // provider chain within one call (exa -> exa-mcp -> ddg-html -> ddg-lite ->
  // wikipedia), so "retry" is already covered; what the healer adds is
  // skipping a provider that keeps failing on FUTURE calls instead of paying
  // its full PROBE_TIMEOUT every time, and reprobe-build-engine surfaces the
  // item-6 CLI probe diagnostic (ENOENT vs timeout vs exit code) instead of
  // leaving P0-1-class failures undiagnosable.
  {
    id: 'search-provider-degrade',
    title: 'skip of a failing search provider',
    when: { kind: 'search-provider-failed' },
    then: [{ do: 'suppress-search-provider', args: { provider: '$evidence.provider' } }],
    cooldownMs: 30000
  },
  {
    id: 'build-engine-reprobe',
    title: 'build-engine reprobe',
    when: { kind: 'build-engine-failed' },
    then: [{ do: 'reprobe-build-engine' }],
    cooldownMs: 60000,
    // Task C2: reprobe-build-engine cannot prove the anomaly is actually
    // gone (see comment above) — hold the claim open for verifyMs before
    // reporting 'applied'. See createHealer()'s onDiagnosed/checkVerifications.
    verifyMs: BUILD_ENGINE_VERIFY_MS
  },
  // Learning loop closure: reflection.js:215 emits 'recurring-failure' when
  // reflectOnActions spots a repeated failure mode in the action trace. Before
  // this playbook existed, the signal fell through to no-match and died — the
  // agent detected its own repeated mistakes and forgot them. record-lesson
  // makes the failure durable in the Lessons store, where the goal planner
  // (goals/index.js Layer 3) reads it before its next brain call. The cooldown
  // is deliberately short (30s) so a burst of the same failure still records
  // promptly; recordFailure() dedups by trigger so repeated fires increment
  // count rather than spawning duplicate files.
  {
    id: 'recurring-failure-record',
    title: 'recording of a repeated failure as a lesson',
    when: { kind: 'recurring-failure' },
    then: [{ do: 'record-lesson', args: { lesson: '$evidence.detail', source: 'reflection' } }],
    cooldownMs: 30000
  },
  // Wave 7 (2026-08-13) — see retry-aether-proxy's own comment for why this is
  // a same-port retry, never a port shift. 15s cooldown: long enough that a
  // genuinely-held port (another real process, not a stale exit) doesn't spin
  // a bind attempt every tick, short enough that a stale instance's exit
  // (typically sub-second) is recovered from well inside one operator-noticed
  // "why is Aether down" window.
  {
    id: 'aether-proxy-rebind',
    title: 'Aether scanner-proxy rebind',
    when: { kind: 'aether-proxy-bind-failed' },
    then: [{ do: 'retry-aether-proxy' }],
    cooldownMs: 15000
  },
  // F8 (2026-08-15) — THE FIVE KINDS THAT MATCHED NOTHING.
  //
  // 26 anomalies in the 2026-08-14 session reached no-match, and four kinds
  // account for all of the recurring ones: live-turn-no-user-transcript x16,
  // live-turn-silent x3, claimed-action-not-taken x2,
  // live-tool-outcome-late-for-turn x1. (build-engine-fallback-used x4 was the
  // fifth and can no longer be emitted at all — see build-engine.js's F5 note.)
  //
  // The no-match path is expensive: it is what invokes the immune explainer,
  // whose episodic recall was the measured source of loop.stalled. So leaving the
  // MOST COMMON anomalies unmatched made the costly branch the default outcome.
  //
  // These are acknowledged, NOT healed, and that distinction is deliberate. None
  // of them has a remediation the healer can perform — the first is a client-side
  // audio-gate condition, the second a provider behaviour, the third a
  // model-honesty check, the fourth a timing race. Inventing a "fix" for any of
  // them would be worse than admitting there isn't one. What acknowledgement buys
  // is that the system stops treating a known, understood, already-instrumented
  // condition as an unexplained emergency.
  //
  // NOTHING IS HIDDEN BY THIS (rules/core.md §11.2). The health.anomaly records
  // are stored by the server's anomaly subscriber independently of the healer, so
  // every occurrence remains countable in the vault exactly as before; what
  // changes is only that a brain call and a 7-day episodic scan no longer fire
  // for a condition nobody can act on from here.
  {
    id: 'live-turn-no-transcript-known',
    title: 'a Live turn that arrived with no operator transcript',
    when: { kind: 'live-turn-no-user-transcript' },
    then: [{ do: 'acknowledge', args: {
      note: 'Known condition, no automatic remedy. The operator\'s speech reaches Gemini but is '
        + 'not transcribed, most often because the half-duplex gate held it past the preroll ring '
        + '(see s2s-bridge.js F3) or because what reached the VAD was MYTHOS\'s own voice. The '
        + 'release log\'s framesDropped/heldMs is the evidence to read, not this anomaly.',
    } }],
    cooldownMs: 60000
  },
  {
    id: 'live-turn-silent-known',
    title: 'a Live turn that produced text but no audio',
    when: { kind: 'live-turn-silent' },
    then: [{ do: 'acknowledge', args: {
      note: 'Known condition, already remediated elsewhere: BUG-170\'s re-speak path routes a '
        + 'silent turn to the TTS chain with skipLive. Nothing further for the healer to do.',
    } }],
    cooldownMs: 60000
  },
  {
    id: 'claimed-action-not-taken-known',
    title: 'a spoken claim with no tool call behind it',
    when: { kind: 'claimed-action-not-taken' },
    then: [{ do: 'acknowledge', args: {
      note: 'Known condition, handled in-band: the claim checker already injects a correction on '
        + 'the turn itself. Note that a FALSE positive here is worse than a miss — on 2026-08-14 '
        + 'both instances were the detector\'s own category gap (F1b), not the model lying.',
    } }],
    cooldownMs: 60000
  },
  {
    id: 'live-tool-outcome-late-known',
    title: 'a tool outcome that arrived after its turn ended',
    when: { kind: 'live-tool-outcome-late-for-turn' },
    then: [{ do: 'acknowledge', args: {
      note: 'Known condition, by design: reportLateOutcome() pushes the real result into the next '
        + 'turn through the [SYSTEM] channel. This anomaly records the race, it does not report a '
        + 'fault.',
    } }],
    cooldownMs: 60000
  }
];

// ---------------------------------------------------------------------------
// DSL evaluator — equality + lt/gt + nested-field matching (Spec Ambiguities #13)
// ---------------------------------------------------------------------------

function matchClause(clause, value) {
  if (clause === undefined) return true; // an absent `when.target` matches any target
  if (clause !== null && typeof clause === 'object' && !Array.isArray(clause)) {
    if ('eq' in clause) return value === clause.eq;
    if ('lt' in clause) return typeof value === 'number' && value < clause.lt;
    if ('gt' in clause) return typeof value === 'number' && value > clause.gt;
    // Otherwise every key is a nested field name on `value` — recurse.
    for (const key in clause) {
      const nested = value && typeof value === 'object' ? value[key] : undefined;
      if (!matchClause(clause[key], nested)) return false;
    }
    return true;
  }
  return value === clause;
}

function matches(playbook, diagnosis) {
  if (playbook.when.kind !== diagnosis.kind) return false;
  return matchClause(playbook.when.target, diagnosis.target);
}

// $-prefixed string args resolve against the diagnosis via dotted path, e.g.
// '$target' -> diagnosis.target. None of the SEED_PLAYBOOKS above use this — it
// exists for future playbooks and is covered by a dedicated unit test.
function getPath(obj, dottedPath) {
  return dottedPath.split('.').reduce(function(acc, key) {
    return acc && typeof acc === 'object' ? acc[key] : undefined;
  }, obj);
}

function resolveArgs(args, diagnosis) {
  const out = {};
  const source = args || {};
  for (const key in source) {
    const v = source[key];
    out[key] = (typeof v === 'string' && v.charAt(0) === '$') ? getPath(diagnosis, v.slice(1)) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Action implementations
// ---------------------------------------------------------------------------

// RC#4: tracks degraded lanes with TTL so they auto-restore after the cooldown.
// Keyed by lane name → { env: envVarName, restoreAt: timestamp }
var degradedLanes = {};

// BUG-013: tracks suppressed tools with TTL so they auto-restore after the cooldown.
// Keyed by tool name → { restoreAt: timestamp }. When a tool flaps (circuit breaker opens),
// the healer suppresses it from the planner's available-tool list, forcing the brain to
// choose a different approach on the next decision cycle.
var suppressedTools = {};

// REMEDIATION P2-10: same TTL-map pattern as suppressedTools above, scoped to
// web-search's provider chain instead of the effector-tool catalog. Keyed by
// provider name (e.g. 'ddg-html', 'exa') → { restoreAt: timestamp }.
var suppressedSearchProviders = {};

function buildActions({ getCortex, getGoals, memory, getScannerProxy }) {
  const registry = require('../brain/registry');
  const { BRAIN_TABLES } = require('../brain/lanes.default');

  return {
    // Wave 7 (2026-08-13) — the aether-proxy-bind-failed anomaly (main.js)
    // used to just stop() and leave the proxy dead for the rest of the
    // process; nothing ever tried again. scanner-proxy.js's own start()/stop()
    // comments document exactly this as the sanctioned recovery path ("the
    // caller retry start() after fixing whatever held the port") — most
    // commonly a stale MYTHOS instance still releasing its ports on exit,
    // which a same-port retry after a short cooldown recovers from cleanly.
    // Deliberately NOT a port shift: "PORT ORDER IS THE CONTRACT" (that
    // file's own header) — the aggregator's --peers list is a separate,
    // externally-run process pointed at these exact ports, so silently
    // moving to a different base would misattribute readings to the wrong
    // room instead of failing loudly. Same ports, retried, or an honest
    // failure — never a quiet renumbering.
    'retry-aether-proxy': async function() {
      const proxy = getScannerProxy && getScannerProxy();
      if (!proxy) return { ok: false, reason: 'missing-dependency:scanner-proxy' };
      try {
        proxy.start();
        await proxy.whenReady();
        return { ok: true, result: { ports: typeof proxy.ports === 'function' ? proxy.ports() : null } };
      } catch (err) {
        return { ok: false, reason: 'bind-failed-again', detail: err && err.message };
      }
    },
    // registry.js has no selective per-provider refresh and no live key-swap
    // capability — NIM's own two-key rotation is already structural in chain.js's
    // expand(). The real, honest action is a full forced re-probe (Spec Ambiguities #11).
    'probe-provider': async function() {
      const status = await registry.refresh(true);
      return { ok: true, result: { probedAt: status.at } };
    },

    'restart-cortex': async function() {
      const cortex = getCortex && getCortex();
      if (!cortex) return { ok: false, reason: 'missing-dependency:cortex' };
      // Pause the active goal BEFORE restarting — cortex.stop()/start() bumps
      // generation but does not touch goal state; recovery invariant #2 (§13)
      // requires the interrupted goal to be marked, not silently re-arbitrated
      // as if nothing happened.
      const goals = getGoals && getGoals();
      const activeGoal = goals && typeof goals.getActive === 'function' ? goals.getActive() : null;
      if (activeGoal) {
        goals.update(activeGoal.id, { status: 'paused', reason: 'cortex-restart' });
      }
      cortex.stop();
      cortex.start();
      return { ok: true, result: { generation: cortex.generation, pausedGoalId: activeGoal ? activeGoal.id : null } };
    },

    // Real mutable seam: registry.js's per-lane env override, read fresh on every
    // chainFor() call (Spec Ambiguity #12).
    // RC#4: track degradation with a TTL so the provider is automatically restored
    // when the cooldown window expires. Previously this permanently mutated
    // process.env[table.env] with no restore path — after one quota-low event, groq
    // was gone from the voice lane until process restart.
    'degrade-lane': async function(diagnosis, args) {
      const table = BRAIN_TABLES[args.lane];
      if (!table) return { ok: false, reason: 'unknown-lane:' + args.lane };
      const kept = table.prefs.filter(function(p) { return p.provider !== args.removeProvider; });
      const override = kept.map(function(p) { return p.provider + ':' + p.model; }).join(',');
      process.env[table.env] = override;
      // Track when this degradation should be reversed (5 min = the quota-guard
      // playbook cooldown). The healer's tick loop checks degradedLanes and
      // restores expired entries via restore-lane.
      degradedLanes[args.lane] = { env: table.env, restoreAt: Date.now() + 300000 };
      return { ok: true, result: { lane: args.lane, removed: args.removeProvider, override: override } };
    },

    // RC#4: restore a degraded lane by clearing the env override so registry.js
    // falls back to the built-in BRAIN_TABLES preference list.
    'restore-lane': async function(diagnosis, args) {
      var entry = degradedLanes[args.lane];
      if (!entry) return { ok: false, reason: 'lane-not-degraded:' + args.lane };
      delete process.env[entry.env];
      delete degradedLanes[args.lane];
      return { ok: true, result: { lane: args.lane, restored: true } };
    },

    'consolidate-memory': async function() {
      if (!memory || typeof memory.consolidate !== 'function') {
        return { ok: false, reason: 'missing-dependency:memory' };
      }
      const stats = await memory.consolidate({});
      return { ok: true, result: stats };
    },

    // Idempotent: goals/index.js's debitBudget() already self-pauses synchronously
    // on budget exhaustion (Spec Ambiguities #9) — this confirms/audits, never
    // double-transitions.
    'pause-goal': async function(diagnosis, args) {
      const goals = getGoals && getGoals();
      if (!goals) return { ok: false, reason: 'missing-dependency:goals' };
      const goalId = diagnosis.target;
      const goal = goals.get(goalId);
      if (!goal) return { ok: false, reason: 'unknown-goal:' + goalId };
      if (goal.status !== 'paused') {
        goals.update(goalId, { status: 'paused', reason: args.reason || 'healer-pause' });
      }
      return { ok: true, result: { goalId: goalId, reason: args.reason || 'healer-pause' } };
    },

    // BUG-013: suppress a flapping tool for its cooldown window. When a tool's circuit
    // breaker opens (repeated failures), the healer injects it into the suppressedTools
    // map so the planner's next brain call excludes it from the available-tool list.
    // The planner checks suppressedTools() (exported below) and filters them out.
    'suppress-tool': async function(diagnosis, args) {
      const toolName = args.tool;
      if (!toolName) return { ok: false, reason: 'missing-arg:tool' };
      // Track the suppression with a TTL (cooldown window from the playbook).
      // The tick loop's restoreTimer (RC#4) also restores expired suppressions.
      // F1: ttlMs is opt-in — omitting it keeps the original 60s flap cooldown.
      var ttlMs = Number(args.ttlMs) > 0 ? Number(args.ttlMs) : 60000;
      suppressedTools[toolName] = { restoreAt: Date.now() + ttlMs };
      return { ok: true, result: { tool: toolName, suppressedUntil: suppressedTools[toolName].restoreAt } };
    },

    // REMEDIATION P2-10: web_search() already retries across its full provider
    // chain within one call — this action's job is to make the NEXT call skip
    // a provider that just failed (saving a wasted PROVIDER_TIMEOUT) rather
    // than re-attempting a known-currently-bad endpoint. web-search.js checks
    // isSearchProviderSuppressed() before trying each provider.
    'suppress-search-provider': async function(diagnosis, args) {
      const provider = args.provider;
      if (!provider) return { ok: false, reason: 'missing-arg:provider' };
      suppressedSearchProviders[provider] = { restoreAt: Date.now() + 30000 };
      return { ok: true, result: { provider: provider, suppressedUntil: suppressedSearchProviders[provider].restoreAt } };
    },

    // REMEDIATION P2-10 / P0-1: force a fresh Hermes probe (bypassing
    // PROBE_TTL_MS's cache) and surface the item-6 CLI probe diagnostic
    // (ENOENT vs timeout vs non-zero exit) instead of leaving a build-engine
    // failure with no path to re-check or diagnose it.
    //
    // F5 (2026-08-15): this used to be unconditionally ok:true, on the argument
    // that the action's job is to re-probe and report rather than to guarantee
    // recovery. That made it a heal that could never fail — and in the
    // 2026-08-14 session it duly "succeeded" four times while every build failed,
    // because probe() only ran a version check and the binary was fine. An
    // action whose success is unconditional cannot tell anyone anything.
    //
    // It now answers the question the anomaly actually asks: is the build engine
    // usable? ONLINE with an unresolved real-task failure is NOT usable, and is
    // exactly the state that was misreported. lastTaskFailure is the only field
    // in the status derived from a content call.
    'reprobe-build-engine': async function() {
      var engineAdapter;
      try {
        engineAdapter = require('../../../adapters/dsh-agent');
      } catch (err) {
        return { ok: false, reason: 'missing-dependency:dsh-agent', detail: err.message };
      }
      const online = await engineAdapter.probe(true);
      const status = engineAdapter.getStatus();
      const detail = {
        online: online, state: status.state, hint: status.hint,
        probeDiagnostic: status.probeDiagnostic,
        // What the ONLINE verdict is actually based on — a matched version
        // banner, or a timed-out probe assumed present. Neither is evidence
        // that a build will produce content.
        evidence: status.evidence,
        lastTaskFailure: status.lastTaskFailure,
      };
      if (!online) return { ok: false, reason: 'build-engine-offline', result: detail };
      if (status.lastTaskFailure) {
        return { ok: false, reason: 'build-engine-online-but-last-task-failed', result: detail };
      }
      return { ok: true, result: detail };
    },

    // F8: a deliberate, documented no-op. It exists so a KNOWN condition with no
    // healer-side remedy stops falling through to the expensive no-match path,
    // and it is honest about doing nothing — the note says what the condition is
    // and where the real evidence lives. It must never grow an action; the moment
    // one of these has a real remedy it gets its own playbook entry instead.
    'acknowledge': async function(diagnosis, args) {
      return { ok: true, result: {
        acknowledged: diagnosis && diagnosis.kind,
        target: (diagnosis && diagnosis.target) || null,
        note: (args && args.note) || 'known condition, no automatic remedy',
        healed: false,
      } };
    },

    // Learning loop: write a recurring-failure lesson so the planner can avoid
    // it next time. The recurring-failure anomaly (reflection.js:215) carries a
    // one-line `detail` describing the failure mode; recordFailure() dedups by
    // trigger so repeated fires of the same mode increment count, not files.
    // best-effort — never fails the heal if the store is unavailable.
    'record-lesson': async function(diagnosis, args) {
      if (!memory || !memory.lessons || typeof memory.lessons.recordFailure !== 'function') {
        return { ok: false, reason: 'missing-dependency:lessons' };
      }
      var lesson = args && args.lesson;
      if (!lesson) return { ok: false, reason: 'missing-arg:lesson' };
      // Wave 0 (2026-08-13): the recurring-failure anomaly now carries a
      // best-effort `target` (reflection.js's targetFor()) recovered from the
      // FAIL actions that fed the brain call. Use it when present; recordFailure
      // still dedups by trigger identity across repeated fires either way.
      var trigger = { tool: (diagnosis && diagnosis.target) || '', argsHash: '0', goalTitle: String(lesson).slice(0, 60) };
      try {
        var res = memory.lessons.recordFailure(trigger, lesson, { source: args.source || 'reflection' });
        return { ok: true, result: { ref: res.ref, count: res.count, isNew: res.isNew } };
      } catch (err) {
        return { ok: false, reason: 'record-lesson-failed', detail: err.message };
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Healer
// ---------------------------------------------------------------------------

function createHealer({ bus, config, memory, getCortex, getGoals, getEffectors, getScannerProxy, playbooks, now }) {
  if (!bus) throw new Error('createHealer requires bus');

  const ACTIONS = buildActions({ getCortex: getCortex, getGoals: getGoals, memory: memory, getScannerProxy: getScannerProxy });
  const activePlaybooks = playbooks || SEED_PLAYBOOKS;
  const lastFiredAt = {}; // playbook.id -> ts
  // Task C2: injected clock (mirrors planner/daily.js's nowFn seam) so tests
  // can advance the verification window without a real sleep.
  const nowFn = typeof now === 'function' ? now : Date.now;
  // Task C2: playbook.id -> { verifyAt, appliedAt, kind, target, detail, title, actions }.
  // A heal that has been applied but not yet confirmed lives here until
  // either checkVerifications() finds no recurrence past verifyAt
  // (-> 'applied'), or onDiagnosed sees ANY further diagnosis matching this
  // playbook while the entry is still here — that presence, not cooldown
  // arithmetic, IS the recurrence signal (-> 'heal-failed').
  const pendingVerifications = {};
  // B3: "kind:target" -> { at, suppressed }. See the damping block in
  // onDiagnosed. Config-tunable but with a real default, because the measured
  // storm was one every ~2s and the point is to collapse that, not to tune it.
  const noMatchSeen = {};
  const NO_MATCH_DAMP_MS = (config && config.HEAL_NO_MATCH_DAMP_MS) || 30000;
  var restoreTimer = null;

  // Task C2: resolve any pending verification whose window has closed with no
  // recurrence. Exposed via _internal so tests can resolve it on demand
  // against an injected clock instead of a real wait — calling it directly
  // is exact. In production it only runs off the 60s restore tick below,
  // which is NOT aligned to any individual verifyAt, so a genuine heal can
  // sit confirmed-but-unannounced for up to one full tick after its window
  // closes (worst case ~2x verifyMs elapsed before 'applied' is emitted).
  // It can never resolve early — a real recurrence is still caught the
  // instant it arrives, via onDiagnosed's pendingVerifications check above,
  // not via this tick — so the slop only delays good news, never permits a
  // false one.
  function checkVerifications() {
    var ts = nowFn();
    Object.keys(pendingVerifications).forEach(function(playbookId) {
      var pending = pendingVerifications[playbookId];
      if (pending.verifyAt > ts) return;
      delete pendingVerifications[playbookId];
      bus.emit('health.healed', {
        playbookId: playbookId, kind: pending.kind, target: pending.target, outcome: 'applied', detail: pending.detail,
        title: pending.title, actions: pending.actions
      });
      if (memory && memory.audit && typeof memory.audit.write === 'function') {
        memory.audit.write({
          actor: 'healer', decision: 'heal', tool: null, playbookId: playbookId,
          kind: pending.kind, target: pending.target, outcome: 'applied', detail: pending.detail
        });
      }
    });
  }

  async function applyPlaybook(playbook, diagnosis) {
    let outcome = 'applied';
    let detail = null;
    try {
      for (let i = 0; i < playbook.then.length; i++) {
        const step = playbook.then[i];
        const action = ACTIONS[step.do];
        if (!action) { outcome = 'error'; detail = { reason: 'unknown-action:' + step.do }; break; }
        const args = resolveArgs(step.args, diagnosis);
        const result = await action(diagnosis, args);
        if (!result || !result.ok) { outcome = 'error'; detail = result; break; }
        detail = result.result;
      }
    } catch (err) {
      outcome = 'error';
      detail = { error: err.message };
    }
    return { outcome: outcome, detail: detail };
  }

  async function onDiagnosed(event) {
    const diagnosis = event.payload;
    // diagnostician.js:57 preserves the originating anomaly here verbatim. Absent when a
    // diagnosis is raised directly (cortex/index.js emits health.diagnosed itself), hence
    // the default rather than an assumption. See the BUG-278 note on the emit below.
    const evidence = diagnosis.evidence || {};
    const playbook = activePlaybooks.find(function(p) { return matches(p, diagnosis); });

    let outcome, detail, playbookId;
    if (!playbook) {
      outcome = 'no-match';
      detail = null;
      playbookId = null;
    } else {
      playbookId = playbook.id;
      const ts = nowFn();
      // Task C2 fix (review): recurrence MUST be detected directly off
      // pendingVerifications, never inferred from cooldown arithmetic.
      // verifyMs and cooldownMs happen to be equal for build-engine-reprobe,
      // which made "recurs while on cooldown" look like a valid stand-in for
      // "recurs while a heal is unverified" — but a recurrence landing at or
      // after exactly cooldownMs falls out of the cooldown branch, was
      // treated as a brand-new independent heal attempt, and silently
      // overwrote the still-pending (and in fact failed) verification with
      // no heal-failed ever emitted for it. Checking pendingVerifications
      // first, unconditionally, makes "a pending verification plus any
      // further diagnosis of that playbook's anomaly IS the recurrence" the
      // explicit invariant — true no matter how cooldownMs and verifyMs
      // relate to each other.
      if (pendingVerifications[playbook.id]) {
        outcome = 'heal-failed';
        detail = { reason: 'anomaly-recurred-during-verification', recurredAfterMs: ts - pendingVerifications[playbook.id].appliedAt };
        delete pendingVerifications[playbook.id];
      } else {
        const lastFired = lastFiredAt[playbook.id] || 0;
        if (playbook.cooldownMs > 0 && ts - lastFired < playbook.cooldownMs) {
          outcome = 'cooldown';
          detail = { remainingMs: playbook.cooldownMs - (ts - lastFired) };
        } else {
          lastFiredAt[playbook.id] = ts;
          const applied = await applyPlaybook(playbook, diagnosis);
          if (applied.outcome === 'applied' && playbook.verifyMs) {
            // Task C2: an action reporting ok:true is not proof the anomaly
            // is gone (see reprobe-build-engine's own comment) — hold the
            // claim open until verifyMs passes with no recurrence.
            pendingVerifications[playbook.id] = {
              appliedAt: ts, verifyAt: ts + playbook.verifyMs,
              kind: diagnosis.kind, target: diagnosis.target, detail: applied.detail,
              title: playbook.title || null, actions: playbook.then.map(function(s) { return s.do; })
            };
            outcome = 'verifying';
            detail = applied.detail;
          } else {
            outcome = applied.outcome;
            detail = applied.detail;
          }
        }
      }
    }

    // B3 (2026-08-14) — NO-MATCH STORM DAMPING.
    //
    // Measured: 68 no-match records against 6 applied, and at one point 15
    // live-reconnect-failed inside 30 seconds (12:29:51 -> 12:30:21), one every
    // ~2s, each getting a full diagnose -> heal -> announce -> two-episodic-writes
    // round trip. The per-playbook cooldown above cannot damp any of it, because a
    // no-match never reaches a playbook to have a cooldown.
    //
    // Scoped to no-match ONLY, on purpose. Damping identical kind:target
    // regardless of outcome would have been simpler and could suppress a real
    // remediation — budget-pause deliberately runs with cooldownMs: 0 ("immediate,
    // every time"). By construction this branch is only reachable when NOTHING was
    // going to be done, so it cannot delay or skip a fix.
    //
    // Nothing is lost silently: the FIRST of a burst is emitted normally, and the
    // next emission after the window carries suppressedCount, so a storm is
    // visible as a number instead of as 15 identical records. The health.anomaly
    // records themselves are untouched — every occurrence is still stored by the
    // server's anomaly subscriber, so counting occurrences stays possible.
    if (outcome === 'no-match') {
      const dampKey = String(diagnosis.kind) + ':' + String(diagnosis.target);
      const prev = noMatchSeen[dampKey];
      const ts = nowFn();
      if (prev && ts - prev.at < NO_MATCH_DAMP_MS) {
        prev.suppressed += 1;
        return;   // no emit, no audit row — nothing was going to happen anyway
      }
      noMatchSeen[dampKey] = { at: ts, suppressed: 0 };
      if (prev && prev.suppressed > 0) {
        detail = Object.assign({}, detail, { suppressedCount: prev.suppressed });
      }
      // Amortized eviction, same idiom as chain.js's cooldown sweep — this map is
      // keyed by kind:target and would otherwise grow with every distinct target.
      for (const key in noMatchSeen) {
        if (ts - noMatchSeen[key].at > NO_MATCH_DAMP_MS * 10) delete noMatchSeen[key];
      }
    }

    // 'health.healed' — exact string, do not paraphrase.
    // BUG-162: carry the playbook's human title and its action list so the
    // announcer can say WHAT was healed. "Self-healed: recurring-failure-record."
    // was the operator's entire explanation on 2026-08-07 (incident 04:27), and
    // when they asked what it fixed, nothing downstream could answer.
    bus.emit('health.healed', {
      playbookId: playbookId, kind: diagnosis.kind, target: diagnosis.target, outcome: outcome, detail: detail,
      title: playbook ? (playbook.title || null) : null,
      actions: playbook ? playbook.then.map(function(s) { return s.do; }) : [],
      // BUG-278 (2026-08-20) — THE TWO FIELDS THAT DECIDE WHETHER A REMEDY IS EVEN
      // LEGITIMATE WERE DROPPED HERE, WHICH MADE BUG-273 C2 INERT ON THE REAL PATH.
      //
      // C2 gave the gmail sensor a `needsOperator: true` flag ("this fault is terminal,
      // human-only, do not guess a mechanical remedy") and a `reason` carrying the whole
      // operator instruction. Both are on the anomaly; diagnostician.js:57 keeps the
      // anomaly under `evidence`; this emit forwarded neither. So immune/explainer.js —
      // the only reader of the no-match path, and the only module those two fields exist
      // for — saw `undefined` for both. Measured on the wired chain (bus -> diagnostician
      // -> healer -> explainer), 2026-08-20: needsOperator absent, reason absent, brain
      // asked 1 time where C2 intended 0, and the prompt still offered probe_provider for
      // a revoked Google OAuth token. That is the 2026-08-20 session-audit finding
      // verbatim, one day after C2 shipped. The operator heard "I do not yet know the
      // cause" about an anomaly that had shipped a sentence naming the fix.
      //
      // Why no test caught it: every C2 test calls explainer._onHealed() with these
      // fields injected — a fixture more generous than the wire. The guard against a
      // repeat asserts them ON the bus (bug-278-remedy-fit-must-survive-the-wire.test.js).
      //
      // Q8 — the anomaly's own `detail` is deliberately NOT forwarded. In THIS payload
      // `detail` means "what the heal action did" and is null by definition on no-match;
      // overloading it with the anomaly's detail would corrupt the field the audit writer
      // below already records with that meaning. The explainer does not need it: the
      // condition sentence is built from kind/target/reason.
      needsOperator: evidence.needsOperator === true,
      reason: evidence.reason || null,
      // B2: the bus id of the health.anomaly that started this, forwarded from
      // the diagnostician so the anomaly record and this verdict record share a
      // key. Null when a diagnosis was raised directly (cortex/index.js emits
      // health.diagnosed itself) rather than via an anomaly.
      sourceEventId: diagnosis.sourceEventId || null,
    });

    if (memory && memory.audit && typeof memory.audit.write === 'function') {
      // BUG-125: healer rows land in the same Audit/*.jsonl stream as the
      // leash's tool rows, and a healer row has no tool by nature — it records
      // a playbook decision, not a dispatch. Omitting the field entirely made
      // readers render `tool: undefined`, which is indistinguishable from a
      // dispatch that lost its tool name on the way to the audit. An explicit
      // null says "there is deliberately no tool here".
      memory.audit.write({
        actor: 'healer', decision: 'heal', tool: null, playbookId: playbookId,
        kind: diagnosis.kind, target: diagnosis.target, outcome: outcome, detail: detail
      });
    }
  }

  let unsubscribe = null;

  function start() {
    unsubscribe = bus.subscribe('health.diagnosed', onDiagnosed);
    // RC#4: periodic check for expired lane degradations. Every 60s, if a
    // degraded lane's restoreAt has passed, clear the env override so the
    // registry falls back to the built-in preference list (re-adding groq etc.).
    // Also restores suppressed tools (BUG-013) when their cooldown expires.
    restoreTimer = setInterval(function() {
      var now = Date.now();
      Object.keys(degradedLanes).forEach(function(lane) {
        if (degradedLanes[lane].restoreAt <= now) {
          var entry = degradedLanes[lane];
          delete process.env[entry.env];
          delete degradedLanes[lane];
          bus.emit('health.healed', {
            playbookId: 'lane-restore', title: 'brain lane restored after quota recovery', kind: 'quota-recovered',
            target: lane, outcome: 'applied', detail: { restored: true }
          });
        }
      });
      // BUG-013: restore suppressed tools after cooldown expires
      Object.keys(suppressedTools).forEach(function(toolName) {
        if (suppressedTools[toolName].restoreAt <= now) {
          delete suppressedTools[toolName];
          // Reset the effector's circuit breaker so the FSM matches the tool's
          // restored state. Without this the breaker stays OPEN/HALF_OPEN
          // (recordSuccess() is never called because the tool was suppressed
          // and never dispatched), so broadcastHealth keeps reporting it as
          // open and the HUD shows "degraded" indefinitely after a heal.
          // This is the missing state transition reported 2026-07-31.
          if (getEffectors) {
            try { getEffectors().breakers.reset(toolName); } catch (_) { /* tool may not have a breaker */ }
          }
          bus.emit('health.healed', {
            playbookId: 'tool-restore', title: 'suppressed tool restored', kind: 'tool-unsuppressed',
            target: toolName, outcome: 'applied', detail: { restored: true }
          });
        }
      });
      // REMEDIATION P2-10: restore suppressed search providers after cooldown.
      Object.keys(suppressedSearchProviders).forEach(function(provider) {
        if (suppressedSearchProviders[provider].restoreAt <= now) {
          delete suppressedSearchProviders[provider];
          bus.emit('health.healed', {
            playbookId: 'search-provider-restore', title: 'search provider restored', kind: 'search-provider-unsuppressed',
            target: provider, outcome: 'applied', detail: { restored: true }
          });
        }
      });
      // Task C2: same TTL-tick pattern, resolving any heal that has held its
      // verification window with no recurrence.
      checkVerifications();
    }, 60000);
    if (restoreTimer.unref) restoreTimer.unref();
  }

  function stop() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (restoreTimer) { clearInterval(restoreTimer); restoreTimer = null; }
  }

  return {
    start: start, stop: stop,
    _internal: {
      ACTIONS: ACTIONS, lastFiredAt: lastFiredAt, applyPlaybook: applyPlaybook,
      pendingVerifications: pendingVerifications, checkVerifications: checkVerifications
    }
  };
}

function isToolSuppressed(toolName) {
  if (!suppressedTools[toolName]) return false;
  const now = Date.now();
  if (suppressedTools[toolName].restoreAt <= now) {
    delete suppressedTools[toolName];
    return false;
  }
  return true;
}

// P6 Jarvis upgrade: lets immune/explainer.js apply the same suppression the
// 'suppress-tool' playbook action uses (same map, same TTL semantics, same
// restore path via the tick loop) without reaching into the ACTIONS closure.
function suppressTool(toolName, ttlMs) {
  if (!toolName) return false;
  suppressedTools[toolName] = { restoreAt: Date.now() + (ttlMs || 60000) };
  return true;
}

// REMEDIATION P2-10: same isToolSuppressed()/suppressTool() pattern, scoped to
// web-search's provider chain — web-search.js calls isSearchProviderSuppressed()
// before attempting each provider so a provider degraded by the
// search-provider-degrade playbook is actually skipped, not just logged.
function isSearchProviderSuppressed(provider) {
  if (!suppressedSearchProviders[provider]) return false;
  const now = Date.now();
  if (suppressedSearchProviders[provider].restoreAt <= now) {
    delete suppressedSearchProviders[provider];
    return false;
  }
  return true;
}

function suppressSearchProvider(provider, ttlMs) {
  if (!provider) return false;
  suppressedSearchProviders[provider] = { restoreAt: Date.now() + (ttlMs || 30000) };
  return true;
}

module.exports = {
  createHealer: createHealer, SEED_PLAYBOOKS: SEED_PLAYBOOKS,
  matchClause: matchClause, matches: matches, resolveArgs: resolveArgs, getPath: getPath,
  isToolSuppressed: isToolSuppressed, suppressTool: suppressTool,
  isSearchProviderSuppressed: isSearchProviderSuppressed, suppressSearchProvider: suppressSearchProvider
};
