'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildTools } = require('../src/core/effectors/from-memory');

// ---------------------------------------------------------------------------
// remember tool
// ---------------------------------------------------------------------------
describe('from-memory: remember', () => {
  it('returns error when text is empty', async () => {
    const tools = buildTools({ semantic: { write: () => ({}) }, fs: {} });
    const remember = tools.find(t => t.name === 'remember');
    const result = await remember.fn({});
    assert.equal(result.ok, false);
    assert.ok(result.result.error.includes('text required'));
  });

  it('accepts fact as alias for text', async () => {
    let written = null;
    const mockSemantic = {
      write: (topic, facts, opts) => { written = { topic, facts, opts }; return { ref: 'ref-alias' }; }
    };
    const tools = buildTools({ semantic: mockSemantic, fs: {} });
    const remember = tools.find(t => t.name === 'remember');
    const result = await remember.fn({ fact: 'purple is the best color' });
    assert.equal(result.ok, true);
    assert.equal(result.result.remembered, 'purple is the best color');
    assert.equal(written.topic, 'user-facts');
  });

  it('accepts note as alias for text', async () => {
    let written = null;
    const mockSemantic = {
      write: (topic, facts, opts) => { written = { topic, facts, opts }; return { ref: 'ref-note' }; }
    };
    const tools = buildTools({ semantic: mockSemantic, fs: {} });
    const remember = tools.find(t => t.name === 'remember');
    const result = await remember.fn({ note: 'always use dark mode' });
    assert.equal(result.ok, true);
    assert.equal(result.result.remembered, 'always use dark mode');
    assert.equal(written.topic, 'user-facts');
  });

  it('writes to semantic memory and returns ok', async () => {
    let written = null;
    const mockSemantic = {
      write: (topic, facts, opts) => { written = { topic, facts, opts }; return { ref: 'ref-1' }; }
    };
    const tools = buildTools({ semantic: mockSemantic, fs: {} });
    const remember = tools.find(t => t.name === 'remember');
    const result = await remember.fn({ text: 'my favorite color is blue' });
    assert.equal(result.ok, true);
    assert.equal(result.result.remembered, 'my favorite color is blue');
    assert.equal(written.topic, 'user-facts');
    assert.deepEqual(written.opts.sources, ['voice-explicit']);
    assert.equal(written.opts.confidence, 0.9);
    assert.equal(written.opts.append, true);
  });

  it('truncates long text in result to 200 chars', async () => {
    const mockSemantic = {
      write: () => ({ ref: 'ref-long' })
    };
    const tools = buildTools({ semantic: mockSemantic, fs: {} });
    const remember = tools.find(t => t.name === 'remember');
    const longText = 'a'.repeat(300);
    const result = await remember.fn({ text: longText });
    assert.equal(result.ok, true);
    assert.equal(result.result.remembered.length, 200);
  });

  it('handles semantic store unavailable', async () => {
    const tools = buildTools({ fs: {} });
    const remember = tools.find(t => t.name === 'remember');
    const result = await remember.fn({ text: 'remember this fact' });
    assert.equal(result.ok, false);
    assert.ok(result.result.error.includes('unavailable'));
  });

  it('handles semantic store with no write function', async () => {
    const tools = buildTools({ semantic: {}, fs: {} });
    const remember = tools.find(t => t.name === 'remember');
    const result = await remember.fn({ text: 'remember this fact' });
    assert.equal(result.ok, false);
    assert.ok(result.result.error.includes('unavailable'));
  });

  it('handles semantic store returning degraded', async () => {
    const mockSemantic = {
      write: () => ({ degraded: true })
    };
    const tools = buildTools({ semantic: mockSemantic, fs: {} });
    const remember = tools.find(t => t.name === 'remember');
    const result = await remember.fn({ text: 'remember this fact' });
    assert.equal(result.ok, false);
    assert.ok(result.result.error.includes('degraded'));
  });

  it('handles semantic store throwing', async () => {
    const mockSemantic = {
      write: () => { throw new Error('disk full'); }
    };
    const tools = buildTools({ semantic: mockSemantic, fs: {} });
    const remember = tools.find(t => t.name === 'remember');
    const result = await remember.fn({ text: 'remember this fact' });
    assert.equal(result.ok, false);
    assert.ok(result.result.error.includes('disk full'));
  });

  it('trims whitespace from text', async () => {
    let written = null;
    const mockSemantic = {
      write: (topic, facts, opts) => { written = facts; return { ref: 'ref-trim' }; }
    };
    const tools = buildTools({ semantic: mockSemantic, fs: {} });
    const remember = tools.find(t => t.name === 'remember');
    const result = await remember.fn({ text: '  spaced out  ' });
    assert.equal(result.ok, true);
    assert.equal(result.result.remembered, 'spaced out');
    assert.equal(written[0], 'spaced out');
  });

  // BUG-022: preference detection and identity.learn() calling
  describe('BUG-022: preference shape detection and identity.learn() integration', () => {
    it('calls identity.learn() when text is preference-shaped (I like)', async () => {
      let learned = null;
      const mockSemantic = {
        write: () => ({ ref: 'ref-pref' })
      };
      const mockIdentity = {
        learn: async (args) => { learned = args; return { ref: 'learned-ref' }; }
      };
      const tools = buildTools({ semantic: mockSemantic, fs: {}, identity: mockIdentity });
      const remember = tools.find(t => t.name === 'remember');
      const result = await remember.fn({ text: 'I like concise answers' });
      assert.equal(result.ok, true);
      assert.ok(learned !== null, 'identity.learn() should have been called');
      assert.equal(learned.text, 'I like concise answers');
      assert.equal(learned.sourceEpId, 'remember-tool');
    });

    it('calls identity.learn() when text is preference-shaped (I prefer)', async () => {
      let learned = null;
      const mockIdentity = {
        learn: async (args) => { learned = args; return { ref: 'learned-ref' }; }
      };
      const tools = buildTools({ semantic: { write: () => ({ ref: 'ref' }) }, fs: {}, identity: mockIdentity });
      const remember = tools.find(t => t.name === 'remember');
      await remember.fn({ text: 'I prefer dark mode on computers' });
      assert.ok(learned !== null);
      assert.equal(learned.text, 'I prefer dark mode on computers');
    });

    it('calls identity.learn() when text is preference-shaped (always)', async () => {
      let learned = null;
      const mockIdentity = {
        learn: async (args) => { learned = args; return { ref: 'learned-ref' }; }
      };
      const tools = buildTools({ semantic: { write: () => ({ ref: 'ref' }) }, fs: {}, identity: mockIdentity });
      const remember = tools.find(t => t.name === 'remember');
      await remember.fn({ text: 'always use two-factor authentication' });
      assert.ok(learned !== null);
      assert.equal(learned.text, 'always use two-factor authentication');
    });

    it('calls identity.learn() when text is preference-shaped (never)', async () => {
      let learned = null;
      const mockIdentity = {
        learn: async (args) => { learned = args; return { ref: 'learned-ref' }; }
      };
      const tools = buildTools({ semantic: { write: () => ({ ref: 'ref' }) }, fs: {}, identity: mockIdentity });
      const remember = tools.find(t => t.name === 'remember');
      await remember.fn({ text: 'never store passwords in plain text' });
      assert.ok(learned !== null);
    });

    it('does NOT call identity.learn() for non-preference text', async () => {
      let learned = null;
      const mockIdentity = {
        learn: async (args) => { learned = args; return { ref: 'learned-ref' }; }
      };
      const tools = buildTools({ semantic: { write: () => ({ ref: 'ref' }) }, fs: {}, identity: mockIdentity });
      const remember = tools.find(t => t.name === 'remember');
      const result = await remember.fn({ text: 'the weather is sunny today' });
      assert.equal(result.ok, true);
      assert.equal(learned, null, 'identity.learn() should NOT have been called for non-preference text');
    });

    it('does NOT call identity.learn() for facts without preference keywords', async () => {
      let learned = null;
      const mockIdentity = {
        learn: async (args) => { learned = args; return { ref: 'learned-ref' }; }
      };
      const tools = buildTools({ semantic: { write: () => ({ ref: 'ref' }) }, fs: {}, identity: mockIdentity });
      const remember = tools.find(t => t.name === 'remember');
      await remember.fn({ text: 'my birthday is on January 15th' });
      assert.equal(learned, null);
    });

    it('gracefully handles identity.learn() errors without failing remember()', async () => {
      const mockIdentity = {
        learn: async () => { throw new Error('identity store unavailable'); }
      };
      const tools = buildTools({ semantic: { write: () => ({ ref: 'ref' }) }, fs: {}, identity: mockIdentity });
      const remember = tools.find(t => t.name === 'remember');
      const result = await remember.fn({ text: 'I prefer concise answers' });
      assert.equal(result.ok, true, 'remember() should succeed even if identity.learn() fails');
      assert.equal(result.result.remembered, 'I prefer concise answers');
    });

    it('handles missing identity gracefully (does not call learn)', async () => {
      const tools = buildTools({ semantic: { write: () => ({ ref: 'ref' }) }, fs: {} });
      const remember = tools.find(t => t.name === 'remember');
      const result = await remember.fn({ text: 'I like coffee' });
      assert.equal(result.ok, true, 'should succeed without identity');
      assert.equal(result.result.remembered, 'I like coffee');
    });

    it('case-insensitive preference detection (uppercase)', async () => {
      let learned = null;
      const mockIdentity = {
        learn: async (args) => { learned = args; return { ref: 'learned-ref' }; }
      };
      const tools = buildTools({ semantic: { write: () => ({ ref: 'ref' }) }, fs: {}, identity: mockIdentity });
      const remember = tools.find(t => t.name === 'remember');
      await remember.fn({ text: 'I PREFER VERBOSE OUTPUT' });
      assert.ok(learned !== null, 'Should detect preference in uppercase');
    });
  });

  // BUG-014: STT noise rejection tests
  describe('BUG-014: STT noise rejection', () => {
    // Test table: [input, shouldReject, description]
    const noiseTests = [
      // Pure noise fragments (should reject)
      ['the', true, 'single word "the"'],
      ['a', true, 'single article "a"'],
      ['uh', true, 'pure "uh"'],
      ['uh...', true, '"uh" with ellipsis'],
      ['um', true, 'pure "um"'],
      ['umm', true, '"umm" with double m'],
      ['hmm', true, 'pure "hmm"'],
      ['hmmm...', true, '"hmm" extended with punctuation'],
      ['that you like', true, 'common STT fragment "that you like"'],
      ['that you like.', true, '"that you like" with period'],
      ['that you like,', true, '"that you like" with comma'],
      ['uh..', true, 'incomplete "uh" fragment'],
      // Too short (< 10 chars) without meaningful content
      ['call', true, 'single 4-letter word'],
      ['x', true, 'single character'],
      ['no math', true, '7 chars without 3+ letter sequence'],
      // Valid short facts (10+ chars)
      ['spaced out', false, 'exactly 10 chars, legitimate'],
      ['call me soon', false, '12 chars, real instruction'],
      ['I like jazz', false, '11 chars, real preference'],
      // Valid longer facts
      ['Remember I like jazz', false, '20 chars, full sentence'],
      ['my favorite color is blue', false, 'longer multi-word fact'],
      ['always use dark mode on computers', false, 'longer instruction'],
      ['the weather is sunny today', false, 'longer statement'],
      ['user prefers morning meetings', false, 'fact with 3+ letter words'],
    ];

    noiseTests.forEach(([input, shouldReject, desc]) => {
      it(`rejects or accepts as expected: ${desc}`, async () => {
        let written = null;
        const mockSemantic = {
          write: (topic, facts, opts) => { written = facts; return { ref: 'ref-test' }; }
        };
        const tools = buildTools({ semantic: mockSemantic, fs: {} });
        const remember = tools.find(t => t.name === 'remember');
        const result = await remember.fn({ text: input });

        if (shouldReject) {
          assert.equal(result.ok, false, `Expected rejection for: "${input}" (${desc})`);
          assert.ok(
            result.result.error.includes('Rejected'),
            `Expected "Rejected" in error for: "${input}"`
          );
          assert.equal(written, null, `Memory should not be written for noise: "${input}"`);
        } else {
          assert.equal(result.ok, true, `Expected acceptance for: "${input}" (${desc})`);
          assert.equal(result.result.remembered, input, `Remembered text should match input: "${input}"`);
          assert.ok(written !== null, `Memory should be written for: "${input}"`);
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// log_incident tool
// ---------------------------------------------------------------------------
describe('from-memory: log_incident', () => {
  it('returns error when text is empty', async () => {
    const tools = buildTools({ fs: { ensureDir: () => {}, appendLine: () => {} } });
    const log = tools.find(t => t.name === 'log_incident');
    const result = await log.fn({});
    assert.equal(result.ok, false);
    assert.ok(result.result.error.includes('text required'));
  });

  it('writes to incidents jsonl', async () => {
    let written = null;
    const mockFs = {
      ensureDir: () => {},
      appendLine: (path, data) => { written = { path, data }; }
    };
    const tools = buildTools({ fs: mockFs });
    const log = tools.find(t => t.name === 'log_incident');
    const result = await log.fn({ text: 'the search returned wrong results', severity: 'error' });
    assert.equal(result.ok, true);
    assert.ok(written.path.includes('Incidents'));
    assert.equal(written.data.severity, 'error');
    assert.equal(written.data.text, 'the search returned wrong results');
    assert.equal(written.data.source, 'voice');
  });

  it('defaults severity to warn', async () => {
    let written = null;
    const mockFs = { ensureDir: () => {}, appendLine: (p, d) => { written = d; } };
    const tools = buildTools({ fs: mockFs });
    const log = tools.find(t => t.name === 'log_incident');
    await log.fn({ text: 'minor issue' });
    assert.equal(written.severity, 'warn');
  });

  it('accepts error as alias for text', async () => {
    let written = null;
    const mockFs = {
      ensureDir: () => {},
      appendLine: (p, d) => { written = d; }
    };
    const tools = buildTools({ fs: mockFs });
    const log = tools.find(t => t.name === 'log_incident');
    const result = await log.fn({ error: 'something broke' });
    assert.equal(result.ok, true);
    assert.equal(written.text, 'something broke');
  });

  it('accepts message as alias for text', async () => {
    let written = null;
    const mockFs = {
      ensureDir: () => {},
      appendLine: (p, d) => { written = d; }
    };
    const tools = buildTools({ fs: mockFs });
    const log = tools.find(t => t.name === 'log_incident');
    const result = await log.fn({ message: 'this is wrong' });
    assert.equal(result.ok, true);
    assert.equal(written.text, 'this is wrong');
  });

  it('ensures Incidents directory before writing', async () => {
    const dirs = [];
    const mockFs = {
      ensureDir: (d) => { dirs.push(d); },
      appendLine: () => {}
    };
    const tools = buildTools({ fs: mockFs });
    const log = tools.find(t => t.name === 'log_incident');
    await log.fn({ text: 'test incident' });
    assert.ok(dirs.includes('Incidents'));
  });

  it('handles fs store unavailable', async () => {
    const tools = buildTools({});
    const log = tools.find(t => t.name === 'log_incident');
    const result = await log.fn({ text: 'test' });
    assert.equal(result.ok, false);
    assert.ok(result.result.error.includes('unavailable'));
  });

  it('handles fs appendLine throwing', async () => {
    const mockFs = {
      ensureDir: () => {},
      appendLine: () => { throw new Error('write failed'); }
    };
    const tools = buildTools({ fs: mockFs });
    const log = tools.find(t => t.name === 'log_incident');
    const result = await log.fn({ text: 'test' });
    assert.equal(result.ok, false);
    assert.ok(result.result.error.includes('write failed'));
  });

  it('returns logged text truncated to 200 chars', async () => {
    const mockFs = {
      ensureDir: () => {},
      appendLine: () => {}
    };
    const tools = buildTools({ fs: mockFs });
    const log = tools.find(t => t.name === 'log_incident');
    const longText = 'b'.repeat(300);
    const result = await log.fn({ text: longText });
    assert.equal(result.ok, true);
    assert.equal(result.result.logged.length, 200);
  });

  it('includes date in the returned result', async () => {
    const mockFs = {
      ensureDir: () => {},
      appendLine: () => {}
    };
    const tools = buildTools({ fs: mockFs });
    const log = tools.find(t => t.name === 'log_incident');
    const result = await log.fn({ text: 'check date' });
    assert.equal(result.ok, true);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(result.result.date, today);
  });

  it('incidents entry includes timestamp and id', async () => {
    let written = null;
    const mockFs = {
      ensureDir: () => {},
      appendLine: (p, d) => { written = d; }
    };
    const tools = buildTools({ fs: mockFs });
    const log = tools.find(t => t.name === 'log_incident');
    await log.fn({ text: 'test id and ts' });
    assert.ok(typeof written.id === 'string');
    assert.ok(written.id.startsWith('inc-'));
    assert.ok(typeof written.ts === 'number');
    assert.ok(written.ts > 0);
  });
});

// ---------------------------------------------------------------------------
// tool structure invariants
// ---------------------------------------------------------------------------
describe('from-memory: tool structure', () => {
  it('exports exactly 2 tools', () => {
    const tools = buildTools({ semantic: { write: () => ({}) }, fs: { ensureDir: () => {}, appendLine: () => {} } });
    assert.equal(tools.length, 2);
  });

  it('remember tool has correct metadata', () => {
    const tools = buildTools({ semantic: { write: () => ({}) }, fs: {} });
    const remember = tools.find(t => t.name === 'remember');
    assert.equal(remember.name, 'remember');
    assert.equal(remember.danger, false);
    assert.ok(typeof remember.description === 'string');
    assert.ok(remember.description.length > 0);
    assert.ok(typeof remember.fn === 'function');
  });

  it('log_incident tool has correct metadata', () => {
    const tools = buildTools({ fs: { ensureDir: () => {}, appendLine: () => {} } });
    const log = tools.find(t => t.name === 'log_incident');
    assert.equal(log.name, 'log_incident');
    assert.equal(log.danger, false);
    assert.ok(typeof log.description === 'string');
    assert.ok(log.description.length > 0);
    assert.ok(typeof log.fn === 'function');
  });
});
