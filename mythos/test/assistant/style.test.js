'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  applyStyle,
  formatInterviewQuestion,
  formatSpecPreview,
  formatCompletionReport,
  VOICE_STYLES
} = require('../../src/core/assistant/style');

describe('assistant/style', () => {
  describe('applyStyle', () => {
    it('returns neutral text unchanged', () => {
      var result = applyStyle('hello', VOICE_STYLES.NEUTRAL);
      assert.equal(result, 'hello');
    });

    it('applies confident style', () => {
      var result = applyStyle('done', VOICE_STYLES.CONFIDENT);
      assert.equal(result, 'Absolutely. done');
    });

    it('applies inquiring style with ?', () => {
      var result = applyStyle('what is this', VOICE_STYLES.INQUIRING);
      assert.ok(result.endsWith('?'));
    });

    it('does not add ? for questioning text', () => {
      var result = applyStyle('what is this?', VOICE_STYLES.INQUIRING);
      assert.equal(result, 'what is this?');
    });

    it('returns empty for null text', () => {
      var result = applyStyle(null, VOICE_STYLES.NEUTRAL);
      assert.equal(result, '');
    });
  });

  describe('formatInterviewQuestion', () => {
    it('formats confirm question', () => {
      var result = formatInterviewQuestion({
        id: 'q-1',
        prompt: 'Continue?',
        type: 'confirm'
      });
      assert.ok(result.includes('Continue?'));
      assert.ok(result.includes('Yes / No'));
    });

    it('formats choice question', () => {
      var result = formatInterviewQuestion({
        id: 'q-2',
        prompt: 'Choose type',
        type: 'choice',
        options: ['Web', 'CLI']
      });
      assert.ok(result.includes('Choose type'));
      assert.ok(result.includes('Web'));
      assert.ok(result.includes('CLI'));
    });

    it('formats text question', () => {
      var result = formatInterviewQuestion({
        id: 'q-3',
        prompt: 'Enter name',
        type: 'text'
      });
      assert.ok(result.includes('Enter name'));
      assert.ok(result.includes('Text input'));
    });

    it('formats numeric question', () => {
      var result = formatInterviewQuestion({
        id: 'q-4',
        prompt: 'Enter count',
        type: 'numeric'
      });
      assert.ok(result.includes('Enter count'));
      assert.ok(result.includes('number'));
    });

    it('returns empty for null question', () => {
      var result = formatInterviewQuestion(null);
      assert.equal(result, '');
    });
  });

  describe('formatSpecPreview', () => {
    it('returns markdown unchanged', () => {
      var md = '# Title\n\nContent';
      var result = formatSpecPreview(md);
      assert.equal(result, md);
    });

    it('returns empty for null', () => {
      var result = formatSpecPreview(null);
      assert.equal(result, '');
    });
  });

  describe('formatCompletionReport', () => {
    it('formats report with verification summary', () => {
      var report = {
        markdown: '# Done',
        verificationSummary: { passed: 5, failed: 0, repaired: 1 }
      };
      var result = formatCompletionReport(report);
      assert.ok(result.includes('Passed: 5'));
      assert.ok(result.includes('Repaired: 1'));
    });

    it('returns default for null report', () => {
      var result = formatCompletionReport(null);
      assert.equal(result, 'No report available');
    });
  });
});