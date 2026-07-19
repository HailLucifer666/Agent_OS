'use strict';

// Conversation Gateway - intent classification and routing
// ENGAGEMENT-SPEC section 1.2 gateway.js interface
//
// W5 (Phase 2 — Wiring Integrity): this module is constructed at boot step 12
// (conversation-gateway), BEFORE cortex exists (cortex is boot step 19). Passing
// `cortex` directly captured the null forever — the cortex-fallback route in
// route() was permanently dead. The fix mirrors the immune system's healer/
// watchdog pattern (boot step 5): accept a `getCortex` thunk that resolves
// cortex lazily at first route() call. Backward-compat: a directly-passed
// `cortex` is still accepted (unit tests / older callers).

function createConversationGateway({ bus, config, engagementManager, cortex, getCortex }) {
  if (!bus) throw new Error('bus required');
  if (!config) throw new Error('config required');
  // engagementManager and cortex are optional but recommended.
  // W5: prefer getCortex thunk; fall back to a directly-passed cortex for
  // backward compatibility. resolveCortex() returns whatever cortex is live
  // at call time (null until the cortex boot step assigns it).
  var cortexThunk = typeof getCortex === 'function' ? getCortex : function() { return cortex; };
  function resolveCortex() { return cortexThunk(); }

  // Receive incoming message
  function receive(message) {
    if (!message) {
      throw new Error('message required');
    }

    // Classify intent
    var classification = classifyMessage(message.text || '');
    // Route to appropriate handler
    return route(classification, message);
  }

  // Classify message intent
  function classify(text) {
    return classifyMessage(text);
  }

  // Classify message text
  function classifyMessage(text) {
    if (!text || typeof text !== 'string') {
      return { type: 'unknown', confidence: 0 };
    }

    var lowered = text.toLowerCase().trim();

    // Check for action patterns
    if (isActionPattern(lowered)) {
      return {
        type: 'action',
        confidence: 0.95,
        action: extractAction(lowered)
      };
    }

    // Check for question patterns
    if (isQuestionPattern(lowered)) {
      return {
        type: 'question',
        confidence: 0.9,
        question: text
      };
    }

    // Default to chat
    return {
      type: 'chat',
      confidence: 0.8,
      text: text
    };
  }

  // Route classified intent
  function route(classification, message) {
    if (!classification) {
      throw new Error('classification required');
    }

    var result = {
      type: classification.type,
      handled: false,
      response: null
    };

    // Route to engagement manager for action intents
    if (classification.type === 'action' && engagementManager) {
      var action = classification.action;
      if (isEngagementAction(action)) {
        bus.emit('engagement.action.' + action, {
          text: message.text,
          engagementId: message.engagementId
        });
        result.handled = true;
      }
    }

    // Emit for cortex to handle other intents. W5: resolve cortex lazily so the
    // fallback route fires once the cortex boot step has run (this gateway is
    // constructed at step 12, cortex at step 19 — pre-W5 the captured `cortex`
    // was null forever and this branch was permanently dead).
    if (!result.handled && resolveCortex()) {
      bus.emit('conversation.intent', {
        type: classification.type,
        message: message
      });
    }

    return result;
  }

  // Check if text matches action pattern
  function isActionPattern(text) {
    var actionPatterns = [
      /^create.*engagement/,
      /^delete.*engagement/,
      /^list.*engagement/,
      /^show.*engagement/,
      /^approved?/,
      /^reject/,
      /^start.*interview/,
      /^skip.*interview/,
      // Not anchored like the others: a real request always leads with the
      // ask ("build me a todo app", "I want to...") before this trigger
      // phrase, so requiring start-of-string would never match natural
      // phrasing — only "interview me" itself is a reliable signal.
      /interview me/
    ];
    return actionPatterns.some(function(p) { return p.test(text); });
  }

  // Check if text matches question pattern
  function isQuestionPattern(text) {
    // Ends with ? or starts with question words
    var questionEndings = text.endsWith('?');
    var questionWords = [
      'what', 'how', 'when', 'where', 'why', 'who',
      'can you', 'could you', 'would you', 'should i'
    ];
    var startsWithQuestion = questionWords.some(function(w) {
      return text.startsWith(w + ' ') || text.startsWith(w + '\'');
    });
    return questionEndings || startsWithQuestion;
  }

  // Extract action from text
  function extractAction(text) {
    if (/create.*engagement/.test(text)) return 'create';
    if (/delete.*engagement/.test(text)) return 'delete';
    if (/list.*engagement/.test(text)) return 'list';
    if (/show.*engagement/.test(text)) return 'show';
    if (/approved?/.test(text)) return 'approve';
    if (/reject/.test(text)) return 'reject';
    if (/interview me/.test(text)) return 'startInterview';
    if (/start.*interview/.test(text)) return 'startInterview';
    if (/skip.*interview/.test(text)) return 'skip';
    return 'unknown';
  }

  // Check if action is engagement-related
  function isEngagementAction(action) {
    var engagementActions = ['create', 'delete', 'list', 'show', 'approve', 'reject'];
    return engagementActions.indexOf(action) !== -1;
  }

  return {
    receive: receive,
    classify: classify,
    route: route
  };
}

module.exports = { createConversationGateway };