'use strict';

// effectors/from-skills.js — exposes external ZCode skills as a use_skill tool.
// Same DI convention as from-system.js / from-project.js.
//
// The skills loader (../skills/loader.js) reads a curated allowlist
// (mythos/skills.allowlist) and resolves each entry to ~/.zcode/skills/<name>/SKILL.md.
// This effector gives the model a single tool — use_skill({ name }) — that
// returns the full skill guidance text on demand, so the model can discover
// skills from the one-line catalog in the prompt, pull full guidance when a
// task fits, and apply it. Without this, the skills were invisible to Mythos.

const { effectorFromTool } = require('./adapter');
const skillsLoader = require('../skills/loader');

function buildTools() {
  function useSkill({ name }) {
    if (!name || !String(name).trim()) {
      return { ok: false, result: 'A skill name is required. Call with one of the names from the SKILLS AVAILABLE list.' };
    }
    var skillName = String(name).trim();
    var content = skillsLoader.loadContent(skillName);
    if (!content) {
      // List what's actually available so the model can self-correct.
      var available = skillsLoader.loadCatalog().map(function(s) { return s.name; });
      return {
        ok: false,
        result: 'Skill "' + skillName + '" not found. Available skills: ' +
          (available.length ? available.join(', ') : '(none — check skills.allowlist)')
      };
    }
    return { ok: true, result: { name: skillName, content: content } };
  }

  return [{
    name: 'use_skill',
    description: 'Load the full guidance text for a skill (methodology or design guide) by name. Use this when a task fits a skill listed in SKILLS AVAILABLE — e.g. use_skill({name:"ui-ux-pro-max"}) before building a UI, use_skill({name:"spec-driven-development"}) before starting a project, use_skill({name:"tdd-workflow"}) before writing tests. Returns the complete skill instructions to apply.',
    params: { name: 'string - the skill name from the SKILLS AVAILABLE list' },
    danger: false,
    fn: useSkill,
  }];
}

function registerFromSkills(hub) {
  var tools = buildTools();
  for (var i = 0; i < tools.length; i++) hub.register(effectorFromTool(tools[i]));
  return tools.length;
}

module.exports = { registerFromSkills, buildTools };
