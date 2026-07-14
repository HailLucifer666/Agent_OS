'use strict';

// Plans responses for chat/questions
// ENGAGEMENT-SPEC section 1.2 response-planner interface

function createResponsePlanner({ config, cortex, memory }) {
  if (!config) throw new Error('config required');
  if (!cortex) throw new Error('cortex required');

  // Plan response for intent
  async function plan(intent, context) {
    if (!intent || !intent.type) {
      return {
        type: 'error',
        message: 'Invalid intent'
      };
    }

    var plan = {
      intent: intent.type,
      steps: [],
      response: null
    };

    if (intent.type === 'chat') {
      plan.steps.push({ type: 'conversation', action: 'respond' });
      plan.response = formatChatResponse(intent.text, context);
    }

    if (intent.type === 'question') {
      plan.steps.push({ type: 'reasoning', action: 'analyze' });
      plan.response = formatQuestionResponse(intent.question, context);
    }

    return plan;
  }

  // Format response
  async function format(plan) {
    if (!plan) return '';
    return plan.response || '';
  }

  // Format chat response
  function formatChatResponse(text, context) {
    if (!text) return '';
    // Simple echo for now - cortex would generate actual responses
    return "I heard: " + text;
  }

  // Format question response
  function formatQuestionResponse(question, context) {
    if (!question) return '';
    // Simple acknowledgment for now
    return "That's a good question about: " + question;
  }

  return {
    plan: plan,
    format: format
  };
}

module.exports = { createResponsePlanner };