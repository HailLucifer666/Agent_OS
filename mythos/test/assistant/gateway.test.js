'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createConversationGateway } = require('../../src/core/assistant/gateway');

function fakeBus() {
  const emitted = [];
  return {
    emit: function(type, payload) {
      emitted.push({ type: type, payload: payload });
    },
    _emitted: function() { return emitted.slice(); }
  };
}

describe('assistant/gateway', () => {
  let gateway, bus;

  beforeEach(function() {
    bus = fakeBus();
    gateway = createConversationGateway({ bus: bus, config: {} });
  });

  describe('receive', () => {
    it('throws without message', () => {
      assert.throws(function() {
        gateway.receive();
      }, /message required/);
    });

    it('classifies and routes message', () => {
      var result = gateway.receive({ text: 'this is a test message' });
      assert.ok(result);
      assert.equal(result.type, 'chat');
    });
  });

  describe('classify', () => {
    it('classifies chat message', () => {
      var result = gateway.classify('hello there');
      assert.equal(result.type, 'chat');
      assert.ok(result.confidence > 0);
    });

    it('classifies question', () => {
      var result = gateway.classify('what is this?');
      assert.equal(result.type, 'question');
    });

    it('classifies action pattern', () => {
      var result = gateway.classify('create an engagement');
      assert.equal(result.type, 'action');
      assert.equal(result.action, 'create');
    });
  });
});