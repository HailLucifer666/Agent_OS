'use strict';

// Conversation Gateway - intent classification and routing
// ENGAGEMENT-SPEC section 1.2 gateway.js interface

function createConversationGateway({ bus, config, engagementManager, cortex }) {
  if (!bus) throw new Error('bus required');
  if (!config) throw new Error('config required');
  // engagementManager and cortex are optional but recommended

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

    // Emit for cortex to handle other intents
    if (!result.handled && cortex) {
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
      /^skip.*interview/
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