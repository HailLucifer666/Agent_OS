'use strict';

// Spec generation from interview answers
// ENGAGEMENT-SPEC section 1.1 spec-builder interface

function createSpecBuilder({ config }) {
  if (!config) throw new Error('config required');

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
    toMarkdown: toMarkdown,
    toJsonSchema: toJsonSchema
  };
}

module.exports = { createSpecBuilder };