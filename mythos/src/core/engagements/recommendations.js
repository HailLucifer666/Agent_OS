'use strict';

// Recommendation engine for build vs research vs hybrid
// ENGAGEMENT-SPEC section 1.1 recommendations interface

function createRecommendations({ config }) {
  if (!config) throw new Error('config required');

  // Generate recommendations from spec
  function generate(spec) {
    if (!spec) {
      return Promise.resolve([]);
    }

    var recs = [];
    var markdown = spec.markdown || '';

    // Analyze spec content for recommendation types
    var hasResearchIndicators = analyzeResearchIndicators(markdown);
    var hasBuildIndicators = analyzeBuildIndicators(markdown);

    // Research recommendation
    if (hasResearchIndicators) {
      recs.push({
        type: 'research',
        title: 'Research First',
        rationale: 'Spec indicates research is needed before building',
        confidence: 0.8
      });
    }

    // Build recommendation
    if (hasBuildIndicators) {
      recs.push({
        type: 'build',
        title: 'Build Direct',
        rationale: 'Spec describes buildable deliverable',
        confidence: 0.9
      });
    }

    // Hybrid recommendation if both indicators present
    if (hasResearchIndicators && hasBuildIndicators) {
      recs.push({
        type: 'hybrid',
        title: 'Research then Build',
        rationale: 'Spec needs both research and implementation',
        confidence: 0.75
      });
    }

    // Default recommendations if none detected
    if (recs.length === 0) {
      recs.push({
        type: 'build',
        title: 'Build Approach',
        rationale: 'Direct build from spec',
        confidence: 0.7
      });
    }

    return Promise.resolve(recs);
  }

  // Select a recommendation by index
  function select(recommendations, index) {
    if (!recommendations || !Array.isArray(recommendations)) {
      throw new Error('Recommendations array required');
    }
    if (index === undefined || index === null) {
      throw new Error('Index required');
    }
    if (index < 0 || index >= recommendations.length) {
      throw new Error('Index out of range: ' + index);
    }
    return recommendations[index];
  }

  // Score confidence of a recommendation
  function scoreConfidence(recommendation) {
    if (!recommendation || typeof recommendation.confidence !== 'number') {
      return 0;
    }
    return Math.max(0, Math.min(1, recommendation.confidence));
  }

  // Analyze text for research indicators
  function analyzeResearchIndicators(text) {
    var lowered = text.toLowerCase();
    var indicators = [
      'research', 'investigate', 'explore', 'survey', 'analyze',
      'compare', 'evaluate', 'study', 'learn about'
    ];
    return indicators.some(function(ind) { return lowered.includes(ind); });
  }

  // Analyze text for build indicators
  function analyzeBuildIndicators(text) {
    var lowered = text.toLowerCase();
    var indicators = [
      'build', 'create', 'implement', 'develop', 'write',
      'code', 'function', 'component', 'module', 'app', 'tool'
    ];
    return indicators.some(function(ind) { return lowered.includes(ind); });
  }

  return {
    generate: generate,
    select: select,
    scoreConfidence: scoreConfidence
  };
}

module.exports = { createRecommendations };