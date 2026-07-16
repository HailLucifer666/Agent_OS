'use strict';

// effectors/agent-actions.js — Pipeline/Kanban agent actions.
// P22 QUALITY GATE: every build now flows through research → build → visual verify → review.
// No artifact ships without passing grounding (real web data injected into prompt),
// visual verification (rendered screenshot checked by vision brain), and reviewer
// verdict (reviewer + reality-checker personas). Rejects retry once, then ship
// honestly flagged as "with-issues" rather than silently passing garbage.

var path = require('path');
var { execFile } = require('child_process');
var designSystemEngine = require('../design/system');
var buildPack = require('../skills/build-pack');
var personas = require('../agents/personas');

var DELIVERABLE_PREAMBLE = [
  'You are the Pipeline build agent. Take the captured idea below and produce the single',
  'most useful self-contained deliverable for it: EITHER a complete single-file HTML page/app',
  '(all CSS/JS inline, no external resources, starting with <!DOCTYPE html>) OR a thorough',
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
  'Title the deliverable using words FROM the task, not an invented brand name.\nTask: '
].join(' ');

var REVIEWER_PREAMBLE = [
  'You are the Kanban Reviewer agent. Review the deliverable below against its task.',
  'You are thorough and honest — you never rubber-stamp. Check ALL of these:',
  '1. Does the deliverable actually fulfil the task? Is it complete and self-contained?',
  '2. Does the title use words from the task spec (not an invented brand name)?',
  '3. Is the content topically related to the task (not a generic template)?',
  '4. Are there placeholder texts, fake testimonials, or fabricated statistics?',
  '5. Does it match any design requirements (dark theme, animations, etc.) from the spec?',
  'Respond with ONLY a JSON object, no commentary, no markdown fence:',
  '{"verdict": "approve" | "reject", "issues": ["specific issue 1", ...], "notes": "1-2 sentences"}'
].join(' ');

var REALITY_CHECK_PREAMBLE = [
  'You are the Reality Checker. Verify that content in the deliverable is factually accurate',
  'and not hallucinated. Flag: invented brand names, fabricated testimonials/quotes, made-up',
  'statistics, generic marketing copy that has nothing to do with the task topic. If the',
  'deliverable is about topic X but contains content about topic Y, flag it as off-topic.',
  'Respond with ONLY a JSON object:',
  '{"verdict": "approve" | "reject", "issues": ["specific problem 1", ...]}'
].join(' ');

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

