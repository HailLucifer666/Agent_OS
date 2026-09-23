'use strict';

// BUG-275 register truth: only the current Status paragraph is authoritative.
// Historical closed/open discussions must not become contradictions.
// Probe 2026-09-10: removing assertConsistentStatus makes the contradictory
// fixture pass and this test fail; restored by absolute copy + SHA256.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { buildRegister } = require('../scripts/build-index');
function fixture(status, detail = '') {
  return '## BUG-275 — example\n\n**Status:** ' + status + '\n\n' + detail
    + '\n## OPEN WORK filed 2026-09-10\n\n- BUG-275 - remaining work\n';
}
it('refuses the same H-item as both closed and open, across wrapped lines', () => {
  assert.throws(() => buildRegister({ bugsText: fixture('H2, H3 and H4 are closed;\nH1 and H2 remain genuinely open.') }), /BUG-275.*H2.*closed.*open/);
});
it('allows separate dispositions and historical prose', () => {
  assert.doesNotThrow(() => buildRegister({ bugsText: fixture('H2, H3 and H4 are closed; H1 remains open.', 'H2 was open.') }));
});
it('the real register contains no contradictory Status paragraph', () => {
  assert.doesNotThrow(() => buildRegister());
  assert.ok(buildRegister().openDeclared.includes(432), 'new notice timing ticket remains explicitly open');
});
