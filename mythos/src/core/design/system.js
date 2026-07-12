'use strict';

// design/system.js — the design system generator. Given a product/idea description,
// looks up the matching industry rules, style, color palette, typography, and
// landing page pattern via BM25 search. Returns a structured design system the
// build agent uses to generate professional-looking deliverables.

var loader = require('./data-loader');

// 3-stage reasoning-rule cascade: exact match → substring → keyword tokens
function findReasoningRule(category) {
  var rules = loader.loadCsv('ui-reasoning.csv');
  if (!rules.length) return null;
  var cat = (category || '').toLowerCase().trim();

  // Stage 1: exact match
  for (var i = 0; i < rules.length; i++) {
    if (rules[i].UI_Category && rules[i].UI_Category.toLowerCase().trim() === cat) {
      return rules[i];
    }
  }
  // Stage 2: substring containment
  for (var j = 0; j < rules.length; j++) {
    var ruleCat = (rules[j].UI_Category || '').toLowerCase();
    if (ruleCat && (ruleCat.includes(cat) || cat.includes(ruleCat))) {
      return rules[j];
    }
  }
  // Stage 3: keyword token match
  var queryTokens = cat.split(/[\s,]+/).filter(function(t) { return t.length >= 2; });
  var bestScore = 0;
  var bestRule = null;
  for (var k = 0; k < rules.length; k++) {
    var ruleTokens = (rules[k].UI_Category || '').toLowerCase().split(/[\s,]+/);
    var hits = 0;
    for (var q = 0; q < queryTokens.length; q++) {
      if (ruleTokens.indexOf(queryTokens[q]) !== -1) hits++;
    }
    if (hits > bestScore) { bestScore = hits; bestRule = rules[k]; }
  }
  return bestRule;
}

// Re-rank style results by exact-name and keyword match against the reasoning's Style_Priority
function rerankStyles(styles, stylePriority) {
  if (!stylePriority) return styles;
  var priorityNames = stylePriority.toLowerCase().split('+').map(function(s) { return s.trim(); });
  return styles.map(function(s) {
    var score = 0;
    var styleName = (s['Style Category'] || '').toLowerCase();
    var keywords = (s['Keywords'] || '').toLowerCase();
    for (var i = 0; i < priorityNames.length; i++) {
      var pn = priorityNames[i].trim();
      if (pn && styleName.includes(pn)) score += 10;
      if (pn && keywords.includes(pn)) score += 3;
    }
    return { doc: s, score: score };
  }).sort(function(a, b) { return b.score - a.score; })
    .map(function(item) { return item.doc; });
}

function generateDesignSystem(query) {
  // 1. Find the product type
  var productResults = loader.searchDomain('product', query, 1);
  var category = productResults.length > 0 ? (productResults[0]['Product Type'] || '') : '';

  // 2. Find the reasoning rule for this category
  var reasoning = category ? findReasoningRule(category) : null;

  // 3. Run BM25 across style, color, landing, typography
  var styleQuery = query;
  if (reasoning && reasoning.Style_Priority) {
    styleQuery = query + ' ' + reasoning.Style_Priority;
  }
  var styles = loader.searchDomain('style', styleQuery, 3);
  if (reasoning && reasoning.Style_Priority) {
    styles = rerankStyles(styles, reasoning.Style_Priority);
  }
  var colors = loader.searchDomain('color', category || query, 1);
  var landing = loader.searchDomain('landing', query, 1);
  var typography = loader.searchDomain('typography', query, 1);

  // 4. Build the design system object
  var ds = {
    category: category || 'General',
    style: styles[0] || null,
    colors: colors[0] || null,
    typography: typography[0] || null,
    landingPattern: landing[0] || null,
    keyEffects: reasoning ? reasoning.Key_Effects : null,
    antiPatterns: reasoning ? reasoning.Anti_Patterns : null,
    checklist: [
      'No emojis as icons (use SVG: Heroicons/Lucide)',
      'cursor-pointer on all clickable elements',
      'Hover states with smooth transitions (150-300ms)',
      'Light mode: text contrast 4.5:1 minimum',
      'Focus states visible for keyboard nav',
      'prefers-reduced-motion respected',
      'Responsive: 375px, 768px, 1024px, 1440px',
    ],
  };

  return ds;
}

// Format the design system as a prompt-injectable string for the build agent
function formatDesignSystemForPrompt(ds) {
  if (!ds) return '';
  var lines = ['DESIGN SYSTEM (use these exact values — do not improvise):'];

  if (ds.category) lines.push('Industry: ' + ds.category);

  if (ds.style) {
    lines.push('Style: ' + (ds.style['Style Category'] || '') +
      ' — ' + (ds.style['Keywords'] || ''));
    if (ds.style['Effects & Animation']) lines.push('Effects: ' + ds.style['Effects & Animation']);
  }

  if (ds.colors) {
    lines.push('Colors:');
    if (ds.colors.Primary) lines.push('  Primary: ' + ds.colors.Primary);
    if (ds.colors.Secondary) lines.push('  Secondary: ' + ds.colors.Secondary);
    if (ds.colors.Accent) lines.push('  Accent: ' + ds.colors.Accent);
    if (ds.colors.Background) lines.push('  Background: ' + ds.colors.Background);
    if (ds.colors.Foreground) lines.push('  Foreground: ' + ds.colors.Foreground);
    if (ds.colors.Muted) lines.push('  Muted: ' + ds.colors.Muted);
    if (ds.colors.Border) lines.push('  Border: ' + ds.colors.Border);
  }

  if (ds.typography) {
    lines.push('Typography:');
    if (ds.typography['Heading Font']) lines.push('  Heading: ' + ds.typography['Heading Font']);
    if (ds.typography['Body Font']) lines.push('  Body: ' + ds.typography['Body Font']);
    if (ds.typography['CSS Import']) lines.push('  CSS Import: ' + ds.typography['CSS Import']);
  }

  if (ds.landingPattern) {
    lines.push('Layout Pattern: ' + (ds.landingPattern['Pattern Name'] || ''));
    if (ds.landingPattern['Section Order']) lines.push('  Sections: ' + ds.landingPattern['Section Order']);
    if (ds.landingPattern['Primary CTA Placement']) lines.push('  CTA: ' + ds.landingPattern['Primary CTA Placement']);
  }

  if (ds.keyEffects) lines.push('Key Effects: ' + ds.keyEffects);
  if (ds.antiPatterns) lines.push('AVOID (anti-patterns for this industry): ' + ds.antiPatterns);

  if (ds.checklist && ds.checklist.length) {
    lines.push('Pre-delivery checklist:');
    for (var i = 0; i < ds.checklist.length; i++) {
      lines.push('  [ ] ' + ds.checklist[i]);
    }
  }

  return lines.join('\n');
}

module.exports = { generateDesignSystem: generateDesignSystem, formatDesignSystemForPrompt: formatDesignSystemForPrompt, findReasoningRule: findReasoningRule };