function createAgentActions({ fs, pipeline, kanban, buildRunner, designSystem, brain, webSearch, webFetch, browserAgent, evidenceValidator, bus }) {
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

  // ---- P22: Research gate — grounds the builder with real web data ----
  // Calls web_search for the topic, then web_fetch on top results to get real
  // content. Returns a condensed brief injected into the builder's prompt so
  // it works with actual data instead of hallucinating from training memory.
  async function researchForBuild(topic, maxResults) {
    if (!webSearch) return null;
    try {
      var searchRes = await webSearch({ query: topic, maxResults: maxResults || 5 });
      if (!searchRes || !searchRes.ok || !searchRes.result || !searchRes.result.results) return null;
      var results = searchRes.result.results.slice(0, maxResults || 5);
      if (!results.length) return null;

      // Fetch the top 2-3 results for deeper content
      var briefs = [];
      var fetchCount = Math.min(results.length, 3);
      for (var i = 0; i < fetchCount; i++) {
        if (!webFetch) break;
        try {
          var fetched = await webFetch({ url: results[i].url });
          if (fetched && fetched.ok && fetched.result && fetched.result.content) {
            var content = String(fetched.result.content).slice(0, 800);
            briefs.push({ title: results[i].title, url: results[i].url, snippet: results[i].snippet || '', content: content });
          }
        } catch (_) { /* best-effort — snippet alone is still useful */ }
      }

      // Build the research brief (max 2000 chars to stay within context budget)
      var lines = ['RESEARCH BRIEF (real web data — use this, do not hallucinate):'];
      for (var j = 0; j < results.length; j++) {
        var r = results[j];
        lines.push((j + 1) + '. ' + (r.title || 'Untitled') + ' — ' + (r.url || ''));
        if (r.snippet) lines.push('   ' + String(r.snippet).slice(0, 200));
      }
      if (briefs.length) {
        lines.push('');
        lines.push('KEY CONTENT EXTRACTS:');
        for (var k = 0; k < briefs.length; k++) {
          lines.push('— ' + briefs[k].title + ': ' + briefs[k].content.slice(0, 400));
        }
      }
      var brief = lines.join('\n');
      if (brief.length > 2000) brief = brief.slice(0, 2000) + '\n[...truncated]';
      return brief;
    } catch (_) {
      return null; // research is best-effort — don't block builds on network issues
    }
  }

  // ---- A3: Social-media research via agent-reach (optional, gracefully degrading) ----
  // agent-reach (pip install agent-reach) provides CLIs for Twitter/Reddit/YouTube/
  // GitHub reading that Mythos lacks natively. If installed, this enriches the
  // research brief with social signals; if not, it returns null silently (same
  // graceful-degradation pattern as the browser/vision checks). Never blocks a build.
  var agentReachAvailable = null; // cached availability check
  function isAgentReachAvailable() {
    if (agentReachAvailable !== null) return Promise.resolve(agentReachAvailable);
    return new Promise(function(resolve) {
      execFile('agent-reach', ['--version'], { timeout: 3000, windowsHide: true }, function(err) {
        agentReachAvailable = !err;
        resolve(agentReachAvailable);
      });
    });
  }

  function runAgentReach(cmd, args, timeout) {
    return new Promise(function(resolve) {
      execFile(cmd, args, { timeout: timeout || 8000, windowsHide: true, maxBuffer: 1024 * 512 }, function(err, stdout) {
        if (err) { resolve(''); return; }
        resolve(String(stdout).trim());
      });
    });
  }

  async function socialResearchForBuild(topic) {
    if (!await isAgentReachAvailable()) return null;
    try {
      // agent-reach exposes platform-specific CLIs. Query reddit + hackernews
      // for community discussion on the topic (most useful for build grounding).
      var results = [];
      var reddit = await runAgentReach('agent-reach', ['reddit', '--query', topic, '--limit', '2']);
      if (reddit) results.push({ source: 'reddit', text: reddit.slice(0, 600) });
      var hn = await runAgentReach('agent-reach', ['hackernews', '--query', topic, '--limit', '2']);
      if (hn) results.push({ source: 'hackernews', text: hn.slice(0, 600) });
      if (!results.length) return null;
      var lines = ['SOCIAL SIGNALS (community discussion — use for tone/relevance, verify facts):'];
      results.forEach(function(r) { lines.push('[' + r.source + '] ' + r.text); });
      var brief = lines.join('\n');
      return brief.length > 1200 ? brief.slice(0, 1200) + '\n[...truncated]' : brief;
    } catch (_) {
      return null;
    }
  }

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
      return { checked: false, verdict: 'skipped', issues: [], description: 'visual verify error: ' + (err.message || err) };
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

    // 1. Visual verification (if browser is online)
    var visual = await verifyBuildVisually(artifact.path, specText);
    if (visual.checked) {
      visualDescription = visual.description;
      if (visual.verdict === 'reject' && visual.issues.length) {
        allIssues = allIssues.concat(visual.issues.map(function(i) { return '[visual] ' + i; }));
      }
    }

    // 2. Text-based reviewer check
    if (brain && typeof brain.think === 'function') {
      try {
        var reviewResult = await brain.think({
          lane: 'simple',
          persona: personas.loadPersona('reviewer'),
          messages: [{ role: 'user', content:
            REVIEWER_PREAMBLE +
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
        var realityResult = await brain.think({
          lane: 'simple',
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
            var rcIssues = Array.isArray(realityResult.parsed.issues) ? realityResult.parsed.issues : [];
            allIssues = allIssues.concat(rcIssues.map(function(i) { return '[reality] ' + i; }));
          }
        }
      } catch (_) { /* best-effort */ }
    }

    return {
      verdict: allIssues.length === 0 ? 'approve' : 'reject',
      issues: allIssues,
      visualDescription: visualDescription
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
      if (designSystem) {
        try {
          var ds = designSystemEngine.generateDesignSystem(card.text);
          var dsBlock = designSystemEngine.formatDesignSystemForPrompt(ds);
          if (dsBlock) return dsBlock + '\n\n' + base;
        } catch (_) { /* design system lookup is best-effort */ }
      }
      return base;
    })();

    var job = enqueueOrThrow({
      kind: 'pipeline-execute',
      goalId: goalId,
      prompt: basePrompt,
      run: async function(raw, j) {
        // P23: Risk-classified gate path — scale rigor to the change type
        var risk = card.risk || 'feature';
        var needsResearch = riskClassifierLib.requiresResearch(risk);
        var needsReview = riskClassifierLib.requiresReview(risk);
        var needsVisual = riskClassifierLib.requiresVisual(risk);

        // P22: Research gate — gather real web data before committing to the build.
        // The initial `raw` was generated without grounding; if research returns
        // a brief, regenerate with the grounded prompt for a properly sourced build.
        // P23: skip for tiny-fix and quick-win (low-risk work doesn't need web grounding)
        // A4: track researchStatus — never fail silently. If research was required
        // but returned nothing, flag the artifact so the model/operator knows it
        // was built ungrounded. Previously this was invisible.
        var researchStatus = needsResearch ? 'pending' : 'not-required';
        if (needsResearch) {
          var researchBrief = await researchForBuild(card.text, 5);
          // A3: enrich with social signals if agent-reach is installed (optional)
          var socialBrief = await socialResearchForBuild(String(card.text).slice(0, 120));
          if (researchBrief && socialBrief) researchBrief += '\n\n' + socialBrief;
          else if (!researchBrief && socialBrief) researchBrief = socialBrief;

          // FOR FEATURE/ARCH-CHANGE: research is mandatory - throw if failed
          if (!researchBrief) {
            throw new Error('Research gate failed: unable to fetch live data for "' + card.text + '" (required for risk=' + risk + ')');
          }

          if (researchBrief && brain) {
            researchStatus = 'grounded';
            try {
              var grounded = await brain.think({
                lane: 'build',
                messages: [{ role: 'user', content: basePrompt + '\n\n' + researchBrief }],
                source: 'pipeline-grounded:' + j.id
              });
              if (grounded && !grounded.offline && grounded.content) {
                raw = grounded.content;
              }
            } catch (_) { /* research/rebuild failed — use original raw */ }
          }
        }

        var artifact = saveDeliverable(raw, card.text, 'pipeline');

        // P22: Full review gate — visual verify + reviewer + reality check
        // P23: skip for tiny-fix (build only) and quick-win (verify-only, no full review)
        var review = needsReview ? await fullReview(card, artifact, brain) : { verdict: 'approve', issues: [], visualDescription: '' };

        // If rejected, retry once with the issues fed back to the builder
        if (review.verdict === 'reject' && !j._reviewRetried && brain) {
          j._reviewRetried = true;
          try {
            var retryResult = await brain.think({
              lane: 'build',
              messages: [{ role: 'user', content:
                basePrompt + '\n\nYour previous output was rejected by review for these reasons:\n' +
                review.issues.map(function(i) { return '- ' + i; }).join('\n') +
                '\nFix ALL of these issues and regenerate the complete deliverable.'
              }],
              source: 'pipeline-retry:' + j.id
            });
            if (retryResult && !retryResult.offline && retryResult.content) {
              // Overwrite the artifact with the retry
              artifact = saveDeliverable(retryResult.content, card.text, 'pipeline');
              review = await fullReview(card, artifact, brain);
            }
          } catch (_) { /* retry failed — ship original with issues flagged */ }
        }

        // Ship — with honest status flag
        var reviewed = review.verdict === 'approve';
        var shipMeta = { progress: 100, jobId: j.id, artifact: artifact, risk: risk, researchStatus: researchStatus };
        if (!reviewed) {
          shipMeta.reviewIssues = review.issues;
          shipMeta.reviewStatus = 'failed';
        } else {
          shipMeta.reviewStatus = 'approved';
          if (review.visualDescription) shipMeta.visualReview = review.visualDescription;
        }

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
          shipMeta.evidence = { pass: true, phases: riskClassifierLib.gatePath(risk) };
        }

        // BUG-016 FIX: Only move to 'shipped' when review passed. If review failed,
        // move back to 'execute' with failure metadata so the user can see issues
        // and take action, rather than silently advancing to shipped.
        if (reviewed) {
          pipeline.moveCard(card.id, 'shipped', shipMeta);
        } else {
          pipeline.moveCard(card.id, 'execute', shipMeta);
        }
        return { artifact: artifact, review: review, researchStatus: researchStatus };
      }
    });
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
      if (designSystem) {
        try {
          var ds = designSystemEngine.generateDesignSystem(card.title + ' ' + (card.detail || ''));
          var dsBlock = designSystemEngine.formatDesignSystemForPrompt(ds);
          if (dsBlock) return dsBlock + '\n\n' + base;
        } catch (_) { /* best-effort */ }
      }
      return base;
    })();

    var job = enqueueOrThrow({
      kind: 'kanban-build',
      goalId: goalId,
      prompt: basePrompt,
      persona: builderPersona,
      run: async function(raw, j) {
        var slug = (card.title || 'card').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'card';

        // P23: Risk-classified gate path for kanban cards
        var risk = riskClassifierLib.classify((card.title || '') + ' ' + (card.detail || ''));
        var needsResearch = riskClassifierLib.requiresResearch(risk);
        var needsReview = riskClassifierLib.requiresReview(risk);

        // P22: Research gate — gather real web data before committing to the build.
        // A4: track researchStatus for observability (never fail silently).
        var researchStatus = needsResearch ? 'pending' : 'not-required';
        if (needsResearch) {
          var researchTopic = card.title + ' ' + (card.detail || '');
          var researchBrief = await researchForBuild(researchTopic, 5);
          // A3: enrich with social signals if agent-reach is installed (optional)
          var socialBrief = await socialResearchForBuild(String(researchTopic).slice(0, 120));
          if (researchBrief && socialBrief) researchBrief += '\n\n' + socialBrief;
          else if (!researchBrief && socialBrief) researchBrief = socialBrief;
          if (researchBrief && brain) {
            researchStatus = 'grounded';
            try {
              var grounded = await brain.think({
                lane: 'build',
                persona: builderPersona,
                messages: [{ role: 'user', content: basePrompt + '\n\n' + researchBrief }],
                source: 'kanban-grounded:' + j.id
              });
              if (grounded && !grounded.offline && grounded.content) {
                raw = grounded.content;
              }
            } catch (_) { /* research/rebuild failed — use original raw */ }
          } else {
            researchStatus = 'skipped';
            if (bus) bus.emit('health.anomaly', { kind: 'research-skipped', cardId: card.id, topic: String(researchTopic).slice(0, 100) });
          }
        }

        var artifact = saveDeliverable(raw, slug + '-' + j.id, 'kanban');

        // P22: Full review gate (P23: skip for tiny-fix)
        var review = needsReview ? await fullReview(card, artifact, brain) : { verdict: 'approve', issues: [], visualDescription: '' };

        // If rejected, retry once with the issues fed back
        if (review.verdict === 'reject' && !j._reviewRetried && brain) {
          j._reviewRetried = true;
          try {
            var retryResult = await brain.think({
              lane: 'build',
              persona: builderPersona,
              messages: [{ role: 'user', content:
                basePrompt + '\n\nYour previous output was rejected by review for these reasons:\n' +
                review.issues.map(function(i) { return '- ' + i; }).join('\n') +
                '\nFix ALL of these issues and regenerate the complete deliverable.'
              }],
              source: 'kanban-retry:' + j.id
            });
            if (retryResult && !retryResult.offline && retryResult.content) {
              artifact = saveDeliverable(retryResult.content, slug + '-' + j.id + '-r', 'kanban');
              review = await fullReview(card, artifact, brain);
            }
          } catch (_) { /* retry failed — ship original with issues flagged */ }
        }

        var reviewed = review.verdict === 'approve';
        var patchMeta = { lane: 'review', jobId: j.id, builderOutput: artifact.title, artifact: artifact, researchStatus: researchStatus };
        if (!reviewed) {
          patchMeta.reviewIssues = review.issues;
          patchMeta.reviewStatus = 'failed';
        } else {
          patchMeta.reviewStatus = 'approved';
          if (review.visualDescription) patchMeta.visualReview = review.visualDescription;
        }
        kanban.patchCard(card.id, patchMeta);
        return { artifact: artifact, review: review, researchStatus: researchStatus };
      }
    });
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

    var job = enqueueOrThrow({
      kind: 'kanban-review',
      goalId: goalId,
      prompt: REVIEWER_PREAMBLE +
        '\n\nTASK: ' + card.title + (card.detail ? ' — ' + card.detail : '') +
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
    researchForBuild: researchForBuild,
    verifyBuildVisually: verifyBuildVisually,
    fullReview: fullReview,
    executePipelineCard: executePipelineCard,
    assembleKanbanPlan: assembleKanbanPlan,
    buildKanbanCard: buildKanbanCard,
    reviewKanbanCard: reviewKanbanCard
  };
}

module.exports = { createAgentActions, extractJsonBlock };
