// tools-dashboard.test.js — voice dashboard tools over goals/kanban/pipeline/orchestrator.
// Focus: the goals staleness scenario (positional/reindexed ids), TOOLS catalog shape, and
// each tool's never-throws / {ok,result} contract.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, rmrf } = require('../test-helpers');

const TMP = tempVaultDir();
process.env.VAULT_ROOT = TMP;

const tools = require('./tools-dashboard');
const goals = require('../goals');
const kanban = require('../kanban');

describe('tools-dashboard.js', () => {
  after(() => {
    rmrf(TMP);
    delete process.env.VAULT_ROOT;
  });

  test('TOOLS catalog has name/description/params/danger for every entry', () => {
    assert.ok(Array.isArray(tools.TOOLS) && tools.TOOLS.length > 0);
    for (const t of tools.TOOLS) {
      assert.equal(typeof t.name, 'string');
      assert.equal(typeof t.description, 'string');
      assert.equal(typeof t.params, 'object');
      assert.equal(typeof t.danger, 'boolean');
      assert.equal(typeof t.fn, 'function');
    }
  });

  test('danger:true tools are exactly delete_goal, pipeline_execute, kanban_assemble, kanban_build_card, kill_session', () => {
    const dangerNames = tools.TOOLS.filter((t) => t.danger).map((t) => t.name).sort();
    assert.deepEqual(dangerNames, [
      'delete_goal', 'kanban_assemble', 'kanban_build_card', 'kill_session', 'pipeline_execute',
    ].sort());
  });

  test('navigate({route:"kanban board"}) resolves the synonym to "kanban" with a uiActions navigate entry', () => {
    const res = tools.navigate({ route: 'kanban board' });
    assert.equal(res.ok, true);
    assert.equal(res.result.route, 'kanban');
    assert.deepEqual(res.uiActions, [{ action: 'navigate', route: 'kanban' }]);
  });

  test('navigate({route:"nonsense"}) returns ok:false, never throws', () => {
    assert.doesNotThrow(() => {
      const res = tools.navigate({ route: 'totally-not-a-route' });
      assert.equal(res.ok, false);
    });
  });

  test('create_goal / list_goals round-trip', () => {
    const created = tools.create_goal({ text: 'Ship the voice agent', category: 'Engineering' });
    assert.equal(created.ok, true);
    const listed = tools.list_goals();
    assert.equal(listed.ok, true);
    assert.ok(listed.result.goals.some((g) => g.text === 'Ship the voice agent'));
  });

  test('create_goal({text:""}) returns ok:false without throwing', () => {
    const res = tools.create_goal({ text: '' });
    assert.equal(res.ok, false);
  });

  test('toggle_goal({query}) matches by substring and flips done', () => {
    tools.create_goal({ text: 'Toggle target goal' });
    const res = tools.toggle_goal({ query: 'toggle target' });
    assert.equal(res.ok, true);
    const target = res.result.goals.find((g) => g.text === 'Toggle target goal');
    assert.equal(target.done, true);
  });

  test('toggle_goal({query}) with no match returns ok:false', () => {
    const res = tools.toggle_goal({ query: 'nothing matches this string xyz' });
    assert.equal(res.ok, false);
  });

  // ---- THE staleness scenario from the brief ----
  // goals.js ids are positional (reindex() rewrites every id to its array index on every
  // mutation). toggle_goal/delete_goal MUST re-fetch goals.listGoals() fresh inside the tool
  // call, right before acting, and resolve the target by matching `query` against CURRENT
  // text — never by an id/index carried over from an earlier list() call, because an
  // intervening mutation elsewhere can have reindexed everything underneath it.
  test('delete_goal acts on whatever is actually at the matched position NOW, not a stale snapshot', () => {
    // Reset to a known, empty state.
    let cur = goals.listGoals();
    while (cur.length > 0) {
      goals.deleteGoal(String(cur.length - 1));
      cur = goals.listGoals();
    }
    goals.addGoal('Alpha', 'General');
    goals.addGoal('Beta', 'General');
    goals.addGoal('Gamma', 'General');

    // Simulate the LLM having listed goals in an earlier turn and remembering "Beta is at
    // index 1" — then, BEFORE the delete_goal tool call executes, an intervening mutation
    // (e.g. a different voice turn, or a REST client) reindexes the array by deleting index 0.
    const earlierSnapshot = goals.listGoals();
    assert.equal(earlierSnapshot[1].text, 'Beta', 'sanity: Beta starts at index 1');

    goals.deleteGoal('0'); // deletes Alpha; Beta reindexes from id "1" -> id "0", Gamma "2" -> "1"
    const afterIntervening = goals.listGoals();
    assert.equal(afterIntervening[0].text, 'Beta', 'sanity: Beta is now at index 0 after reindex');
    assert.equal(afterIntervening[1].text, 'Gamma', 'sanity: Gamma is now at index 1 after reindex');

    // Now the voice tool runs with a query that matches "Gamma" by TEXT (the honest interface —
    // never a raw index). It must re-fetch and act on Gamma, which is now at index 1 for real,
    // NOT wherever the LLM's stale earlier-turn snapshot thought Gamma was (index 2).
    const res = tools.delete_goal({ query: 'gamma' });
    assert.equal(res.ok, true);
    assert.equal(res.result.deleted, 'Gamma');
    const finalList = goals.listGoals();
    assert.ok(!finalList.some((g) => g.text === 'Gamma'), 'Gamma must actually be gone');
    assert.ok(finalList.some((g) => g.text === 'Beta'), 'Beta must be untouched');
  });

  test('delete_goal({query}) with no match returns ok:false and deletes nothing', () => {
    let cur = goals.listGoals();
    while (cur.length > 0) {
      goals.deleteGoal(String(cur.length - 1));
      cur = goals.listGoals();
    }
    goals.addGoal('Solo goal', 'General');
    const before = goals.listGoals().length;
    const res = tools.delete_goal({ query: 'does not exist anywhere' });
    assert.equal(res.ok, false);
    assert.equal(goals.listGoals().length, before, 'nothing should have been deleted');
  });

  test('capture_idea / pipeline_status', () => {
    const captured = tools.capture_idea({ text: 'Build a changelog generator' });
    assert.equal(captured.ok, true);
    const status = tools.pipeline_status();
    assert.equal(status.ok, true);
    assert.ok(status.result.board.capture.some((c) => c.text === 'Build a changelog generator'));
  });

  test('capture_idea({text:""}) returns ok:false', () => {
    assert.equal(tools.capture_idea({ text: '' }).ok, false);
  });

  test('kanban_status / kanban_add_card / kanban_move_card round-trip (stable ids, plain lookup)', () => {
    const added = tools.kanban_add_card({ title: 'Voice tool test card' });
    assert.equal(added.ok, true);
    const moved = tools.kanban_move_card({ query: 'voice tool test', lane: 'review' });
    assert.equal(moved.ok, true);
    assert.equal(moved.result.card.lane, 'review');
    const status = tools.kanban_status();
    assert.ok(status.result.board.cards.some((c) => c.title === 'Voice tool test card' && c.lane === 'review'));
  });

  test('kanban_move_card({query}) with no match returns ok:false', () => {
    const res = tools.kanban_move_card({ query: 'no such card exists', lane: 'done' });
    assert.equal(res.ok, false);
  });

  test('kanban_add_card({title:""}) returns ok:false', () => {
    assert.equal(tools.kanban_add_card({ title: '' }).ok, false);
  });

  test('read_status never throws and returns ok:true with a status object', async () => {
    const res = await tools.read_status();
    assert.equal(res.ok, true);
    assert.equal(typeof res.result.status, 'object');
  });

  test('job_status() with no jobId returns the most recent job or null, never throws', () => {
    const res = tools.job_status({});
    assert.equal(res.ok, true);
    assert.ok('job' in res.result);
  });

  test('job_status({jobId}) unknown id returns ok:false', () => {
    const res = tools.job_status({ jobId: 'job-does-not-exist' });
    assert.equal(res.ok, false);
  });

  test('ask_agent without a wired dispatch returns ok:false, never throws', async () => {
    const res = await tools.ask_agent({ seat: 'hermes', prompt: 'hello' });
    assert.equal(res.ok, false);
  });

  test('ask_agent uses the injected dispatch and caps the reply to 600 chars', async () => {
    tools.setAskAgentDispatch(async () => 'x'.repeat(1000));
    const res = await tools.ask_agent({ seat: 'hermes', prompt: 'hello' });
    assert.equal(res.ok, true);
    assert.equal(res.result.reply.length, 600);
    tools.setAskAgentDispatch(null);
  });

  test('monitor_snapshot never throws and returns an object', () => {
    const res = tools.monitor_snapshot();
    assert.equal(res.ok, true);
    assert.equal(typeof res.result, 'object');
  });

  test('kill_session without pid/agentCli returns ok:false, never throws', async () => {
    const res = await tools.kill_session({});
    assert.equal(res.ok, false);
  });

  test('kill_session with a pid not in the last snapshot returns ok:false, never throws', async () => {
    const res = await tools.kill_session({ pid: 999999, agentCli: 'claude' });
    assert.equal(res.ok, false);
  });
});
