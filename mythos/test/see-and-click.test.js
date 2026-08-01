'use strict';

// test/see-and-click.test.js — 2026-08-02.
//
// ui_click needs an elementPath into a UIA tree. WhatsApp Desktop's tree enumerates
// to ZERO children, so no valid path exists to pass and the model invented them —
// "Element path index 2 out of range (parent has 0 children)" in
// vault/Episodic/2026-08-02.jsonl, which is what stopped MYTHOS selecting a chat.
//
// see_and_click sidesteps the tree entirely: OCR reports where rendered text is, in
// the same screen-absolute pixel space click_at consumes. These cover the matcher
// (pure) and the effector's decision-making against a stubbed pc-child, including
// the two behaviours that matter most — refusing an ambiguous target, and refusing
// to claim success when the screen did not change.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const PC_CHILD_PATH = require.resolve('../adapters/pc-child');

// Stub pc-child before from-pc.js requires it (it uses a direct require, not ctx
// injection). Each case declares the command responses it wants and the calls it
// made are recorded for assertion.
function withStubbedChild(script, run) {
  const calls = [];
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    const resolved = (() => { try { return require.resolve(request, { paths: [parent.path] }); } catch { return null; } })();
    if (resolved === PC_CHILD_PATH) {
      return {
        getStatus: () => ({ state: 'ONLINE' }),
        sendCommand: async (cmd) => {
          calls.push(cmd);
          const reply = script(cmd, calls.length);
          if (reply === undefined) return { ok: true, result: {} };
          return reply;
        },
      };
    }
    return original.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve('../src/core/effectors/from-pc')];
    const fromPc = require('../src/core/effectors/from-pc');
    return run(fromPc, calls);
  } finally {
    Module._load = original;
    delete require.cache[require.resolve('../src/core/effectors/from-pc')];
  }
}

// A believable WhatsApp search-results screen.
const WHATSAPP = [
  { text: 'Search or start a new chat', x: 40, y: 90, width: 300, height: 22 },
  { text: 'Mousumi', x: 60, y: 180, width: 120, height: 26 },
  { text: 'Alex', x: 60, y: 240, width: 60, height: 26 },
];
const asOcr = (regions) => ({
  ok: true,
  result: { text: regions.map((r) => r.text).join('\n'), lineCount: regions.length, regions },
});

describe('matchRegions — pure matcher', () => {
  const { matchRegions } = require('../src/core/effectors/from-pc')._seeAndClickInternal;

  test('an exact label beats a coincidental substring', () => {
    const regions = [{ text: 'Mou', x: 0, y: 0, width: 20, height: 10 }].concat(WHATSAPP);
    assert.deepEqual(matchRegions(regions, 'Mousumi').map((r) => r.text), ['Mousumi']);
  });

  test('matching is case-insensitive', () => {
    assert.deepEqual(matchRegions(WHATSAPP, 'mOuSuMi').map((r) => r.text), ['Mousumi']);
  });

  test('falls back to substring when nothing matches exactly', () => {
    assert.deepEqual(matchRegions(WHATSAPP, 'start a new').map((r) => r.text),
      ['Search or start a new chat']);
  });

  test('a zero-area box is never a click target', () => {
    assert.equal(matchRegions([{ text: 'Ghost', x: 5, y: 5, width: 0, height: 0 }], 'Ghost').length, 0);
  });

  test('empty query matches nothing rather than everything', () => {
    assert.equal(matchRegions(WHATSAPP, '   ').length, 0);
  });
});

