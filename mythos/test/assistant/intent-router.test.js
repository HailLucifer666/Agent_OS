'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  routeIntent,
  classifyChat,
  classifyQuestion,
  classifyAction
} = require('../../src/core/assistant/intent-router');

describe('assistant/intent-router', () => {
  describe('routeIntent', () => {
    it('returns unknown for null classification', () => {
      var result = routeIntent(null, {});
      assert.equal(result.destination, 'unknown');
    });

    it('routes action to engagement', () => {
      var result = routeIntent(
        { type: 'action', action: 'create' },
        { engagementId: 'eng-123' }
      );
      assert.equal(result.destination, 'engagement');
      assert.equal(result.action, 'create');
    });

    it('routes question to cortex', () => {
      var result = routeIntent(
        { type: 'question', question: 'what is that?' },
        {}
      );
      assert.equal(result.destination, 'cortex');
    });

    it('routes chat to cortex', () => {
      var result = routeIntent(
        { type: 'chat', text: 'hello' },
        {}
      );
      assert.equal(result.destination, 'cortex');
    });
  });

  describe('classifyChat', () => {
    it('classifies as chat with 0.8 confidence', () => {
      var result = classifyChat('some text');
      assert.equal(result.type, 'chat');
      assert.equal(result.confidence, 0.8);
      assert.equal(result.text, 'some text');
    });
  });

  describe('classifyQuestion', () => {
    it('detects question ending in ?', () => {
      var result = classifyQuestion('what is this?');
      assert.equal(result.type, 'question');
    });

    it('detects question starting with what', () => {
      var result = classifyQuestion('what is the time');
      assert.equal(result.type, 'question');
    });

    it('detects question starting with how', () => {
      var result = classifyQuestion('how does it work');
      assert.equal(result.type, 'question');
    });

    it('returns chat for non-question', () => {
      var result = classifyQuestion('this is a statement');
      assert.equal(result.type, 'chat');
    });
  });

  describe('classifyAction', () => {
    it('detects create action', () => {
      var result = classifyAction('create an engagement');
      assert.equal(result.type, 'action');
      assert.equal(result.action, 'create_engagement');
    });

    it('detects approve action', () => {
      var result = classifyAction('approve');
      assert.equal(result.type, 'action');
      assert.equal(result.action, 'approve');
    });

    it('detects start_interview action', () => {
      var result = classifyAction('start interview');
      assert.equal(result.type, 'action');
      assert.equal(result.action, 'start_interview');
    });

    it('returns unknown for non-action', () => {
      var result = classifyAction('random words here');
      assert.equal(result.type, 'unknown');
    });
  });
});