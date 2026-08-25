'use strict';

// effectors/agent-actions.js — Pipeline/Kanban agent actions.
// P22 QUALITY GATE: every build now flows through research → build → visual verify → review.
// No artifact ships without passing grounding (real web data injected into prompt),
// visual verification (rendered screenshot checked by vision brain), and reviewer
// verdict (reviewer + reality-checker personas). Rejects retry once, then ship
// honestly flagged as "with-issues" rather than silently passing garbage.

var path = require('path');
var designSystemPrompt = require('./design-system-prompt');
var reviewStatusLib = require('./review-status');
var groundingCheck = require('./grounding-check');
var buildPack = require('../skills/build-pack');
var personas = require('../agents/personas');
var { reasonText } = require('../util/reason-text');

var DELIVERABLE_PREAMBLE = [
  'You are the Pipeline build agent. Take the captured idea below and produce the single',
  'most useful self-contained deliverable for it: EITHER a complete single-file HTML page/app',
  '(all CSS/JS inline, starting with <!DOCTYPE html>; images are the one allowed external',
  'resource — see VISUALS) OR a thorough',
  'markdown document (plan, spec, draft, or write-up, starting with a # title line).',
  'Choose whichever genuinely fits the idea. Output ONLY the raw file content — no',
  'commentary, no markdown fences around the whole output.',
  'TITLE CONSTRAINT: the <title> or # heading MUST use words FROM the idea, describing',
  'what the deliverable IS. Do NOT invent a brand name, product name, or marketing title.',
  'If the idea is "a landing page for AI news", the title should be "AI News Landing Page"',
  'or similar — never "The Applied Signal" or any other name you made up.',
  'EXTRACT the core topic from the idea text and use EXACTLY those words in the title.',
  'Example: idea="landing page for News/Media Platform" → title="News Media Platform Landing Page"',
  'STRICT REQUIREMENTS:',
  '- Title MUST contain words from the spec: ',
  '- Content MUST be about the spec topic, not a generic template',
  '- NO invented brand names, NO generic templates',
  '- Include hero section, CTA, animations as specified in the idea',
  // Pages were shipping visually empty: nothing in this pipeline supplies or
  // generates imagery, and the preamble's blanket "no external resources" was
  // read as "no pictures at all". There is no image-generation step to lean on
  // either (the standalone generate_image tool is entitlement-blocked on a
  // free-tier key), so the free, reliable options are named explicitly here.
  'VISUALS (a page with no imagery reads as unfinished — never ship a wall of text):',
  '- Use inline <svg> for logos, icons, patterns, and decorative shapes. It always renders,',
  '  needs no network, and keeps the file self-contained. Prefer it for anything non-photographic.',
  '- For photographs use https://picsum.photos/seed/<distinct-word>/<w>/<h> — keyless, always',
  '  resolves, and the seed keeps each image stable and distinct from the others.',
  '- Do NOT invent https://images.unsplash.com/photo-<id> URLs: those ids are real and a guessed',
  '  one 404s into a broken image. Only use a specific image URL if it appeared in the research',
  '  brief below or in the idea itself.',
  '- Give every image a real alt attribute and CSS sizing so a failed load degrades gracefully.',
  '- Use CSS gradients, shadows and spacing for polish rather than leaving areas blank.',
  // A resolved design system (ui-ux-pro-max) is prepended ABOVE this preamble.
  // Two failures came from taking it too literally, both live on 2026-07-31:
  // its "Sections:" list added a pricing table and certification badges to a
  // NEWS DIGEST, and its palettes are light-first, so "dark theme" was honoured
  // by swapping Background and Foreground — amber-on-near-black, muddy.
  'DESIGN SYSTEM (only if a design-system block appears above):',
  '- It is a source of COLOR, TYPE, SPACING and EFFECTS. It is NOT a content outline.',
  '  The idea below decides which sections exist. If the block lists sections the idea',
  '  never asked for — pricing tiers, certification/security badges, testimonials, FAQ —',
  '  leave them out. Where the block and the idea disagree, the IDEA WINS.',
  '- If the idea asks for a dark theme and the block Background is light, do NOT simply',
  '  swap Background and Foreground. Build a real dark ramp: a near-black neutral surface,',
  '  one or two lighter elevated steps for cards, foreground text at least #E6E8EB, borders',
  '  as low-alpha white, and keep the accent HUE while raising its lightness until it clears',
  '  4.5:1 on that surface. An inverted light palette is what makes a dark page look cheap.',
  'Idea: '
].join(' ');

var PLANNER_PREAMBLE = [
  'You are the Kanban Planner agent. Break the goal below into 3-6 concrete, independently',
  'buildable tasks. Respond with ONLY a JSON array, no commentary, no markdown fence:',
  '[{"title": "short task title", "detail": "1-3 sentences describing exactly what to build"}]',
  'Goal: '
].join(' ');

