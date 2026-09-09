'use strict';
// 2026-09-09 filing / 2026-09-10 replay. Mutation 2026-09-10: remove the
// exported fact discipline from the server greeting prompt -> red.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { baseDeps } = require('./pr3-wire-helpers.cjs');
const { GREETING_FACT_DISCIPLINE } = require('../src/core/conversation/briefing');
test('real greeting prompt limits assertions to supplied facts; rollback removes the added rule', async () => {
  for (const enabled of [true, false]) {
    const prompts = [];
    const server = createServer(baseDeps(createBus({ historySize: 30 }), {
      config: { LIVE_VOICE_HONESTY_ENABLED: enabled },
      brain: { think: async args => { prompts.push(args.messages[0].content); return { content: 'Good morning.' }; } },
    }));
    await server.ready;
    try {
      await server._internal.deliverBootGreeting();
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0].includes(GREETING_FACT_DISCIPLINE), enabled);
      assert.match(GREETING_FACT_DISCIPLINE, /only facts explicitly listed|Never invent/);
    } finally { await server.stop(); }
  }
});
