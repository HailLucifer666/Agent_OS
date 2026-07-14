'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildTools } = require('../src/core/effectors/from-forge');

function stubForge() {
  const list = [];
  return {
    createProject(spec, kind, opts) { const p = { id: 'p' + (list.length + 1), status: 'planning', spec, kind, goalId: opts && opts.goalId }; list.push(p); return { id: p.id, status: p.status }; },
    applyRevision(id, feedback) { list._revised = { id, feedback }; return Promise.resolve({ ok: true }); },
    listProjects() { return list.map((p) => ({ id: p.id, status: p.status })); },
    getProject(id) { const p = id ? list.find((x) => x.id === id) : list[list.length - 1]; return p ? { id: p.id, status: p.status } : null; },
    _list: list,
  };
}

function toolMap(forge) {
  const tools = buildTools({ forge });
  const map = {};
  tools.forEach((t) => { map[t.name] = t; });
  return map;
}

describe('from-forge — build tools', () => {
  it('registers build_project (T3-shaped), revise_project, project_status', () => {
    const t = toolMap(stubForge());
    assert.ok(t.build_project && t.revise_project && t.project_status);
    assert.equal(t.build_project.danger, false);
    assert.equal(t.revise_project.danger, false);
    assert.equal(t.project_status.danger, false);
  });

  it('build_project with empty spec → {ok:false}', () => {
    const t = toolMap(stubForge());
    assert.equal(t.build_project.fn({ spec: '   ' }).ok, false);
    assert.equal(t.build_project.fn({}).ok, false);
  });

  it('build_project threads runCtx.goalId and returns raw.result.projectId', () => {
    const forge = stubForge();
    const t = toolMap(forge);
    const r = t.build_project.fn({ spec: 'build a page', kind: 'website' }, { goalId: 'g9' });
    assert.equal(r.ok, true);
    assert.ok(r.result.projectId);
    assert.equal(forge._list[0].goalId, 'g9');
    assert.equal(forge._list[0].kind, 'website');
  });

  it('revise_project with empty feedback → {ok:false}', () => {
    const t = toolMap(stubForge());
    assert.equal(t.revise_project.fn({ projectId: 'p1', feedback: '' }).ok, false);
  });

  it('revise_project defaults to the latest project when projectId omitted', () => {
    const forge = stubForge();
    forge.createProject('a', 'app');
    forge.createProject('b', 'app');
    const t = toolMap(forge);
    const r = t.revise_project.fn({ feedback: 'bigger' });
    assert.equal(r.ok, true);
    assert.equal(r.result.projectId, 'p2');
    assert.equal(forge._list._revised.feedback, 'bigger');
  });

  it('project_status returns latest when no id, honest miss when none', () => {
    const forge = stubForge();
    let t = toolMap(forge);
    assert.equal(t.project_status.fn({}).ok, false);
    forge.createProject('a', 'app');
    t = toolMap(forge);
    const r = t.project_status.fn({});
    assert.equal(r.ok, true);
    assert.equal(r.result.id, 'p1');
  });
});
