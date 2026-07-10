'use strict';

// spoken-text.js — sanitize LLM reply text for TTS. LLMs emit markdown
// (**bold**, bullets, backticks) and written abbreviations (e.g., i.e.) that
// speech engines read literally ("asterisk asterisk", "e g"). The caption
// keeps the original text; only the spoken form goes through this.
// Pure function, no deps, never throws.

const ABBREVIATIONS = [
  [/\be\.g\.,?/gi, 'for example,'],
  [/\bi\.e\.,?/gi, 'that is,'],
  [/\betc\./gi, 'et cetera.'],
  [/\betc\b/gi, 'et cetera'],
  [/\bvs\.?(?!\w)/gi, 'versus'],
];

function sanitizeSpoken(text) {
  let s = String(text || '');
  // code blocks & inline code
  s = s.replace(/```[\s\S]*?```/g, ' code omitted ');
  s = s.replace(/`([^`]*)`/g, '$1');
  // links: [label](url) -> label
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // bold / italic pairs, then any leftover markers, headers, blockquotes
  s = s.replace(/(\*\*|__)([\s\S]*?)\1/g, '$2');
  s = s.replace(/(\*|_)([^*_]*)\1/g, '$2');
  s = s.replace(/[*#>]+/g, ' ');
  // list bullets / numbering at line starts
  s = s.replace(/^\s*[-•]\s+/gm, '');
  s = s.replace(/^\s*\d+\.\s+/gm, '');
  // spoken abbreviations
  for (const [re, rep] of ABBREVIATIONS) s = s.replace(re, rep);
  s = s.replace(/&/g, ' and ');
  // collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

module.exports = { sanitizeSpoken };