var BUILDER_PREAMBLE = [
  'You are the Kanban Builder agent. Build the single most useful self-contained deliverable',
  'for this task: EITHER a complete single-file HTML page/app (all CSS/JS inline, starting',
  'with <!DOCTYPE html>) OR a markdown document (starting with a # title). Output ONLY the',
  'raw file content, no commentary, no fences around the whole output.',
  'Title the deliverable using words FROM the task, not an invented brand name.',
  // Same visual gap as DELIVERABLE_PREAMBLE above — kept short here since kanban
  // tasks are narrower than a full page brief.
  'VISUALS: use inline <svg> for icons/logos/patterns, and',
  'https://picsum.photos/seed/<word>/<w>/<h> for photographs (keyless, always resolves).',
  'Never invent images.unsplash.com photo ids — a guessed id 404s. Every image needs alt text.',
  // Same two rules as DELIVERABLE_PREAMBLE, condensed: a design-system block is
  // tokens, not a section list, and a dark theme is a derived ramp, not an
  // inverted light palette.
  'A design-system block above supplies COLOR/TYPE/EFFECTS only — the task decides which',
  'sections exist, and the task wins where they disagree. For a dark theme, derive a',
  'near-black surface ramp with a brightened accent; never just swap background and text.',
  '\nTask: '
].join(' ');

// C3: the reviewer/reality-checker preambles used to be one hardcoded pair
// applied to every artifact — including a landing-page checklist ("pricing
// tiers, certification and security badges, testimonials, team bios") graded
// onto a Snake game and a mythology visualisation. review-rubric.js now
// selects the reviewer criteria by artifact type and requires every
// [reality] finding to cite the artifact text it's about; see that file for
// the full incident writeup.
var reviewRubric = require('./review-rubric');
var REALITY_CHECK_PREAMBLE = reviewRubric.REALITY_CHECK_PREAMBLE;

var VISUAL_VERIFY_PREAMBLE = [
  'You are verifying a built web page by looking at a screenshot of the rendered result.',
  'Compare what you see against the task spec. Check:',
  '1. Does the rendered page match what the spec asked for?',
  '2. Is the title/heading correct (derived from the spec, not an invented brand)?',
  '3. Is the content topically correct (not a generic template about a different product)?',
  '4. Are there visible placeholder texts or empty sections?',
  '5. Does the visual style match the spec (dark/light theme, animations, etc.)?',
  'Respond with ONLY a JSON object:',
  '{"match": true|false, "description": "what you see in 1-2 sentences", "issues": ["specific problem 1", ...]}'
].join(' ');

function extractJsonBlock(raw) {
  var fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  var text = fence ? fence[1] : raw;
  return JSON.parse(text.trim());
}

var riskClassifierLib = require('./risk-classifier');
// BUG-329: the research gate and its live-data rule. Extracted because
// adding it here pushed this file past its one-directional size ratchet.
var buildResearch = require('./build-research');
var completionStatusLib = require('./completion-status');

