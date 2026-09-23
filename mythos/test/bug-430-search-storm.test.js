'use strict';
// Sept 9's reformulations shared no normalized string: count searches, not similarity.
// Mutations 2026-09-10: remove caution (1 fail), omit expiry (1), double-count
// ACK/result (1). Restored by absolute-path byte copy with matching SHA256.
const { it, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createRecentActionLedger } = require('../src/core/voice/action-evidence-ledger');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
it('four searches trigger, a read or window expiry clears; three topics do not trigger', () => {
  let now = 1000; mock.method(Date, 'now', () => now);
  try {
    const ledger = createRecentActionLedger();
    for (let n = 0; n < 3; n++) ledger.record({ tool: 'web_search', ok: true });
    assert.equal(ledger.searchStormDetected(), false);
    ledger.record({ tool: 'web_search', ok: false });
    assert.equal(ledger.searchStormDetected(), true);
    now += 120001;
    assert.equal(ledger.searchStormDetected(), false);
    for (let n = 0; n < 4; n++) {
      ledger.record({ tool: 'web_search', ok: true });
      if (n === 1) ledger.record({ tool: 'web_fetch', ok: true });
    }
    assert.equal(ledger.searchStormDetected(), false);
  } finally { mock.restoreAll(); }
});
it('fourth function response carries caution; kill switch preserves previous response', async () => {
  for (const disabled of [false, true]) {
    const previous = process.env.LIVE_SEARCH_STORM_GUARD_ENABLED;
    process.env.LIVE_SEARCH_STORM_GUARD_ENABLED = disabled ? 'false' : 'true';
    try {
      const adapter = createLiveToolAdapter({ leash: { check: () => ({ allow: true }) },
        dispatchAction: async () => ({ ok: true, result: { content: 'search result' } }),
        summarizeActionsForResult: () => '', connectionId: 'storm-test' });
      const responses = [];
      for (let n = 0; n < 4; n++) await adapter.handleLiveToolCalls([{ id: String(n), name: 'web_search', args: { query: 'topic-' + n } }], { sendToolResponse: rows => responses.push(...rows) });
      assert.equal(/four searches in two minutes/.test(responses[2].response.message || ''), false);
      assert.equal(/four searches in two minutes/.test(responses[3].response.message || ''), !disabled);
      assert.equal(responses[3].response.status, 'ok');
    } finally { if (previous === undefined) delete process.env.LIVE_SEARCH_STORM_GUARD_ENABLED; else process.env.LIVE_SEARCH_STORM_GUARD_ENABLED = previous; }
  }
});
it('two slow searches with ACK plus outcome each are still only two searches', () => {
  const ledger = createRecentActionLedger();
  for (const traceId of ['one', 'two']) {
    ledger.record({ tool: 'web_search', traceId, ok: null, started: true });
    ledger.record({ tool: 'web_search', traceId, ok: true });
  }
  assert.equal(ledger.searchStormDetected(), false);
});