describe('see_and_click', () => {
  test('clicks the centre of the matched label', async () => {
    await withStubbedChild((cmd) => {
      if (cmd.cmd === 'screen_read_text') return asOcr(WHATSAPP);
      if (cmd.cmd === 'click_at') return { ok: true, result: { clicked: true } };
    }, async (fromPc, calls) => {
      const res = await fromPc.see_and_click({ text: 'Mousumi' });
      const click = calls.find((c) => c.cmd === 'click_at');
      assert.ok(click, 'no click was issued');
      assert.equal(click.x, 120);  // 60 + 120/2
      assert.equal(click.y, 193);  // 180 + 26/2
      assert.equal(res.ok, true);
    });
  });

  test('REFUSES an ambiguous label instead of picking one', async () => {
    const twice = WHATSAPP.concat([{ text: 'Mousumi', x: 400, y: 500, width: 120, height: 26 }]);
    await withStubbedChild((cmd) => {
      if (cmd.cmd === 'screen_read_text') return asOcr(twice);
      if (cmd.cmd === 'click_at') return { ok: true, result: {} };
    }, async (fromPc, calls) => {
      const res = await fromPc.see_and_click({ text: 'Mousumi' });
      assert.equal(res.ok, false);
      assert.match(String(res.result), /matches 2 things/i);
      assert.equal(calls.filter((c) => c.cmd === 'click_at').length, 0,
        'it clicked despite the target being ambiguous');
    });
  });

  test('occurrence picks between duplicates', async () => {
    const twice = WHATSAPP.concat([{ text: 'Mousumi', x: 400, y: 500, width: 120, height: 26 }]);
    await withStubbedChild((cmd) => {
      if (cmd.cmd === 'screen_read_text') return asOcr(twice);
      if (cmd.cmd === 'click_at') return { ok: true, result: {} };
    }, async (fromPc, calls) => {
      await fromPc.see_and_click({ text: 'Mousumi', occurrence: 2 });
      const click = calls.find((c) => c.cmd === 'click_at');
      assert.equal(click.x, 460);
      assert.equal(click.y, 513);
    });
  });

  test('a label that is not on screen fails honestly and says what it DID see', async () => {
    await withStubbedChild((cmd) => {
      if (cmd.cmd === 'screen_read_text') return asOcr(WHATSAPP);
    }, async (fromPc, calls) => {
      const res = await fromPc.see_and_click({ text: 'Priya' });
      assert.equal(res.ok, false);
      assert.match(String(res.result), /cannot see "Priya"/i);
      assert.match(String(res.result), /Mousumi/, 'the failure must name what was actually readable');
      assert.equal(calls.filter((c) => c.cmd === 'click_at').length, 0);
    });
  });

  test('an empty OCR result says so, rather than blaming the label', async () => {
    await withStubbedChild((cmd) => {
      if (cmd.cmd === 'screen_read_text') return asOcr([]);
    }, async (fromPc) => {
      const res = await fromPc.see_and_click({ text: 'Mousumi' });
      assert.equal(res.ok, false);
      assert.match(String(res.result), /no text regions at all/i);
    });
  });

  test('an unchanged screen after the click is UNVERIFIED, not success', async () => {
    await withStubbedChild((cmd) => {
      if (cmd.cmd === 'screen_read_text') return asOcr(WHATSAPP); // identical before and after
      if (cmd.cmd === 'click_at') return { ok: true, result: {} };
    }, async (fromPc) => {
      const res = await fromPc.see_and_click({ text: 'Mousumi' });
      assert.equal(res.ok, true, 'unverified is not a failure — the click may well have landed');
      assert.equal(res.unverified, true, 'an unchanged screen must not be reported as confirmed');
      assert.match(String(res.reason), /reads exactly the same/i);
    });
  });

  test('a changed screen counts as evidence', async () => {
    let seen = 0;
    await withStubbedChild((cmd) => {
      if (cmd.cmd === 'screen_read_text') {
        seen += 1;
        return seen === 1 ? asOcr(WHATSAPP)
          : asOcr([{ text: 'Mousumi', x: 300, y: 20, width: 120, height: 26 },
                   { text: 'Type a message', x: 300, y: 700, width: 200, height: 24 }]);
      }
      if (cmd.cmd === 'click_at') return { ok: true, result: {} };
    }, async (fromPc) => {
      const res = await fromPc.see_and_click({ text: 'Mousumi' });
      assert.equal(res.ok, true);
      assert.ok(!res.unverified);
      assert.equal(res.result.evidence, 'ocr');
    });
  });

  test('expect: named post-state is confirmed explicitly', async () => {
    let seen = 0;
    await withStubbedChild((cmd) => {
      if (cmd.cmd === 'screen_read_text') {
        seen += 1;
        return seen === 1 ? asOcr(WHATSAPP)
          : asOcr([{ text: 'Type a message to Mousumi', x: 300, y: 700, width: 260, height: 24 }]);
      }
      if (cmd.cmd === 'click_at') return { ok: true, result: {} };
    }, async (fromPc) => {
      const res = await fromPc.see_and_click({ text: 'Mousumi', expect: 'Type a message to Mousumi' });
      assert.equal(res.ok, true);
      assert.equal(res.result.confirmed, 'Type a message to Mousumi');
      assert.equal(res.result.evidence, 'ocr');
    });
  });

  test('a failed click is a failure, not an unverified success', async () => {
    await withStubbedChild((cmd) => {
      if (cmd.cmd === 'screen_read_text') return asOcr(WHATSAPP);
      if (cmd.cmd === 'click_at') return { ok: false, error: 'SendInput injected 0 events' };
    }, async (fromPc) => {
      const res = await fromPc.see_and_click({ text: 'Mousumi' });
      assert.equal(res.ok, false);
      assert.match(String(res.result), /click failed/i);
    });
  });

  test('a missing text argument is refused before anything is read', async () => {
    await withStubbedChild(() => ({ ok: true, result: {} }), async (fromPc, calls) => {
      const res = await fromPc.see_and_click({});
      assert.equal(res.ok, false);
      assert.equal(calls.length, 0);
    });
  });
});
