'use strict';

// anomaly-detail-round-trip.test.js — B2 of the 2026-08-14 session repair.
//
// THE BUG. server/index.js's health.anomaly subscriber wrote a fixed four-field
// detail ({kind, scope, error, target}) and dropped everything else the emitter
// had attached. Wave 0 (2026-08-13) had deliberately attached audioIn, scFields,
// turnId and reason to live-turn-no-user-transcript so that "one anomaly record
// is a complete diagnosis instead of a bare kind". What reached disk on
// 2026-08-14 was:
//
//   {"kind":"anomaly","summary":"anomaly: live-turn-no-user-transcript — ",
//    "detail":{"kind":"live-turn-no-user-transcript","playbookId":null,"outcome":"no-match"}}
//
// The instrumentation was built, emitted, and thrown away. Diagnosing the mic
// gate (BUG-229) then required correlating a server log line-by-line by
// proximity, because the join key (turnId) and the discriminator (audioIn) both
// existed in memory and never reached the vault.
//
// This is the same defect CLASS as Wave A's derived-constant lesson: a producer
// and a consumer that must agree about a set of fields, with nothing asserting
// that they do. So the last suite below is a CONFORMANCE test — it reads the real
// emitters out of src/ and fails when a named diagnostic field would be dropped,
// rather than restating today's list twice.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ANOMALY_DETAIL_FIELDS, FIELD_MAX_CHARS, ARRAY_MAX,
  anomalyDetail, anomalySummaryDetail,
} = require('../src/core/immune/anomaly-detail');

describe('B2 the fields Wave 0 attached now survive to the record', () => {
  it('the exact live-turn-no-user-transcript payload keeps every diagnostic field', () => {
    // Verbatim from live-session.js's emit.
    const payload = {
      kind: 'live-turn-no-user-transcript',
      turnId: 44,
      reason: "the reply was transcribed but the operator's speech was not",
      audioIn: 69,
      scFields: ['generationComplete', 'modelTurn', 'outputTranscription', 'turnComplete', 'interrupted'],
    };
    const detail = anomalyDetail(payload, 'evt-abc');

    assert.equal(detail.kind, 'live-turn-no-user-transcript');
    assert.equal(detail.turnId, 44, 'turnId is the JOIN KEY — without it a record cannot be tied to a turn');
    assert.equal(detail.audioIn, 69,
      'audioIn is the DISCRIMINATOR: 6-11 frames means the mic gate ate the speech, 116-584 means it did not. '
      + 'Wave A could only recover this by reading a server log by proximity.');
    assert.deepEqual(detail.scFields, payload.scFields);
    assert.match(detail.reason, /operator's speech was not/,
      'reason is load-bearing for the SPOKEN explanation (anomaly-payloads-need-reason), and was dropped');
  });

  it('a reason-only payload no longer stores a summary ending in a bare dash', () => {
    const summary = 'anomaly: live-turn-no-user-transcript — '
      + anomalySummaryDetail({ kind: 'live-turn-no-user-transcript', reason: 'the operator was not transcribed' });
    assert.match(summary, /the operator was not transcribed$/);
    assert.doesNotMatch(summary, /— $/,
      'the stored summary was literally "anomaly: live-turn-no-user-transcript — " with nothing after it');
  });

  it('error still wins the summary over reason, so nothing regresses for the 53 error emitters', () => {
    assert.equal(anomalySummaryDetail({ error: 'ENOENT', reason: 'a softer restatement' }), 'ENOENT');
    assert.equal(anomalySummaryDetail({ target: 'nim' }), 'nim');
    assert.equal(anomalySummaryDetail({ tool: 'ui_type' }), 'ui_type');
    assert.equal(anomalySummaryDetail({}), '', 'and an empty payload must not throw');
  });
});

describe('B2 the allowlist is an allowlist, not a blanket copy', () => {
  it('a field not on the list is dropped', () => {
    // The privacy property. Anomaly payloads can carry operator content and this
    // is a permanent on-disk record, so a new field is a deliberate decision
    // about what MYTHOS keeps forever — never an accident of Object.assign.
    const detail = anomalyDetail({ kind: 'x', transcriptFragment: 'my bank password is hunter2', args: { a: 1 } });
    assert.equal(detail.transcriptFragment, undefined);
    assert.equal(detail.args, undefined);
    assert.equal(detail.kind, 'x');
  });

  it('the original four fields are still all present, in the list', () => {
    for (const field of ['kind', 'scope', 'error', 'target']) {
      assert.ok(ANOMALY_DETAIL_FIELDS.includes(field),
        'removing ' + field + ' would silently truncate every record written before today');
    }
  });

  it('an absent field is omitted, not stored as undefined', () => {
    const detail = anomalyDetail({ kind: 'x' });
    assert.deepEqual(Object.keys(detail).sort(), ['kind']);
  });
});

