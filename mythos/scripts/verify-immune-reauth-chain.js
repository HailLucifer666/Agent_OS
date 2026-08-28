#!/usr/bin/env node
'use strict';

/**
 * verify-immune-reauth-chain.js — BUG-278's live oracle.
 *
 * BUG-273 C2 put two controls on a terminal Gmail OAuth failure: `needsOperator`
 * ("this fault is human-only, do not guess a mechanical remedy") and a `reason`
 * carrying the whole operator instruction. BUG-278 found the controls INERT —
 * `immune/healer.js` dropped both fields one hop before `immune/explainer.js`,
 * the only module that reads them, so the operator heard "I do not yet know the
 * cause" for an anomaly that shipped a full sentence naming the fix.
 *
 * `test/bug-278-remedy-fit-must-survive-the-wire.test.js` wires the same four
 * production modules but emits a HAND-BUILT anomaly. That is deliberate and it is
 * what catches a field lost in transit. What it cannot do is exercise the SENSOR:
 * whether the real `gmail-sensor.js`, against a real dead grant, produces the
 * payload the chain needs. This script is that half, which is what "NOT
 * live-verified" meant on the ticket.
 *
 * IT REQUIRES A REAL TERMINAL AUTH FAULT and says so rather than passing when
 * there isn't one. A healthy grant means no anomaly, which is correct behaviour
 * and NOT evidence the fix works — reporting that as a pass is precisely the
 * "gate passed on a metric it cannot read" failure this repo keeps hitting. It
 * exits 2 (INCONCLUSIVE) in that case, distinct from 0 (PASS) and 1 (FAIL).
 *
 * Usage:  cd mythos && node scripts/verify-immune-reauth-chain.js
 * Check the grant first with:  node scripts/verify-google-grant.js
 */

const path = require('path');
const fs = require('fs');

const MYTHOS = path.join(__dirname, '..');
const R = (p) => require(path.join(MYTHOS, p));

// The app calls process.loadEnvFile(); a standalone script must too, or every
// provider reports "not configured" and this measures its own environment
// instead of the product. Getting this wrong made an earlier run of this same
// probe report 0 polls and 0 events, which reads exactly like a healthy system.
const ENV = path.join(MYTHOS, '.env');
if (fs.existsSync(ENV)) {
  try { process.loadEnvFile(ENV); } catch (_) { /* fall through to the report below */ }
}

const PASS = 0;
const FAIL = 1;
const INCONCLUSIVE = 2;

