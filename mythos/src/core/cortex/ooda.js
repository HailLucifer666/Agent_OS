// cortex/ooda.js — pure OODA stage functions.
// Stateless helpers used by cortex/index.js tick loop.

const REFLECT_EVERY = 10;      // fallback cadence (ticks) if config absent
const CONSOLIDATE_EVERY = 60;  // fallback cadence (ticks) if config absent

// Read cadences from the validated config object (schema.js keys
// REFLECT_EVERY / CONSOLIDATE_EVERY) with the hardcoded fallbacks above.
// Previously these functions ignored config entirely — the schema keys were
// orphaned (defined in schema.js but nothing read them), so setting
// REFLECT_EVERY=120 in .env silently did nothing. config is optional for
// backward compatibility with tests that call shouldReflect(tick) directly.
function reflectEvery(cfg) {
  return (cfg && typeof cfg.REFLECT_EVERY === 'number' && cfg.REFLECT_EVERY > 0)
    ? cfg.REFLECT_EVERY : REFLECT_EVERY;
}
function consolidateEvery(cfg) {
  return (cfg && typeof cfg.CONSOLIDATE_EVERY === 'number' && cfg.CONSOLIDATE_EVERY > 0)
    ? cfg.CONSOLIDATE_EVERY : CONSOLIDATE_EVERY;
}

function orient(perceptions, activeGoal) {
  // Rank each perception by salience + goal relevance boost
  return perceptions.map(function(p) {
    var goalBoost = 0;
    if (activeGoal) {
      goalBoost = goalRelevance(p, activeGoal) * 0.3;
    }
    var ranked = Math.min((p.salience || 0) + goalBoost, 1.0);
    return { perception: p, rankedSalience: ranked };
  }).sort(function(a, b) { return b.rankedSalience - a.rankedSalience; });
}

function goalRelevance(perception, goal) {
  // Simple keyword overlap between perception and goal title/reason
  if (!perception || !goal) return 0;
  const goalText = ((goal.title || '') + ' ' + (goal.reason || '')).toLowerCase();
  const pText = ((perception.summary || '') + ' ' + (perception.channel || '')).toLowerCase();
  if (!goalText || !pText) return 0;
  const goalTerms = goalText.split(/\s+/).filter(Boolean);
  const pTerms = pText.split(/\s+/).filter(Boolean);
  let hits = 0;
  for (var i = 0; i < pTerms.length; i++) {
    if (goalTerms.indexOf(pTerms[i]) !== -1) hits++;
  }
  return pTerms.length > 0 ? hits / pTerms.length : 0;
}

function shouldReflect(tick, cfg) {
  return tick % reflectEvery(cfg) === 0;
}

function shouldConsolidate(tick, cfg) {
  return tick % consolidateEvery(cfg) === 0;
}

module.exports = { orient, goalRelevance, shouldReflect, shouldConsolidate,
  REFLECT_EVERY, CONSOLIDATE_EVERY, reflectEvery, consolidateEvery };
