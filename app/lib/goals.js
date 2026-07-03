// goals.js — Goals CRUD persisted to vault/Goals.md
// Line format: - [ ] text · category · ISO date   (x inside brackets = done)
const vault = require('./vault');

const FILE = 'Goals.md';
const LINE_RE = /^- \[( |x)\] (.+?) · (.+?) · (\d{4}-\d{2}-\d{2}T[\d:.Z-]+)$/;

function parseGoals() {
  const text = vault.readText(FILE, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const goals = [];
  lines.forEach((line, idx) => {
    const m = LINE_RE.exec(line.trim());
    if (m) {
      goals.push({
        id: String(idx),
        done: m[1] === 'x',
        text: m[2],
        category: m[3],
        created: m[4],
      });
    }
  });
  return goals;
}

function serializeGoals(goals) {
  return goals
    .map((g) => `- [${g.done ? 'x' : ' '}] ${g.text} · ${g.category} · ${g.created}`)
    .join('\n') + (goals.length ? '\n' : '');
}

function saveGoals(goals) {
  vault.writeText(FILE, serializeGoals(goals));
}

function listGoals() {
  return parseGoals();
}

function addGoal(text, category) {
  const goals = parseGoals();
  goals.push({
    id: String(goals.length),
    done: false,
    text: text.trim(),
    category: category && category.trim() ? category.trim() : 'General',
    created: new Date().toISOString(),
  });
  saveGoals(goals);
  return reindex(goals);
}

function toggleGoal(id) {
  const goals = parseGoals();
  const idx = Number(id);
  if (goals[idx]) goals[idx].done = !goals[idx].done;
  saveGoals(goals);
  return reindex(goals);
}

function deleteGoal(id) {
  const goals = parseGoals();
  const idx = Number(id);
  if (idx >= 0 && idx < goals.length) goals.splice(idx, 1);
  saveGoals(goals);
  return reindex(goals);
}

// Re-derive ids after mutation (ids are positional).
function reindex(goals) {
  return goals.map((g, i) => ({ ...g, id: String(i) }));
}

function stats() {
  const goals = parseGoals();
  const total = goals.length;
  const completed = goals.filter((g) => g.done).length;
  const active = total - completed;
  const progress = total === 0 ? 0 : Math.round((completed / total) * 100);
  return { total, active, completed, progress };
}

module.exports = { listGoals, addGoal, toggleGoal, deleteGoal, stats, FILE };
