'use strict';

// Plan generation from spec
// ENGAGEMENT-SPEC section 1.1 plan-builder interface
//
// Phase 1 (agentic-execution): build() now accepts an optional { brain } in
// opts. When a brain is present it asks brain.think({lane:'build'}) for an
// executable stage list (kind: build|action|research, action stages carry an
// actions:[{tool,args}] array routed through dispatchAction). On any brain
// failure/offline it falls back to the canned 3-stage set (forge discipline:
// honest-inert, never a fake brain result). Each stage sets BOTH `kind` (new,
// preferred) and `type` (legacy alias) so existing readers keep working.
//
// Phase B: buildEngine (DeepSeek Harness) is now the preferred generator for
// buildViaBrain() below — the brain.think({lane:'build'}) call was a third,
// independent generator alongside build-runner.js and executor.js's build
// stage, same reasoning as build-engine.js's header comment. A caller-supplied
// opts.buildEngine wins over the constructor-level default (mirrors opts.brain
// below); brain.think stays the fallback when no engine is wired.

function createPlanBuilder({ config, buildEngine }) {
  if (!config) throw new Error('config required');

  var maxStages = config.ENGAGEMENT_MAX_STAGES || 10;

  // Schema hint handed to the brain so its JSON parses into the stage shape.
  // Kept deliberately permissive: the brain may legitimately produce 1-6 stages.
  var STAGE_SCHEMA_HINT =
    'an array of 1-6 stage objects. Each stage: ' +
    '{"id":string, "name":string, "kind":"build"|"action"|"research", ' +
    '"prompt":string (for build/research) OR "actions":[{tool:string,args:object}] (for action), ' +
    '"verification":{"type":"file"|"command"|"research", ...}, "requiresApproval":boolean}';

  // Build plan from spec. opts.brain is optional — when omitted, the canned
  // fallback stages are produced (offline/legacy path).
  function build(spec, opts) {
    if (!spec || !spec.markdown) {
      throw new Error('Spec with markdown required');
    }
    opts = opts || {};
    var generator = (opts.buildEngine && typeof opts.buildEngine.generate === 'function') ? opts.buildEngine :
      (buildEngine && typeof buildEngine.generate === 'function' ? buildEngine : null);

    if (generator || (opts.brain && typeof opts.brain.think === 'function')) {
      return buildViaBrain(spec, opts, generator).then(function (stages) {
        if (stages && stages.length) {
          return finalizePlan(stages);
        }
        // generator/brain returned nothing usable — honest fallback
        return finalizePlan(generateStages(spec));
      });
    }

    return Promise.resolve(finalizePlan(generateStages(spec)));
  }

  function finalizePlan(stages) {
    return {
      stages: stages.slice(0, maxStages),
      currentStageIndex: 0,
      approvedAt: null
    };
  }

  // Brain/buildEngine-driven plan. try/catch + offline-check mirror forge.js's
  // think() helper: a null/offline result is non-fatal and falls back to
  // canned stages. When `generator` (buildEngine) is present it wins — brain
  // is only used when no engine is wired (see the Phase B comment above).
  async function buildViaBrain(spec, opts, generator) {
    var toolList = (opts.toolCatalogNames && opts.toolCatalogNames.length)
      ? opts.toolCatalogNames.join(', ')
      : '(none)';
    var prompt =
      spec.markdown +
      '\n\nAvailable tools: ' + toolList +
      '\n\nProduce 1-6 stages. Each stage: ' +
      '{id, name, kind:"build"|"action"|"research", prompt OR actions, verification}. ' +
      'For kind:"action", actions is an array of {tool, args}. ' +
      'For kind:"build" or "research", use prompt. ' +
      'verification is {type:"file"|"command"|"research", ...}.';

    var result = null;
    try {
      result = generator
        ? await generator.generate({ prompt: prompt, source: 'engagement:plan' })
        : await opts.brain.think({
            lane: 'build',
            schemaHint: STAGE_SCHEMA_HINT,
            messages: [{ role: 'user', content: prompt }],
            source: 'engagement:plan'
          });
    } catch (_) {
      return null;
    }
    if (!result || result.offline || result.aborted) return null;
    if (!result.content) return null;

    return parseBrainStages(result.content, spec);
  }

  // Parse the brain's JSON content into sanitized stage objects. Defensive: the
  // brain can hallucinate shape, so every field is coerced/validated. Returns
  // null on total parse failure (caller falls back).
  function parseBrainStages(content, spec) {
    var arr = extractJsonArray(content);
    if (!arr || !Array.isArray(arr)) return null;

    var stages = [];
    for (var i = 0; i < arr.length && i < maxStages; i += 1) {
      var raw = arr[i];
      if (!raw || typeof raw !== 'object') continue;
      var stage = normalizeBrainStage(raw);
      if (stage) stages.push(stage);
    }
    return stages.length ? stages : null;
  }

  // Pull the first JSON array out of the brain's (possibly prose-wrapped)
  // content. Mirrors forge-prompts' extraction discipline.
  function extractJsonArray(content) {
    if (!content) return null;
    if (Array.isArray(content)) return content;
    if (typeof content !== 'string') return null;
    // Try direct parse first.
    var direct = tryParse(content);
    if (Array.isArray(direct)) return direct;
    // Fallback: locate the first '[' ... matching ']' span.
    var start = content.indexOf('[');
    if (start === -1) return null;
    var depth = 0;
    for (var i = start; i < content.length; i += 1) {
      if (content[i] === '[') depth += 1;
      else if (content[i] === ']') {
        depth -= 1;
        if (depth === 0) {
          var slice = content.slice(start, i + 1);
          var parsed = tryParse(slice);
          if (Array.isArray(parsed)) return parsed;
          return null;
        }
      }
    }
    return null;
  }

  function tryParse(s) {
    try { return JSON.parse(s); } catch (_) { return null; }
  }

  // Coerce one brain-produced stage into the canonical shape. kind+type are set
  // together (legacy readers read `type`; new executor reads `kind`).
  function normalizeBrainStage(raw) {
    var kind = raw.kind || raw.type || 'build';
    if (['build', 'action', 'research'].indexOf(kind) === -1) kind = 'build';

    var stage = {
      id: raw.id || ('stage-' + slugify(String(raw.name || kind))),
      name: raw.name || ('Stage ' + kind),
      kind: kind,
      type: kind, // legacy alias — schema.js regex allows build|research|action
      prompt: raw.prompt || (kind === 'action' ? null : (raw.name || '')),
      verification: normalizeVerification(raw.verification),
      requiresApproval: raw.requiresApproval === true
    };
    if (kind === 'action' && Array.isArray(raw.actions)) {
      stage.actions = raw.actions
        .filter(function (a) { return a && a.tool; })
        .map(function (a) { return { tool: String(a.tool), args: a.args || {} }; });
    }
    return stage;
  }

  function normalizeVerification(v) {
    if (!v || typeof v !== 'object') return { type: 'research', claims: [] };
    var t = v.type;
    if (['file', 'command', 'research'].indexOf(t) === -1) {
      // Unknown type (http/browser) — degrade to research (honest, no shell-out).
      return { type: 'research', claims: [] };
    }
    return v;
  }

  function slugify(s) {
    return String(s).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  }

  // ---- canned fallback (offline / no brain) ----
  // Three well-formed stages; kept stable for existing tests + as the honest
  // brain-offline path.
  function generateStages(spec) {
    var stages = [];
    var markdown = spec.markdown || '';

    // Stage 1: Setup/Initialization
    stages.push(createStage(
      'stage-setup',
      'Setup Project',
      'build',
      'Initialize project structure and install dependencies',
      { type: 'file', path: 'package.json', exists: true }
    ));

    // Stage 2: Core Implementation
    stages.push(createStage(
      'stage-core',
      'Implement Core',
      'build',
      'Build the main functionality',
      { type: 'command', cmd: 'npm test', expectedExitCode: 0 }
    ));

    // Stage 3: Verification
    stages.push(createStage(
      'stage-verify',
      'Verify Output',
      'build',
      'Run verification checks',
      { type: 'command', cmd: 'npm test', expectedExitCode: 0 }
    ));

    // If research type, add research stage
    if (spec.recommendations && spec.recommendations.some(function (r) { return r.type === 'research'; })) {
      stages.splice(1, 0, createStage(
        'stage-research',
        'Research Phase',
        'research',
        'Gather information and validate claims',
        { type: 'research', claims: [] }
      ));
    }

    return stages.slice(0, maxStages);
  }

  // Create a stage object. kind+type set together for forward/back compat.
  function createStage(id, name, type, prompt, verification) {
    return {
      id: id || ('stage-' + name.toLowerCase().replace(/\s+/g, '-')),
      name: name,
      kind: type,
      type: type,
      prompt: prompt,
      verification: verification,
      requiresApproval: false
    };
  }

  // Add approval gate to stage
  function addApprovalGate(stage, requiresApproval) {
    return Object.assign({}, stage, {
      requiresApproval: requiresApproval !== false
    });
  }

  return {
    build: build,
    createStage: createStage,
    addApprovalGate: addApprovalGate
  };
}

module.exports = { createPlanBuilder };
