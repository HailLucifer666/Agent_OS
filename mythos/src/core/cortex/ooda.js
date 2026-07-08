// cortex/ooda.js — pure OODA stage functions.
// Stateless helpers used by cortex/index.js tick loop.

const REFLECT_EVERY = 10;     // every N ticks
const CONSOLIDATE_EVERY = 60;  // every N ticks

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

function shouldReflect(tick) {
  return tick % REFLECT_EVERY === 0;
}

function shouldConsolidate(tick) {
  return tick % CONSOLIDATE_EVERY === 0;
}

module.exports = { orient, goalRelevance, shouldReflect, shouldConsolidate, REFLECT_EVERY, CONSOLIDATE_EVERY };
