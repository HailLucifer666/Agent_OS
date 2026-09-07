'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildTools, registerFromDesktop } = require('../src/core/effectors/from-desktop');
test('desktop declarations can be inspected without runtime and refuse execution honestly', async () => {
  const declarations = buildTools();
  const names = buildTools({ controller: {} }).map((tool) => tool.name);
  assert.deepEqual(declarations.map((tool) => tool.name), names);
  assert.ok(names.includes('desktop_task_start'));
  for (const tool of declarations) {
    const result = await tool.fn({}, { connectionId: 'trusted' });
    assert.equal(result.ok, false);
    assert.equal(result.notExecuted, true);
  }
  const registered = [];
  assert.equal(registerFromDesktop({ register: (tool) => registered.push(tool) }, {}).count, declarations.length);
  assert.equal(registered.length, declarations.length);
});
test('desktop invocation takes connection ownership only from trusted dispatch context', async () => {
  let received;
  const tool = buildTools({ controller: { start: (args, ctx) => { received = { args, ctx }; return { ok: true }; } } })[0];
  await tool.fn({ request: 'open YouTube', connectionId: 'spoofed' }, { connectionId: 'trusted' });
  assert.equal(received.ctx.connectionId, 'trusted');
  assert.equal(received.args.request, 'open YouTube');
});
