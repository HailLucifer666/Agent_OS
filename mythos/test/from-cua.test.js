'use strict';

// test/from-cua.test.js — covers the from-cua effector registration + the
// OFFLINE-HONESTY contract. Each cua_* tool must return a clear { ok:false }
// with the adapter's hint when cua-driver is not ONLINE, instead of
// fabricating success. The test never starts the real binary — it asserts the
// offline behavior that matters: the brain gets a truthful signal it can
// fall back from, never a silent no-op. Mirrors the adapter test's style.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('effectors/from-cua — registration', function() {
  it('registerFromCua registers exactly four cua_* tools', function() {
    var registered = [];
    var fakeHub = {
      register: function(tool) { registered.push(tool); }
    };
    var fromCua = require('../src/core/effectors/from-cua');
    var out = fromCua.registerFromCua(fakeHub);
    assert.equal(out.count, 4);
    assert.equal(registered.length, 4);
    // effectorFromTool wraps the tool into the canonical Effector shape whose
    // identifier field is .id (adapter.js:12), so assert against that.
    var ids = registered.map(function(t) { return t.id; }).sort();
    assert.deepEqual(ids, ['cua_bring_to_front', 'cua_click', 'cua_get_window_state', 'cua_list_windows']);
  });

  it('cua_click is marked danger:true (state-changing)', function() {
    var fromCua = require('../src/core/effectors/from-cua');
    var click = fromCua.TOOLS.filter(function(t) { return t.name === 'cua_click'; })[0];
    assert.equal(click.danger, true);
  });
});

describe('effectors/from-cua — OFFLINE HONESTY', function() {
  // Without startCuaDriver(), the adapter is OFFLINE by default (the
  // side-effect-free require guarantee covered in cua-driver-adapter.test.js).
  // Every cua_* tool must surface that as ok:false with a string hint, never
  // ok:true — that is the exact "reported success it didn't earn" bug this
  // module was written to prevent.

  it('cua_list_windows returns ok:false with a hint while offline', async function() {
    var fromCua = require('../src/core/effectors/from-cua');
    var list = fromCua.TOOLS.filter(function(t) { return t.name === 'cua_list_windows'; })[0];
    var r = await list.fn({});
    assert.equal(r.ok, false);
    assert.equal(typeof r.result, 'string');
    assert.ok(r.result.indexOf('cua-driver') !== -1, 'hint should reference cua-driver');
  });

  it('cua_bring_to_front returns ok:false with a hint while offline', async function() {
    var fromCua = require('../src/core/effectors/from-cua');
    var front = fromCua.TOOLS.filter(function(t) { return t.name === 'cua_bring_to_front'; })[0];
    var r = await front.fn({ pid: 1234 });
    assert.equal(r.ok, false);
    assert.equal(typeof r.result, 'string');
  });

  it('cua_get_window_state returns ok:false with a hint while offline', async function() {
    var fromCua = require('../src/core/effectors/from-cua');
    var state = fromCua.TOOLS.filter(function(t) { return t.name === 'cua_get_window_state'; })[0];
    var r = await state.fn({ pid: 1234 });
    assert.equal(r.ok, false);
    assert.equal(typeof r.result, 'string');
  });

  it('cua_click returns ok:false with a hint while offline', async function() {
    var fromCua = require('../src/core/effectors/from-cua');
    var click = fromCua.TOOLS.filter(function(t) { return t.name === 'cua_click'; })[0];
    var r = await click.fn({ element_index: 0, pid: 1234 });
    assert.equal(r.ok, false);
    assert.equal(typeof r.result, 'string');
  });
});