function createAgentActions({ fs, pipeline, kanban, buildRunner, designSystem, brain, buildEngine, webSearch, webFetch, browserAgent, evidenceValidator, bus }) {
  if (!fs || typeof fs.writeText !== 'function' || typeof fs.exists !== 'function') {
    throw new Error('createAgentActions requires a vault fs-store with writeText/exists');
  }
  if (!pipeline || typeof pipeline.findCard !== 'function') {
    throw new Error('createAgentActions requires a pipeline effector');
  }
  if (!kanban || typeof kanban.findCard !== 'function') {
    throw new Error('createAgentActions requires a kanban effector');
  }
  if (!buildRunner || typeof buildRunner.enqueue !== 'function') {
    throw new Error('createAgentActions requires a buildRunner with enqueue()');
  }

  // Single content-generation seam (2026-07-31). build-runner already routes
  // FIRST-DRAFT content through buildEngine (`dsh` since W6 2026-08-22, and
  // Hermes-Agent before it — the ONE build engine either way, per
  // build-engine.js), but the research-grounded regeneration and the
  // review-retry below called brain.think directly and OVERWROTE that draft with
  // the result. Because risk='feature' covers nearly every real request (landing
  // page, dashboard, and the verbs build/create/design — see risk-classifier.js),
  // the artifact that actually shipped came from the brain build lane whose
  // documented failure mode is inventing titles and topics: exactly the "I asked
  // for X and got Y" this repo swapped engines to stop, and the reason
  // build-engine.js exists at all. commit 37953ca made Hermes the single engine
  // but never touched this file.
  //
  // Routing both regenerations here keeps ONE engine end to end. buildEngine's
  // own guarded brain fallback still covers a transient Hermes outage — tagged
  // engine:'brain-fallback' with a health.anomaly, not silently.
  //
  // brain stays the fallback for callers that inject no engine (unit tests).
  // `persona` is the kanban builder voice. brain.think takes it as a field;
  // Hermes has no such parameter, so for the engine path it is prepended to the
  // prompt rather than silently dropped.
  async function generateContent(prompt, source, persona) {
    if (buildEngine && typeof buildEngine.generate === 'function') {
      var text = persona ? String(persona) + '\n\n' + prompt : prompt;
      return await buildEngine.generate({ prompt: text, source: source });
    }
    if (brain && typeof brain.think === 'function') {
      var req = { lane: 'build', messages: [{ role: 'user', content: prompt }], source: source };
      if (persona) req.persona = persona;
      return await brain.think(req);
    }
    return { offline: true, error: 'no build engine or brain available' };
  }

  // BUG-025: buildRunner.enqueue() refuses (returns { ok: false, result: { error } })
  // instead of enqueueing when the assembled prompt is empty/undefined — a card that
  // lost its spec upstream must never silently build garbage. Every call site below
  // expects a job record with .id back; surface the refusal as a thrown Error so it
  // flows into the existing try/catch -> fail() handling at the effector-tool boundary
  // (from-dashboard.js's pipeline_execute/kanban_* wrappers), same as any other
  // validation failure in this file.
  function enqueueOrThrow(spec) {
    var job = buildRunner.enqueue(spec);
    if (job && job.ok === false) {
      throw new Error((job.result && job.result.error) || 'build enqueue failed');
    }
    return job;
  }

  // ---- P22/BUG-329: the research gate lives in effectors/build-research.js --
  // It runs in build-runner's preparePrompt hook, before the first generation,
  // rather than inside run(), which is downstream of the verifier. Its header
  // carries the measurement. Constructed here because it needs this factory's
  // injected webSearch/webFetch/bus.
  var research = buildResearch.createBuildResearch({
    webSearch: webSearch, webFetch: webFetch, bus: bus,
  });
  // ---- A3: social-media research via agent-reach — REMOVED 2026-08-20 ----
  //
  // This block shelled out to two commands that do not exist and never did:
  //     agent-reach reddit     --query <topic> --limit 2
  //     agent-reach hackernews --query <topic> --limit 2
  //
  // The vendored skill at mythos/skills/agent-reach/ documents exactly five
  // binary subcommands — doctor, configure, transcribe, install, check-update.
  // agent-reach is a ROUTING skill: it tells an agent which OTHER tool to drive.
  // Reddit goes through a separate, login-backed `reddit` binary
  // (`reddit search "query" -f yaml`), and agent-reach covers no Hacker News
  // channel at any layer.
  //
  // It never ran, so removing it cannot change behaviour: the CLI is not
  // installed, isAgentReachAvailable() returned false, and socialResearchForBuild
  // returned null on every call it has ever received. There were no tests.
  //
  // Installing the CLI — which is what the remediation plan proposed — would have
  // made this WORSE. `agent-reach --version` would succeed, availability would
  // flip to true, both invented commands would error, runAgentReach swallowed any
  // error to '', and the function would go on returning null forever while
  // reporting the capability as present. A fail-open that claims to work beats an
  // honest absence only in the logs.
  //
  // Removed rather than rewritten against the real commands, deliberately.
  // Writing this against documentation that cannot be executed here is exactly
  // how the invented commands came to be written; the real path needs an
  // installed binary and an interactive login before one line of it could be
  // verified. test/agent-reach-commands-must-exist.test.js derives the legal
  // subcommand set from the vendored skill itself, so a re-add against the real
  // CLI passes and a re-add against a guessed one does not.

  // ---- P22: Visual verification — render + look at the built page ----
  // Opens the built HTML in the automated browser, screenshots it, and sends
  // the screenshot through the vision brain to verify it matches the spec.
  // Returns { checked: bool, verdict: 'approve'|'reject'|'skipped', issues: [], description: '' }
  async function verifyBuildVisually(artifactPath, spec) {
    // Graceful degradation: if browser or vision brain isn't available, skip
    if (!browserAgent || typeof browserAgent.getStatus !== 'function') {
      return { checked: false, verdict: 'skipped', issues: [], description: 'browser automation unavailable' };
    }
    var status = browserAgent.getStatus();
    if (!status || status.state !== 'ONLINE') {
      return { checked: false, verdict: 'skipped', issues: [], description: 'browser offline' };
    }
    if (!brain || typeof brain.think !== 'function') {
      return { checked: false, verdict: 'skipped', issues: [], description: 'vision brain unavailable' };
    }

    try {
      // Resolve artifact web path (/vault/builds/...) to filesystem path
      var rel = String(artifactPath).replace(/^\/vault\//, '');
      var absPath = typeof fs.vaultPath === 'function' ? fs.vaultPath(rel) : path.join(process.cwd(), rel);
      var fileUrl = 'file:///' + absPath.replace(/\\/g, '/');

      // Navigate to the artifact and screenshot it
      var navResult = await browserAgent.withPage(async function(page) {
        await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: 10000 });
        // Small delay for JS animations to settle
        await page.waitForTimeout(1500);
        var buf = await page.screenshot({ fullPage: false });
        return buf.toString('base64');
      });

      if (!navResult) {
        return { checked: false, verdict: 'skipped', issues: [], description: 'screenshot failed' };
      }

      // Send screenshot through vision brain
      var visionResult = await brain.think({
        lane: 'vision',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: VISUAL_VERIFY_PREAMBLE + '\n\nTASK SPEC: ' + String(spec || '').slice(0, 500) },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,' + navResult } }
          ]
        }],
        source: 'visual-verify',
      });

      if (!visionResult || visionResult.offline || !visionResult.parsed) {
        return { checked: false, verdict: 'skipped', issues: [], description: 'vision brain returned no parseable result' };
      }

      var parsed = visionResult.parsed;
      var issues = Array.isArray(parsed.issues) ? parsed.issues : [];
      var match = parsed.match !== false;
      return {
        checked: true,
        verdict: match ? 'approve' : 'reject',
        issues: issues,
        description: String(parsed.description || '').slice(0, 300)
      };
    } catch (err) {
      return { checked: false, verdict: 'skipped', issues: [], description: 'visual verify error: ' + reasonText(err) };
    }
  }

  // Saves an LLM deliverable (HTML or markdown) into vault/builds/<kind>/
  function saveDeliverable(raw, sourceText, kind) {
    kind = kind || 'pipeline';
    var content = raw.trim();
    var fence = content.match(/^```[a-z]*\s*\n([\s\S]*?)\n```\s*$/);
    if (fence) content = fence[1].trim();
    if (!content) throw new Error('build agent returned empty output — try again');

    var isHtml = /<!DOCTYPE html/i.test(content);
    if (isHtml) {
      var docStart = content.search(/<!DOCTYPE html/i);
      if (docStart > 0) content = content.slice(docStart);
    }
    var ext = isHtml ? 'html' : 'md';
    var titleMatch = isHtml
      ? content.match(/<title>([^<]{1,60})<\/title>/i)
      : content.match(/^#\s+(.{1,60})/m);
    var title = titleMatch ? titleMatch[1].trim() : sourceText.slice(0, 60);

    // VALIDATE: Title must contain words from the spec (for non-tiny-fix cards)
    var specWords = sourceText.toLowerCase().split(/\s+/).filter(function(w) { return w.length > 3; });
    var titleWords = title.toLowerCase().split(/\s+/);
    var hasSpecWord = specWords.some(function(w) {
      return titleWords.some(function(t) { return t.includes(w) || w.includes(t); });
    });
    if (!hasSpecWord) {
      throw new Error('Title must contain words from the spec: "' + sourceText + '" — got "' + title + '"');
    }

    var base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'deliverable';
    var name = base + '.' + ext;
    for (var i = 2; fs.exists(path.join('builds', kind, name)); i += 1) {
      name = base + '-' + i + '.' + ext;
    }
    fs.writeText(path.join('builds', kind, name), content);
    return { path: '/vault/builds/' + kind + '/' + name, title: title, name: name };
  }

  // ---- P22: Full review gate — text review + reality check + visual verify ----
  // Returns { verdict: 'approve'|'reject', issues: [], visualDescription: '' }
  async function fullReview(card, artifact, brain) {
    var allIssues = [];
    var visualDescription = '';

    // Read artifact content for text-based review
    var rel = String(artifact.path).replace(/^\/vault\//, '');
    var content = fs.readText(rel, '');
    if (!content) {
      return { verdict: 'reject', issues: ['artifact file missing or empty'], visualDescription: '' };
    }

    // BUG-025 fix: fullReview() is shared between pipeline cards (shape { text, ... },
    // set by pipeline.capture() in pipeline.js) and kanban cards (shape { title, detail,
    // ... }, set by kanban.addCard()/addCards()). It used to unconditionally read
    // card.title/card.detail — correct for kanban, but pipeline cards have neither field,
    // so specText silently became the string "undefined" and every reviewer/vision prompt
    // was built against a spec-less task. Read whichever shape the card actually has.
    var specText = card.text
      ? card.text
      : card.title + (card.detail ? ' — ' + card.detail : '');
    // C3: no artifact "type" field exists on the card — classify from the
    // spec text that's already there so the reviewer isn't grading a game
    // or visualisation against a landing-page checklist.
    var artifactType = reviewRubric.classifyArtifactType(specText);

    // 1. Visual verification (if browser is online)
    var visual = await verifyBuildVisually(artifact.path, specText);
    // 2026-08-20: record WHY visual produced nothing, not just that it did.
    // evidence-validator.js gates the visual phase for feature and
    // architecture-change cards, and its only way to tell "the browser was
    // offline" from "this step was never invoked" is this flag. Without it the
    // gate cannot distinguish honest degradation from a skipped phase, so it
    // would either block every offline build or (as it did until this commit)
    // enforce nothing at all. visualSkipReason carries the description
    // verifyBuildVisually already produces — 'browser offline', 'vision brain
    // unavailable', 'screenshot failed' — so the reason survives to the operator
    // instead of being flattened into a boolean.
    var visualSkipped = !visual.checked;
    var visualSkipReason = visualSkipped ? (visual.description || 'visual verification did not run') : null;
    if (visual.checked) {
      visualDescription = visual.description;
      if (visual.verdict === 'reject' && visual.issues.length) {
        allIssues = allIssues.concat(visual.issues.map(function(i) { return '[visual] ' + i; }));
      }
    }

    // 2. Text-based reviewer check
    if (brain && typeof brain.think === 'function') {
      try {
        // lane 'reasoning' (2026-08-14) — a reviewer grading a deliverable
        // against a spec is the definition of the reasoning lane's job, and it
        // ran on llama-3.1-8b-instant until now. NOTE the `persona` argument
        // one line down: brain/index.js only injects a persona for lanes on its
        // own list, so 'reasoning' was added there in the SAME change. Moving
        // this lane without that would have silently dropped the reviewer
        // persona and left a generic model grading builds.
        var reviewResult = await brain.think({
          lane: 'reasoning',
          persona: personas.loadPersona('reviewer'),
          messages: [{ role: 'user', content:
            reviewRubric.buildReviewerPreamble(artifactType) +
            '\n\nTASK: ' + specText +
            '\n\nDELIVERABLE (truncated to 16000 chars):\n' + content.slice(0, 16000)
          }],
          source: 'reviewer-agent',
        });
        if (reviewResult && !reviewResult.offline && reviewResult.parsed) {
          if (reviewResult.parsed.verdict === 'reject') {
            var rIssues = Array.isArray(reviewResult.parsed.issues) ? reviewResult.parsed.issues : [];
            allIssues = allIssues.concat(rIssues.map(function(i) { return '[review] ' + i; }));
          }
        }
      } catch (_) { /* best-effort */ }

      // 3. Reality check (hallucination detection)
      try {
        // lane 'reasoning' (2026-08-14) — hallucination detection, same reason
        // and the same persona-injection dependency as the reviewer above.
        var realityResult = await brain.think({
          lane: 'reasoning',
          persona: personas.loadPersona('reality-checker'),
          messages: [{ role: 'user', content:
            REALITY_CHECK_PREAMBLE +
            '\n\nTASK: ' + specText +
            '\n\nDELIVERABLE (first 8000 chars):\n' + content.slice(0, 8000)
          }],
          source: 'reality-check',
        });
        if (realityResult && !realityResult.offline && realityResult.parsed) {
          if (realityResult.parsed.verdict === 'reject') {
            // C3: an uncited [reality] claim is dropped, not surfaced — see
            // review-rubric.js's filterRealityFindings for why (the Space
            // Grotesk false positive).
            var rcIssues = reviewRubric.filterRealityFindings(realityResult.parsed.issues, content);
            allIssues = allIssues.concat(rcIssues.map(function(i) { return '[reality] ' + i; }));
          }
        }
      } catch (_) { /* best-effort */ }
    }

    return {
      verdict: allIssues.length === 0 ? 'approve' : 'reject',
      issues: allIssues,
      visualDescription: visualDescription,
      // Read by evidence-validator.js's visual gate. See the note at the visual
      // verification call above for why the reason rides along.
      _visualSkipped: visualSkipped,
      _visualSkipReason: visualSkipReason
    };
  }

  // executePipelineCard — P22: research → build → visual verify → review → ship
  function executePipelineCard(cardId, goalId) {
    var found = pipeline.findCard(cardId);
    if (!found) throw new Error('card not found');
    if (found.stage !== 'execute') throw new Error('card is not in the Execute stage');
    var existing = found.card.jobId ? buildRunner.getJob(found.card.jobId) : null;
    if (existing && (existing.status === 'queued' || existing.status === 'running')) {
      throw new Error('a build is already in progress for this card');
    }
    var card = found.card;

    var basePrompt = (function() {
      var base = DELIVERABLE_PREAMBLE + card.text;
      // Skill-pack essences (P3 Jarvis upgrade): anti-slop discipline for the
      // free build models — UI pack or code pack chosen by deliverable text.
      try {
        var skillBlock = buildPack.packBlock(card.text);
        if (skillBlock) base = skillBlock + '\n\n' + base;
      } catch (_) { /* essence injection is best-effort */ }
      // NOTE: the design-system block is resolved INSIDE run() below, not here.
      // It requires an async skill-tool call (ui-ux-pro-max's search.py) which
      // can't run in this sync IIFE — executePipelineCard must stay sync for
      // its callers (from-project/from-dashboard read job.job.id synchronously).
      // The pump's first generation runs essence-only; the grounded rebuild in
      // run() prepends the real design system before the model sees the prompt.
      return base;
    })();

    var job = enqueueOrThrow({
      kind: 'pipeline-execute',
      goalId: goalId,
      prompt: basePrompt,
      // BUG-310: awaited by build-runner BEFORE the first generation, so every
      // generation in the job — first draft, verification retry, refine
      // regenerations, grounded rebuild — works from the real design system.
      // `card.text` and not basePrompt: the resolver keyword-matches its whole
      // argument, so prompt boilerplate would choose the design.
      // BUG-329: research joins the design system in this hook, so BOTH reach
      // the FIRST generation. It is no longer conditional on `designSystem`: a
      // deployment without the design skill still needs its research, and the
      // old shape skipped the hook entirely in that case.
      preparePrompt: async function(p, job) {
        var out = p;
        if (designSystem) out = await designSystemPrompt.prependDesignSystem(out, card.text);
        // fatalOnMissing: true preserves this path's existing policy — the
        // pipeline already refused to ship a feature build with no research,
        // it just refused AFTER paying for a generation and a verification.
        return research.researchIntoPrompt(out, job, card.text, card.risk || 'feature', true);
      },
      // REMEDIATION P0-2: a job that fails before run() ever executes (e.g.
      // the build engine itself is offline) previously left the card at
      // execute/progress:25 forever with no trace of failure —
      // indistinguishable from "still building" (the 2026-07-29 audit's
      // headline defect). Mirrors BUG-016's review-failed branch: the card
      // stays in 'execute' (the existing dashboard retry-build UI already
      // renders a "Build failed" / retry state off job.status, unchanged)
      // but now carries real failure metadata instead of none at all.
      onFailed: function(err, j) {
        try {
          if (!pipeline.findCard(card.id)) return; // card deleted/moved meanwhile
          pipeline.moveCard(card.id, 'execute', {
            jobId: j.id, progress: 25, buildFailed: true,
            buildError: (err && err.message) || String(err)
          });
        } catch (_) { /* best-effort */ }
      },
      run: async function(raw, j, preparedPrompt) {
        // BUG-310: adopt the prompt build-runner actually generated from, so the
        // grounded rebuild and the review retry below regenerate from the SAME
        // prompt as the first draft (design system included) rather than from
        // the unprepared string this closure captured.
        if (preparedPrompt) basePrompt = preparedPrompt;

        // P23: Risk-classified gate path — scale rigor to the change type
        var risk = card.risk || 'feature';
        var needsResearch = riskClassifierLib.requiresResearch(risk);
        var needsReview = riskClassifierLib.requiresReview(risk);
        var needsVisual = riskClassifierLib.requiresVisual(risk);

        // BUG-310: the design system used to be resolved HERE, which was too
        // late — build-runner calls run() after the first generation, after
        // verification and after the whole refine loop, so the only generation
        // that read it was the grounded rebuild below, and a build that skipped
        // research read it nowhere. It now rides the preparePrompt hook.

        // BUG-329: the research gate MOVED to the preparePrompt hook, which
        // build-runner awaits before the first generation. It used to live right
        // here, and here is after the first generation AND after the verifier —
        // so a brief that could not be satisfied without live data was rejected
        // by the verifier and this code never ran. The gate that supplies the
        // data ran after the gate that checks for it.
        //
        // Two consequences beyond the obvious one. The first draft is now
        // grounded, so the "generate ungrounded, then regenerate with the brief"
        // pair that used to sit here is gone — one whole generation removed from
        // the happy path. And the fatal-if-missing refusal is now raised before
        // anything is generated rather than after, so a doomed job stops costing
        // a build.
        //
        // These are read off the job record rather than recomputed: repeating
        // the search here would pay for it twice and could disagree with what
        // the model was actually given.
        var researchStatus = j.researchStatus || (needsResearch ? 'pending' : 'not-required');
        var researchBrief = j.researchBrief || null;

        var artifact = saveDeliverable(raw, card.text, 'pipeline');

        // P22: Full review gate — visual verify + reviewer + reality check
        // P23: skip for tiny-fix (build only) and quick-win (verify-only, no full review)
        var review = needsReview ? await fullReview(card, artifact, brain) : { verdict: 'approve', issues: [], visualDescription: '' };
        review = groundingCheck.reviewWithGrounding(review, raw, { spec: card.text, brief: researchBrief, researchStatus: researchStatus }); // BUG-314

        // If rejected, retry once with the issues fed back to the builder
        if (review.verdict === 'reject' && !j._reviewRetried) {
          j._reviewRetried = true;
          try {
            var retryResult = await generateContent(
              basePrompt + '\n\nYour previous output was rejected by review for these reasons:\n' +
              review.issues.map(function(i) { return '- ' + i; }).join('\n') +
              '\nFix ALL of these issues and regenerate the complete deliverable.',
              'pipeline-retry:' + j.id
            );
            if (retryResult && !retryResult.offline && retryResult.content) {
              // Overwrite the artifact with the retry
              artifact = saveDeliverable(retryResult.content, card.text, 'pipeline');
              review = groundingCheck.reviewWithGrounding(await fullReview(card, artifact, brain), retryResult.content, { spec: card.text, brief: researchBrief, researchStatus: researchStatus }); // BUG-314: the retry must clear grounding too, not just re-review
            }
          } catch (_) { /* retry failed — ship original with issues flagged */ }
        }

        // Ship — with honest status flag. buildFailed:false clears any stale
        // failure flag a PRIOR job attempt left on this same card (onFailed
        // above) — otherwise a successful retry would still read as failed.
        var shipMeta = { progress: 100, jobId: j.id, artifact: artifact, risk: risk, researchStatus: researchStatus, buildFailed: false };
        // BUG-316: a review that never ran must not record as 'approved'.
        Object.assign(shipMeta, reviewStatusLib.deriveReviewMeta(review, needsReview));

        // C1: evidence.pass used to mean only "the gate phases ran", which a
        // human reads as "the thing works" — those are different facts, and
        // job -531 shipped exactly that gap (reviewStatus:'failed',
        // evidence.pass:true). The completion payload folds in BOTH the
        // review verdict and whether the content actually came from the real
        // build engine, so nothing downstream can announce this as done.
        //
        // BUG-311/316: reviewRequired and refineStatus are now supplied too. The
        // first lets a DECLARED skip finish while an undeclared one cannot; the
        // second means a visually rejected artifact ('reverted'/'exhausted')
        // stops reading as done — the 2026-08-22 build shipped refineStatus
        // 'reverted' after the visual gate listed six defects, and this call
        // never saw that field.
        var completion = completionStatusLib.deriveCompletionPayload({
          reviewStatus: shipMeta.reviewStatus, buildEngine: j.engine,
          reviewRequired: needsReview, refineStatus: j.refineStatus
        });
        shipMeta.status = completion.status;
        if (j.refineStatus) shipMeta.refineStatus = j.refineStatus;

        // P23: Evidence validator — external gate that blocks ship if required
        // phases are missing evidence. Cannot be bypassed by the agent.
        if (evidenceValidator) {
          var evidence = evidenceValidator.verify({
            card: card, artifact: artifact, review: review, job: j,
            requiredPhases: riskClassifierLib.gatePath(risk)
          });
          if (!evidence.pass) {
            throw new Error('evidence gate blocked ship: ' + evidence.missing.join('; '));
          }
          // C1: the validator only proves the required PHASES ran — it says
          // nothing about whether review approved the result or whether the
          // real engine produced it. pass here is the completion payload's,
          // not the validator's, so a failed review can never read as passed.
          shipMeta.evidence = { pass: completion.evidence.pass, phases: riskClassifierLib.gatePath(risk) };
        }

        // BUG-016 FIX / C1: only move to 'shipped' — the one stage pipeline.js's
        // STAGES treats as finished — when the completion payload actually says
        // done. Gating on `reviewed` alone let a fallback-engine build with an
        // approving review land in 'shipped' while shipMeta.status stayed
        // 'needs-work': simultaneously "finished" and "needs work" on the same
        // card. completion.status already folds in reviewStatus AND engine, so
        // it is the single source of truth for this transition.
        if (completion.status === 'done') {
          pipeline.moveCard(card.id, 'shipped', shipMeta);
        } else {
          pipeline.moveCard(card.id, 'execute', shipMeta);
        }
        return { artifact: artifact, review: review, researchStatus: researchStatus, reviewStatus: shipMeta.reviewStatus, reviewRequired: needsReview };
      }
    });
    // REMEDIATION P2-8: same fix as buildKanbanCard's job.spec below — the
    // clean topic, not basePrompt (DELIVERABLE_PREAMBLE + skill-pack/design-
    // system boilerplate prefixed onto it). Pipeline cards only carry
    // {id, text} (no title/detail), so the clean spec is simply card.text.
    job.spec = card.text;
    pipeline.moveCard(card.id, 'execute', { jobId: job.id, progress: 25 });
    return { job: job, board: pipeline.listAll() };
  }

  function assembleKanbanPlan(goal, goalId) {
    if (!goal || !goal.trim()) throw new Error('goal required');
    var job = enqueueOrThrow({
      kind: 'kanban-plan',
      goalId: goalId,
      prompt: PLANNER_PREAMBLE + goal.trim(),
      run: async function(raw) {
        var tasks;
        try {
          tasks = extractJsonBlock(raw);
        } catch (_) {
          throw new Error('planner did not return valid JSON — try rephrasing the goal');
        }
        if (!Array.isArray(tasks) || !tasks.length) throw new Error('planner returned no tasks');
        var created = kanban.addCards(tasks, 'backlog');
        return { artifact: { cards: created } };
      }
    });
    return { job: job };
  }

  // buildKanbanCard — P22: research → build → visual verify → review
  function buildKanbanCard(cardId, goalId) {
    var card = kanban.findCard(cardId);
    if (!card) throw new Error('card not found');
    var existing = card.jobId ? buildRunner.getJob(card.jobId) : null;
    if (existing && (existing.status === 'queued' || existing.status === 'running')) {
      throw new Error('a build is already in progress for this card');
    }
    var builderPersonaRole = personas.pickBuilderPersona(card.title, card.detail);
    var builderPersona = personas.loadPersona(builderPersonaRole);
    var basePrompt = (function() {
      var base = BUILDER_PREAMBLE + card.title + '\n' + (card.detail || '');
      // Skill-pack essences (P3 Jarvis upgrade) — same injection as
      // executePipelineCard above, keyed off the card title+detail.
      try {
        var skillBlock = buildPack.packBlock(card.title + ' ' + (card.detail || ''));
        if (skillBlock) base = skillBlock + '\n\n' + base;
      } catch (_) { /* essence injection is best-effort */ }
      // NOTE: design-system block resolved inside run() (async skill-tool call).
      return base;
    })();

    var job = enqueueOrThrow({
      kind: 'kanban-build',
      goalId: goalId,
      prompt: basePrompt,
      persona: builderPersona,
      // BUG-310: see executePipelineCard's preparePrompt. Same hook, same
      // reason; the topic here is title + detail, as it always was.
      // BUG-329: as in executePipelineCard — design system AND research, both
      // before the first generation, and no longer skipped entirely when the
      // design skill is absent.
      //
      // fatalOnMissing: false keeps this path's existing tolerance. A kanban
      // card is frequently something the web cannot help with ("build a snake
      // game" classifies as a feature, so research is nominally required), and
      // failing every such build when the network is down would be a worse
      // outcome than building it ungrounded and saying so. researchIntoPrompt
      // still refuses outright when the brief itself names live data.
      preparePrompt: async function(p, job) {
        var topic = card.title + ' ' + (card.detail || '');
        var out = p;
        if (designSystem) out = await designSystemPrompt.prependDesignSystem(out, topic);
        return research.researchIntoPrompt(out, job, topic, riskClassifierLib.classify(topic), false);
      },
      // REMEDIATION P0-2: same fix as executePipelineCard's onFailed above —
      // a job that fails before run() ever executes otherwise leaves the
      // card with no trace of failure at all.
      onFailed: function(err, j) {
        try {
          if (!kanban.findCard(card.id)) return;
          kanban.patchCard(card.id, {
            jobId: j.id, buildFailed: true,
            buildError: (err && err.message) || String(err)
          });
        } catch (_) { /* best-effort */ }
      },
      run: async function(raw, j, preparedPrompt) {
        // BUG-310, same as executePipelineCard: adopt the prompt build-runner
        // generated from, so the rebuild paths below match the first draft.
        if (preparedPrompt) basePrompt = preparedPrompt;

        var slug = (card.title || 'card').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'card';

        // P23: Risk-classified gate path for kanban cards
        var risk = riskClassifierLib.classify((card.title || '') + ' ' + (card.detail || ''));
        var needsResearch = riskClassifierLib.requiresResearch(risk);
        var needsReview = riskClassifierLib.requiresReview(risk);

        // BUG-329: moved to the preparePrompt hook — see the long note on the
        // same change in executePipelineCard above. The first draft is grounded
        // now, so the ungrounded-then-regenerate pair that used to sit here is
        // gone, and the anomaly for a skipped search is emitted from the hook.
        var researchStatus = j.researchStatus || (needsResearch ? 'pending' : 'not-required');
        var researchBrief = j.researchBrief || null;

        var artifact = saveDeliverable(raw, slug + '-' + j.id, 'kanban');

        // P22: Full review gate (P23: skip for tiny-fix)
        var review = needsReview ? await fullReview(card, artifact, brain) : { verdict: 'approve', issues: [], visualDescription: '' };
        review = groundingCheck.reviewWithGrounding(review, raw, { spec: card.title + ' ' + (card.detail || ''), brief: researchBrief, researchStatus: researchStatus }); // BUG-314

        // If rejected, retry once with the issues fed back
        if (review.verdict === 'reject' && !j._reviewRetried) {
          j._reviewRetried = true;
          try {
            var retryResult = await generateContent(
              basePrompt + '\n\nYour previous output was rejected by review for these reasons:\n' +
              review.issues.map(function(i) { return '- ' + i; }).join('\n') +
              '\nFix ALL of these issues and regenerate the complete deliverable.',
              'kanban-retry:' + j.id,
              builderPersona
            );
            if (retryResult && !retryResult.offline && retryResult.content) {
              artifact = saveDeliverable(retryResult.content, slug + '-' + j.id + '-r', 'kanban');
              review = groundingCheck.reviewWithGrounding(await fullReview(card, artifact, brain), retryResult.content, { spec: card.title + " " + (card.detail || ""), brief: researchBrief, researchStatus: researchStatus }); // BUG-314
            }
          } catch (_) { /* retry failed — ship original with issues flagged */ }
        }

        // buildFailed:false clears any stale failure flag a prior job attempt
        // left on this card (onFailed above) — a successful retry must not
        // still read as failed.
        var patchMeta = { lane: 'review', jobId: j.id, builderOutput: artifact.title, artifact: artifact, researchStatus: researchStatus, buildFailed: false };
        Object.assign(patchMeta, reviewStatusLib.deriveReviewMeta(review, needsReview)); // BUG-316
        // C1: same rule as executePipelineCard's shipMeta — a failed review,
        // or content that came from the fallback engine rather than the real
        // one, must never read as a finished build downstream. BUG-311/316 adds
        // the declared-skip and visual-rejection signals.
        patchMeta.status = completionStatusLib.deriveCompletionPayload({
          reviewStatus: patchMeta.reviewStatus, buildEngine: j.engine,
          reviewRequired: needsReview, refineStatus: j.refineStatus
        }).status;
        if (j.refineStatus) patchMeta.refineStatus = j.refineStatus;
        kanban.patchCard(card.id, patchMeta);
        return { artifact: artifact, review: review, researchStatus: researchStatus, reviewStatus: patchMeta.reviewStatus, reviewRequired: needsReview };
      }
    });
    // FIX H (bug 2): the clean topic, not basePrompt (design-system boilerplate +
    // preamble prefixed onto it) — build-runner's verifier.verify() uses this
    // instead of basePrompt so its LLM self-check and required-element scan see
    // the real spec, not injected boilerplate (which was producing false
    // "topic mismatch" / "missing cta" rejections on correct builds).
    job.spec = card.title + ' ' + (card.detail || '');
    kanban.patchCard(card.id, { lane: 'building', jobId: job.id });
    return { job: job, board: kanban.listBoard() };
  }

  // Manual review endpoint (still available for dashboard/voice)
  function reviewKanbanCard(cardId, goalId) {
    var card = kanban.findCard(cardId);
    if (!card) throw new Error('kanban card not found: ' + cardId);
    if (!card.artifact || !card.artifact.path) {
      throw new Error('nothing to review — build this card first');
    }
    var rel = String(card.artifact.path).replace(/^\/vault\//, '');
    var content = fs.readText(rel, '');
    if (!content) throw new Error('artifact file missing or empty: ' + rel);

    var specText = card.title + (card.detail ? ' — ' + card.detail : '');
    var job = enqueueOrThrow({
      kind: 'kanban-review',
      goalId: goalId,
      prompt: reviewRubric.buildReviewerPreamble(reviewRubric.classifyArtifactType(specText)) +
        '\n\nTASK: ' + specText +
        '\n\nDELIVERABLE (truncated to 16000 chars):\n' + content.slice(0, 16000),
      persona: personas.loadPersona('reviewer'),
      run: async function(raw) {
        var parsed = extractJsonBlock(raw);
        var verdict = parsed && parsed.verdict;
        if (verdict !== 'approve' && verdict !== 'reject') {
          throw new Error('reviewer did not return a valid verdict — try again');
        }
        kanban.patchCard(cardId, {
          reviewVerdict: verdict,
          reviewNotes: String(parsed.notes || '').slice(0, 300),
          reviewIssues: Array.isArray(parsed.issues) ? parsed.issues : []
        });
        return {};
      }
    });
    return { job: job };
  }

  return {
    saveDeliverable: saveDeliverable,
    extractJsonBlock: extractJsonBlock,
    // BUG-329: now implemented in build-research.js. Re-exported under the same
    // name so existing callers and tests do not have to care where it lives.
    researchForBuild: research.researchForBuild,
    verifyBuildVisually: verifyBuildVisually,
    fullReview: fullReview,
    executePipelineCard: executePipelineCard,
    assembleKanbanPlan: assembleKanbanPlan,
    buildKanbanCard: buildKanbanCard,
    reviewKanbanCard: reviewKanbanCard
  };
}

module.exports = { createAgentActions, extractJsonBlock };
