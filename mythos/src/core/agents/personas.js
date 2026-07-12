'use strict';

// agents/personas.js — specialized agent persona registry. Each role has a
// markdown file in vault/Personas/ defining its expertise, process, and style.
// Loaded on demand and cached. Used by the mission orchestrator to dispatch
// specialized builder/reviewer agents.

var fs = require('fs');
var path = require('path');

var PERSONAS_DIR = path.join(__dirname, '..', '..', '..', 'vault', 'Personas');
var cache = {};

function loadPersona(role) {
  if (!role) return null;
  if (cache[role]) return cache[role];
  var filePath = path.join(PERSONAS_DIR, role + '.md');
  try {
    var content = fs.readFileSync(filePath, 'utf8');
    cache[role] = content.trim();
    return cache[role];
  } catch (err) {
    return null; // persona not found — caller falls back to global identity
  }
}

function listPersonas() {
  try {
    return fs.readdirSync(PERSONAS_DIR)
      .filter(function(f) { return f.endsWith('.md'); })
      .map(function(f) { return f.replace('.md', ''); });
  } catch (err) {
    return [];
  }
}

// Pick the best persona for a kanban card based on its title/detail content
function pickBuilderPersona(cardTitle, cardDetail) {
  var text = ((cardTitle || '') + ' ' + (cardDetail || '')).toLowerCase();
  var frontendKeywords = ['ui', 'ux', 'page', 'landing', 'frontend', 'design', 'css', 'layout', 'component', 'navigation', 'dashboard', 'form', 'button', 'hero', 'sidebar', 'interface'];
  for (var i = 0; i < frontendKeywords.length; i++) {
    if (text.includes(frontendKeywords[i])) return 'frontend-builder';
  }
  return 'backend-builder';
}

module.exports = { loadPersona: loadPersona, listPersonas: listPersonas, pickBuilderPersona: pickBuilderPersona };