describe('B2 the record is bounded — one fat payload cannot bloat a vault line', () => {
  it('a long string is clipped', () => {
    const detail = anomalyDetail({ kind: 'x', error: 'e'.repeat(5000) });
    assert.equal(detail.error.length, FIELD_MAX_CHARS);
  });

  it('a long array is capped and its elements clipped', () => {
    const detail = anomalyDetail({ kind: 'x', scFields: new Array(500).fill('f'.repeat(2000)) });
    assert.equal(detail.scFields.length, ARRAY_MAX);
    assert.equal(detail.scFields[0].length, FIELD_MAX_CHARS);
  });

  it('a big object is serialized and clipped rather than stored whole', () => {
    const detail = anomalyDetail({ kind: 'x', evidence: { blob: 'b'.repeat(5000) } });
    assert.equal(typeof detail.evidence, 'string');
    assert.ok(detail.evidence.length <= FIELD_MAX_CHARS);
  });

  it('a small object passes through intact, because evidence is how several emitters report', () => {
    // probes.js: { kind:'provider-down', target:id, evidence: registryStatus[id] }
    const detail = anomalyDetail({ kind: 'provider-down', target: 'nim', evidence: { state: 'down', ms: 4002 } });
    assert.deepEqual(detail.evidence, { state: 'down', ms: 4002 });
  });

  it('a circular payload cannot throw — the write is wrapped, but a throw would still lose the record', () => {
    const circular = { kind: 'x' };
    circular.evidence = circular;
    let detail;
    assert.doesNotThrow(() => { detail = anomalyDetail(circular, 'evt-1'); });
    assert.equal(detail.evidence, '[unserializable]');
  });

  it('null and undefined payloads are handled', () => {
    assert.deepEqual(anomalyDetail(null), {});
    assert.deepEqual(anomalyDetail(undefined), {});
  });
});

describe('B2 the anomaly and its healer verdict share a join key', () => {
  it('eventId is stored when the bus supplies one, and omitted when it does not', () => {
    assert.equal(anomalyDetail({ kind: 'x' }, 'evt-42').eventId, 'evt-42');
    assert.equal(anomalyDetail({ kind: 'x' }).eventId, undefined,
      'a null id must not be stored as a key that looks like a real one');
  });

  it('the diagnostician forwards the source event id, so the healer can carry it', () => {
    const { diagnose } = require('../src/core/immune/diagnostician');
    const d = diagnose({ kind: 'provider-down', target: 'nim' }, 'evt-77');
    assert.equal(d.sourceEventId, 'evt-77');
    // Every existing caller passes only the payload. That must keep working.
    assert.equal(diagnose({ kind: 'provider-down' }).sourceEventId, null);
  });

  it('the healer puts sourceEventId on health.healed', async () => {
    // Driven through the bus, the same way test/immune.test.js drives it — the
    // handler is deliberately not on the public surface and this does not add it.
    const { createHealer } = require('../src/core/immune/healer');
    const emitted = [];
    const handlers = {};
    const bus = {
      emit: (type, payload) => {
        emitted.push({ type, payload });
        (handlers[type] || []).forEach((h) => h({ type, payload }));
      },
      subscribe: (type, h) => {
        (handlers[type] = handlers[type] || []).push(h);
        return () => {};
      },
    };
    const healer = createHealer({
      bus, config: {}, memory: null,
      getCortex: () => null, getGoals: () => null,
    });
    healer.start();

    // An unmatched kind: the no-match path is exactly the one that produced the
    // 2x-inflated tallies (68 no-match against 6 applied), so it is the one that
    // must carry the key.
    bus.emit('health.diagnosed', { kind: 'not-a-real-anomaly-kind', target: null, sourceEventId: 'evt-99' });
    await new Promise((r) => setTimeout(r, 10));

    const healed = emitted.find((e) => e.type === 'health.healed');
    assert.ok(healed, 'the healer emits health.healed on EVERY outcome including no-match — that is the double write');
    assert.equal(healed.payload.outcome, 'no-match');
    assert.equal(healed.payload.sourceEventId, 'evt-99',
      'without a shared key, 238 stored "anomalies" on 2026-08-14 were really ~119 events counted twice');
    healer.stop();
  });

  it('the healed persister stores that key as eventId, matching the anomaly record', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    const from = server.indexOf("bus.subscribe('health.healed'");
    assert.ok(from !== -1, 'the healed subscriber must still exist');
    // Bounded at the NEXT subscriber rather than a character count — this block
    // carries long BUG-069/Wave-0 comments and a fixed window silently misses it.
    const end = server.indexOf('bus.subscribe(', from + 10);
    const sub = server.slice(from, end === -1 ? server.length : end);
    assert.match(sub, /eventId:\s*p\.sourceEventId/,
      'both records must land the key under the SAME name, or the pair still cannot be joined');
  });
});

