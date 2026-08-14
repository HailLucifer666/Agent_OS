'use strict';

// F4 (2026-08-15) — camera_look was confidently wrong and nothing could catch it.
//
// Two incidents in the 2026-08-14 session: "reported seeing a mouse with a bright
// green light" (there was no such thing) and "correctly identified the colour
// context, but misidentified the object". The lane was NOT at fault — 9 calls,
// 1 honest fail (camera off), 8 ok, every vision.call healthy at 1.5-2.2s. The
// model was wrong, and a webcam frame has no oracle: screen_look can be
// cross-checked against OCR of the same screenshot, a room cannot.
//
// A provenance note already shipped in the result and did not help, because
// advisory prose loses to a confident model. What is asserted here is the
// behavioural change: the model scores itself, and the score changes what the
// code DOES — a second frame on low confidence, and a spoken-form instruction
// that survives into the sentence rather than sitting in metadata.
//
// Cost is the constraint that shapes the design, so it is tested too: the common
// (high-confidence) path must still be exactly one vision call.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildTools } = require('../src/core/effectors/from-dashboard');

// Each call returns the next scripted reply, so a second look is observable.
function harness(replies, opts) {
  const o = opts || {};
  const calls = [];
  let frames = 0;
  const built = buildTools({
    config: { CAMERA_SECOND_LOOK_DELAY_MS: 0 },
    fs: null,
    brain: {
      think: async (req) => {
        calls.push(req);
        const next = replies[Math.min(calls.length - 1, replies.length - 1)];
        return typeof next === 'string' ? { content: next, provider: 't', model: 'm' } : next;
      },
    },
    visionChainFor: async () => [{ provider: 't', model: 'm' }],
  });
  built.setCameraFrameProvider(async () => {
    frames++;
    if (o.secondFrameMissing && frames > 1) return null;
    return 'ZmFrZS1qcGVn';
  });
  return { tool: built.TOOLS.find((t) => t.name === 'camera_look'), calls, frames: () => frames };
}

describe('F4 — camera_look asks the model how sure it is', () => {
  it('the prompt asks for an explicit confidence line', async () => {
    const h = harness(['a tidy desk\nCONFIDENCE: HIGH']);
    await h.tool.fn({ query: 'what is on the desk?' });
    const text = JSON.stringify(h.calls[0]);
    assert.match(text, /CONFIDENCE/, 'the model cannot report a confidence it was never asked for');
    assert.match(text, /what is on the desk\?/, 'and the operator\'s actual question must survive');
  });

  it('the confidence marker is stripped out of what gets spoken', async () => {
    const h = harness(['a tidy desk\nCONFIDENCE: HIGH']);
    const res = await h.tool.fn({});
    assert.equal(res.ok, true);
    assert.equal(res.result.description, 'a tidy desk',
      'the operator must not hear the scoring scaffolding read back to them');
  });
});

describe('F4 — high confidence costs nothing extra', () => {
  it('takes exactly one vision call and one frame', async () => {
    const h = harness(['a tidy desk\nCONFIDENCE: HIGH']);
    const res = await h.tool.fn({});
    assert.equal(h.calls.length, 1, 'the common path must not double latency');
    assert.equal(h.frames(), 1);
    assert.equal(res.result.selfReported, 'high');
    assert.ok(!res.result.secondLook, 'no second reading on the high-confidence path');
  });

  it('an unstated confidence also takes one call, but is not reported as high', async () => {
    // A model that ignores the instruction must not silently double the cost of
    // every camera_look — but it must not be credited with confidence either.
    const h = harness(['a tidy desk']);
    const res = await h.tool.fn({});
    assert.equal(h.calls.length, 1);
    assert.equal(res.result.selfReported, 'unstated');
  });
});

describe('F4 — low confidence takes a second look and refuses to merge the two', () => {
  it('makes a second call against a second frame', async () => {
    const h = harness([
      'a mouse with a bright green light\nCONFIDENCE: LOW',
      'a dark object, possibly a mouse\nCONFIDENCE: LOW',
    ]);
    const res = await h.tool.fn({});
    assert.equal(h.calls.length, 2, 'low confidence is what earns the extra call');
    assert.equal(h.frames(), 2, 'and it must be a NEW frame — re-reading the same one proves nothing');
    assert.equal(res.result.description, 'a mouse with a bright green light');
    assert.equal(res.result.secondLook, 'a dark object, possibly a mouse');
  });

  it('the result instructs the SPOKEN answer, not just the metadata', () => {
    // rules/core.md §11.3 — the existing note failed precisely because it read as
    // metadata. truncateForModel JSON-stringifies the whole result, so the field
    // does reach the model; what it says is what decides whether it changes the
    // sentence.
    return harness([
      'a green mouse\nCONFIDENCE: LOW', 'something dark\nCONFIDENCE: LOW',
    ]).tool.fn({}).then((res) => {
      assert.match(res.result.note, /both agree/i, 'must tell the model to assert only the overlap');
      assert.match(res.result.note, /could not tell/i, 'and to name the disagreement as uncertainty');
      assert.match(res.result.note, /Do not merge/i,
        'merging two low-confidence readings into one confident description is the failure mode');
    });
  });

  it('a failed second look degrades to one hedged reading, not to a tool failure', async () => {
    const h = harness(['a green mouse\nCONFIDENCE: LOW'], { secondFrameMissing: true });
    const res = await h.tool.fn({});
    assert.equal(res.ok, true, 'the operator asked a question; one uncertain answer beats none');
    assert.equal(res.result.selfReported, 'low');
    assert.match(res.result.note, /not sure/i, 'and it must still say it is unsure');
    assert.ok(!res.result.secondLook);
  });
});

describe('F4 — the provenance that already existed is not lost', () => {
  it('every successful path still carries the single-frame provenance note', async () => {
    for (const replies of [
      ['a desk\nCONFIDENCE: HIGH'],
      ['a desk'],
      ['a desk\nCONFIDENCE: LOW', 'a desk\nCONFIDENCE: LOW'],
    ]) {
      const res = await harness(replies).tool.fn({});
      assert.equal(res.ok, true);
      assert.match(res.result.note, /cannot be\s+verified|look again|not sure/i,
        'the pre-existing provenance must survive on every path: ' + JSON.stringify(replies));
      assert.equal(res.result.confidence, 'unverified-vision',
        'the machine-readable confidence field is unchanged — downstream reads it');
    }
  });

  it('a vision failure still fails honestly rather than describing anything', async () => {
    const h = harness([{ offline: true }]);
    const res = await h.tool.fn({});
    assert.equal(res.ok, false);
    assert.match(String(res.result), /offline/i);
  });
});
