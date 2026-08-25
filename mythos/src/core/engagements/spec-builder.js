'use strict';

// Spec generation from interview answers
// ENGAGEMENT-SPEC section 1.1 spec-builder interface

function createSpecBuilder({ config, brain, buildEngine }) {
  if (!config) throw new Error('config required');
  // V6 (Phase 4): brain is optional. When absent or offline, build() falls
  // back to the deterministic markdown template (honest-inert).
  // Phase B: buildEngine (DeepSeek Harness) is now the preferred generator for
  // buildBrain() below — brain.think was a second, independent generator with
  // no queue/verifier/review behind it, same reasoning as executor.js's build
  // stage. buildEngine.generate() returns a brain.think-compatible shape
  // ({content, offline, aborted}), so buildBrain()'s existing offline/content
  // checks work unchanged against either source.

  // Build spec from interview answers
  function build(interview) {
    if (!interview || !interview.questions) {
      throw new Error('Interview data required');
    }

    var answers = {};
    interview.questions.forEach(function(q) {
      if (q.answer) {
        answers[q.id] = q.answer;
      }
    });

    var schema = {
      type: 'object',
    properties: {
      stack: { type: 'string' },
      scope: { type: 'string' }
    }
    };

    var spec = {
      markdown: generateMarkdown(answers),
      schema: schema,
      recommendations: generateRecommendations(answers),
      selectedRecommendation: null
    };

    return Promise.resolve(spec);
  }

  // V6 (Phase 4): brain-driven spec generation. Asks the brain to compose a
  // richer markdown spec from the interview answers — one that captures
  // non-obvious requirements, edge cases, and a coherent narrative. The
  // canned template above remains the fallback (and still runs first so we
  // always have SOMETHING to show even if the brain is slow / offline).
  //
  // Honest-inert: on any failure returns the canned build() output. The
  // recommendations list stays template-generated either way (it drives the
  // downstream recommendation UI and shouldn't drift).
  async function buildBrain(interview) {
    var fallback = await build(interview);
    var generator = buildEngine && typeof buildEngine.generate === 'function' ? buildEngine : null;
    if (!generator && (!brain || typeof brain.think !== 'function')) return fallback;
    if (!interview || !interview.questions) return fallback;
    var answerLines = interview.questions
      .filter(function (q) { return q.answer; })
      .map(function (q) { return '- ' + q.prompt + ': ' + q.answer; });
    if (answerLines.length === 0) return fallback;
    var prompt =
      'You are writing a project specification from interview answers.\n' +
      'Answers:\n' + answerLines.join('\n') + '\n\n' +
      'Write a clear, structured markdown spec (## sections, bullet lists). Cover:\n' +
      '- Deliverable (what we are building)\n' +
      '- Scope (what is in and out)\n' +
      '- Key technical decisions + rationale\n' +
      '- Edge cases / failure modes the build should handle\n' +
      '- Acceptance criteria (how we know it is done)\n' +
      'Do NOT invent answers that contradict the interview. Keep it under 600 words.';
    try {
      var result = generator
        ? await generator.generate({ prompt: prompt, source: 'engagement:spec' })
        : await brain.think({ lane: 'build', messages: [{ role: 'user', content: prompt }], source: 'engagement:spec' });
      if (!result || result.offline || result.aborted || !result.content) return fallback;
      var enrichedMarkdown = String(result.content).trim();
      if (enrichedMarkdown.length < 50) return fallback;   // generator returned garbage
      return Object.assign({}, fallback, { markdown: enrichedMarkdown });
    } catch (_) {
      return fallback;
    }
  }

  // Generate markdown from answers
  function generateMarkdown(answers) {
    var lines = [];

    lines.push('# Project Spec');
    lines.push('');

    // Type/deliverable
    if (answers['q-type']) {
      lines.push('## Deliverable Type');
      lines.push(answers['q-type']);
      lines.push('');
    }

    // Tech stack
    if (answers['q-stack']) {
      lines.push('## Tech Stack');
      lines.push(answers['q-stack']);
      lines.push('');
    }

    // Scope/feature
    if (answers['q-scope']) {
      lines.push('## Scope');
      lines.push(answers['q-scope']);
      lines.push('');
    }

    // Complexity
    if (answers['q-complexity']) {
      lines.push('## Complexity');
      lines.push(answers['q-complexity']);
      lines.push('');
    }

    // Requirements
    if (answers['q-requirements']) {
      lines.push('## Requirements');
      lines.push(answers['q-requirements']);
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  // Convert spec to markdown (same as generateMarkdown for now)
  function toMarkdown(spec) {
    return spec.markdown || '';
  }

  // Generate JSON Schema from spec
  function toJsonSchema(spec) {
    return spec.schema || {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        stack: { type: 'string' }
      }
    };
  }

  // Generate recommendations based on answers
  function generateRecommendations(answers) {
    var recs = [];

    // Determine recommendation type based on deliverable
    var type = answers['q-type'] || '';
    var isDocumentation = type.toLowerCase().includes('documentation');
    var isResearch = type.toLowerCase().includes('research');

    if (isDocumentation || isResearch) {
      recs.push({
        type: 'research',
        title: 'Research Approach',
        rationale: 'Research-focused deliverable suggested',
        confidence: 0.85
      });
    }

    recs.push({
      type: 'build',
      title: 'Build Approach',
      rationale: 'Direct build from spec',
      confidence: 0.75
    });

    return recs;
  }

  return {
    build: build,
    buildBrain: buildBrain,       // V6 (Phase 4)
    toMarkdown: toMarkdown,
    toJsonSchema: toJsonSchema
  };
}

module.exports = { createSpecBuilder };