describe('B2 conformance: no core emitter names a diagnostic field the persister drops', () => {
  // The point of this suite. Restating the field list would prove nothing; this
  // reads the REAL emitters and fails when one attaches a field from the
  // diagnostic set below and the allowlist has not been extended.
  //
  // The set is deliberately the fields whose ABSENCE cost a real diagnosis, not
  // every key anyone has ever attached — free-text keys (`claim`, `dropped`,
  // `queueMax`, `waitedMs`, …) are intentionally not persisted, and adding them
  // is a privacy decision, not a mechanical one. If a future emitter genuinely
  // needs one, add it to BOTH lists and say why in anomaly-detail.js.
  const DIAGNOSTIC_FIELDS = ['reason', 'turnId', 'audioIn', 'scFields', 'tool', 'evidence', 'provider'];

  function coreEmitterSources() {
    const roots = [path.join(__dirname, '..', 'src')];
    const files = [];
    while (roots.length) {
      const dir = roots.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { roots.push(full); continue; }
        if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
      }
    }
    return files;
  }

  it('every diagnostic field a src/ emitter attaches is on the allowlist', () => {
    const emitRe = /health\.anomaly'\s*,\s*\{[\s\S]{0,500}?\}\s*\)/g;
    const missing = [];
    for (const file of coreEmitterSources()) {
      const src = fs.readFileSync(file, 'utf8');
      let m;
      while ((m = emitRe.exec(src)) !== null) {
        for (const field of DIAGNOSTIC_FIELDS) {
          if (!new RegExp('\\b' + field + '\\s*:').test(m[0])) continue;
          if (ANOMALY_DETAIL_FIELDS.includes(field)) continue;
          missing.push(path.basename(file) + ' attaches ' + field);
        }
      }
    }
    assert.deepEqual(missing, [],
      'these emitters attach a diagnostic field that the persister would drop on the floor — the exact '
      + 'shape of B2. Add the field to ANOMALY_DETAIL_FIELDS in src/core/immune/anomaly-detail.js, with '
      + 'a note on why keeping it forever is acceptable.');
  });

  it('the sweep actually found emitters, so a broken regex cannot pass vacuously', () => {
    // BUG-221's lesson: an assertion that passes against the bug is worthless.
    const emitRe = /health\.anomaly'\s*,\s*\{[\s\S]{0,500}?\}\s*\)/g;
    let found = 0;
    for (const file of coreEmitterSources()) {
      const matches = fs.readFileSync(file, 'utf8').match(emitRe);
      if (matches) found += matches.length;
    }
    assert.ok(found > 80, 'expected to sweep the ~130 real emitters in src/, matched only ' + found);
  });

  it('the persister is wired to the module, not to a second inline copy', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    assert.match(server, /require\('\.\.\/src\/core\/immune\/anomaly-detail'\)/,
      'the whole point of extracting this was one definition; a re-inlined copy would drift');
    const sub = server.slice(server.indexOf("bus.subscribe('health.anomaly'"));
    const body = sub.slice(0, 1200);
    assert.match(body, /detail:\s*anomalyDetail\(/,
      'the subscriber must call it — the fixed four-field literal is the bug');
    assert.match(body, /anomalySummaryDetail\(/, 'and use the shared summary fallback chain');
  });
});