async function main() {
  const { createBus } = R('src/core/bus/index');
  const { createDiagnostician } = R('src/core/immune/diagnostician');
  const { createHealer } = R('src/core/immune/healer');
  const { createExplainer } = R('src/core/immune/explainer');
  const { createGmailSensor } = R('src/core/sensors/gmail-sensor.js');
  const gmailMod = R('src/core/effectors/from-gmail.js');

  const brainState = { asked: 0, prompt: null };
  const spoken = [];
  const logs = [];
  const healed = [];

  const bus = createBus({ logger: { info() {}, warn() {}, error() {} } });
  const origEmit = bus.emit.bind(bus);
  bus.emit = (type, payload) => {
    if (type === 'action.speak-requested') spoken.push(payload && payload.text);
    return origEmit(type, payload);
  };

  // An EAGER brain, matching the shipped test: it proposes a mechanical remedy
  // for anything. So "the brain was never asked" is the chain's restraint and
  // not the model's, which is the only way that assertion means something.
  const brain = {
    async think(req) {
      brainState.asked += 1;
      brainState.prompt = req.messages[0].content;
      return {
        parsed: { remedy: 'probe_provider' },
        content: '{"remedy":"probe_provider"}',
        offline: false,
      };
    },
  };

  const diag = createDiagnostician({ bus });
  const healer = createHealer({ bus, config: {}, memory: null });
  const explainer = createExplainer({
    bus,
    brain,
    config: {},
    memory: null,
    logger: { info: (msg, fields) => logs.push({ msg, fields }), warn: () => {} },
  });
  bus.subscribe('health.healed', (e) => healed.push(e.payload));
  diag.start();
  healer.start();
  explainer.start();

  // Bind the REAL effector through the real registrar rather than reaching for a
  // seam — the point of this script is that nothing between the grant and the
  // spoken sentence is a stub except the brain.
  const collected = [];
  gmailMod.registerFromGmail({ register: (e) => collected.push(e), bus });
  const eff = collected.find((e) => e && (e.name === 'gmail_unread' || e.id === 'gmail_unread'));
  const call = eff && (eff.invoke || eff.fn || eff.run);
  if (typeof call !== 'function') {
    console.log('verify-immune-reauth-chain: INCONCLUSIVE');
    console.log('  could not bind the real gmail_unread effector; collected: '
      + collected.map((e) => (e && (e.name || e.id)) || '?').join(', '));
    return INCONCLUSIVE;
  }
  const gmailUnread = (args) => call.call(eff, args || {});

  const direct = await gmailUnread({ max: 1 });
  const err = String((direct && direct.result && direct.result.error) || (direct && direct.result) || '');
  if (direct && direct.ok) {
    console.log('verify-immune-reauth-chain: INCONCLUSIVE');
    console.log('  The Google grant is HEALTHY, so no terminal auth anomaly can fire.');
    console.log('  That is correct behaviour and is NOT evidence the BUG-278 fix works.');
    console.log('  Re-run when a grant is genuinely expired, or see the unit test for');
    console.log('  the hand-built-payload half: test/bug-278-remedy-fit-must-survive-the-wire.test.js');
    return INCONCLUSIVE;
  }
  if (!/invalid_grant|expired or revoked/i.test(err)) {
    console.log('verify-immune-reauth-chain: INCONCLUSIVE');
    console.log('  gmail_unread failed, but not with a TERMINAL auth error, so C2 does');
    console.log('  not apply and no anomaly is expected. Reported: ' + err.slice(0, 160));
    return INCONCLUSIVE;
  }

  const sensor = createGmailSensor({ bus, gmailUnread, pollMs: 2000 });
  await sensor.start();
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    if (healed.length) break;
  }
  await new Promise((r) => setTimeout(r, 800));
  try { await sensor.stop(); } catch (_) { /* best effort */ }

  const entry = healed[healed.length - 1] || {};
  const explain = (logs.filter((l) => l.msg === 'immune-explain').pop() || { fields: {} }).fields;
  const saysUnknown = spoken.some((s) => /do not yet know the cause/i.test(String(s)));

  const checks = [
    ['a terminal auth fault reached the chain', healed.length > 0],
    ['needsOperator survived the healer', entry.needsOperator === true],
    ['reason survived the healer', Boolean(entry.reason)],
    ['the brain was NOT asked for a remedy', brainState.asked === 0],
    ['the spoken line names the cause', !saysUnknown],
  ];

  const failed = checks.filter(([, ok]) => !ok);
  console.log('verify-immune-reauth-chain: ' + (failed.length ? 'FAIL' : 'PASS'));
  console.log('  real gmail_unread: ok=' + (direct && direct.ok) + ', ' + err.slice(0, 90));
  console.log('  polls=' + sensor.getPollCount() + '  health.healed=' + healed.length
    + '  brain calls=' + brainState.asked + '  remedy=' + JSON.stringify(explain.remedy));
  for (const [label, ok] of checks) console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label);
  if (spoken.length) console.log('  spoken: "' + String(spoken[spoken.length - 1]).slice(0, 200) + '"');
  if (failed.length) {
    console.log('\n  BUG-278 regressed: the healer forwards health.healed without the fields');
    console.log('  immune/explainer.js keys on. See BUGS.md BUG-278.');
  }
  return failed.length ? FAIL : PASS;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.log('verify-immune-reauth-chain: INCONCLUSIVE');
  console.log('  threw: ' + String((e && e.message) || e).slice(0, 240));
  process.exit(INCONCLUSIVE);
});
