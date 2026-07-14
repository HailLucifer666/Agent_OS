'use strict';

// Intent routing helpers
// ENGAGEMENT-SPEC section 1.2 intent-router interface

// Route intent to decision
function routeIntent(classification, msg) {
  if (!classification) {
    return { destination: 'unknown', action: null };
  }

  var type = classification.type;

  if (type === 'action') {
    return {
      destination: 'engagement',
      action: classification.action,
      engagementId: msg && msg.engagementId
    };
  }

  if (type === 'question') {
    return {
      destination: 'cortex',
      action: 'answer',
      question: classification.question
    };
  }

  if (type === 'chat') {
    return {
      destination: 'cortex',
      action: 'respond',
      text: classification.text
    };
  }

  return { destination: 'unknown', action: null };
}

// Classify as chat
function classifyChat(text) {
  return {
    type: 'chat',
    confidence: 0.8,
    text: text
  };
}

// Classify as question
function classifyQuestion(text) {
  // Check for question patterns
  var lowered = text.toLowerCase().trim();
  var questionPatterns = [
    /\?$/,
    /^what /,
    /^how /,
    /^when /,
    /^where /,
    /^why /,
    /^who /,
    /^can you /,
    /^could you /,
    /^would you /,
    /^should i /
  ];

  var isQuestion = questionPatterns.some(function(p) { return p.test(lowered); });

  return {
    type: isQuestion ? 'question' : 'chat',
    confidence: isQuestion ? 0.9 : 0.7,
    question: isQuestion ? text : null,
    text: isQuestion ? text : text
  };
}

// Classify as action
function classifyAction(text) {
  var lowered = text.toLowerCase().trim();

  var actionPatterns = {
    'create_engagement': /^create.*(engagement|project|task)$/,
    'delete_engagement': /^delete.*engagement$/,
    'list_engagements': /^(list|show).*(engagements?|projects?)$/,
    'approve': /^(approve|accept|yes)$/,
    'reject': /^reject/,
    'start_interview': /^start.*interview/,
    'skip_interview': /^(skip|cancel).*(interview|all)/,
    'revise': /^(revise|edit|change)/,
    'abandon': /^(abandon|cancel|discard)/
  };

  for (var action in actionPatterns) {
    if (actionPatterns[action].test(lowered)) {
      return {
        type: 'action',
        confidence: 0.95,
        action: action
      };
    }
  }

  return {
    type: 'unknown',
    confidence: 0.5
  };
}

module.exports = {
  routeIntent: routeIntent,
  classifyChat: classifyChat,
  classifyQuestion: classifyQuestion,
  classifyAction: classifyAction
};