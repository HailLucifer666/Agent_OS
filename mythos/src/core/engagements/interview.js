'use strict';

// Interview orchestration
// ENGAGEMENT-SPEC section 1.1 interview interface

function createInterview({ config, brain }) {
  if (!config) throw new Error('config required');

  var maxQuestions = (config.ENGAGEMENT_INTERVIEW_MAX_Q || 5);
  // V6 (Phase 4): brain is optional. When absent or offline, every method
  // falls back to the canned DEFAULT_QUESTIONS template (honest-inert).

  // Default questions for engagement intake
  var DEFAULT_QUESTIONS = [
    {
      id: 'q-type',
      prompt: 'What kind of deliverable are we building?',
      type: 'choice',
      options: ['Web application', 'CLI tool', 'API', 'Documentation site', 'Library', 'Other']
    },
    {
      id: 'q-stack',
      prompt: 'What tech stack should we use?',
      type: 'text'
    },
    {
      id: 'q-scope',
      prompt: 'What is the main feature or goal?',
      type: 'text'
    },
    {
      id: 'q-complexity',
      prompt: 'How complex is this project?',
      type: 'choice',
      options: ['Simple (one file/component)', 'Medium (few files)', 'Complex (many components)']
    },
    {
      id: 'q-requirements',
      prompt: 'Any specific requirements or constraints?',
      type: 'text'
    }
  ];

  // Generate questions based on initial intent
  function generateQuestions(intent) {
    // For v1, use defaults; future versions could tailor based on intent
    return DEFAULT_QUESTIONS.slice(0, maxQuestions).map(function(q) {
      return {
        id: q.id,
        prompt: q.prompt,
        type: q.type,
        options: q.options ? q.options.slice(0) : undefined
      };
    });
  }

  // V6 (Phase 4): brain-driven question generation. Asks the brain to tailor
  // the interview questions to the engagement's initial intent — e.g. a
  // "spotify integration" engagement gets questions about OAuth + audio APIs,
  // not the generic stack/scope defaults.
  //
  // Honest-inert fallback: on any failure (no brain, brain offline, parse
  // fail, brain returns garbage), returns the canned DEFAULT_QUESTIONS so the
  // engagement can still proceed. The brain is an enhancement, never a gate.
  async function generateQuestionsBrain(intent) {
    if (!brain || typeof brain.think !== 'function') return generateQuestions(intent);
    var intentText = (intent && typeof intent === 'string') ? intent :
                     (intent && intent.text) || '';
    if (!intentText.trim()) return generateQuestions(intent);
    try {
      var result = await brain.think({
        lane: 'simple',
        messages: [{ role: 'user', content:
          'You are scoping a software engagement. The operator said: "' + intentText + '".\n' +
          'Generate ' + maxQuestions + ' targeted interview questions that will clarify the ' +
          'deliverable, scope, and constraints SPECIFIC to this intent. Don\'t ask generic ' +
          'questions — tailor them to what you already know about the domain.\n' +
          'Respond as JSON: {"questions": [{"id":"q-kebab-name","prompt":"the question",' +
          '"type":"text|choice","options":["a","b"]}, ...]}\n' +
          'type:choice must include options. Max ' + maxQuestions + ' questions.'
        }],
        schemaHint: '{ questions: Array<{id:string,prompt:string,type:string,options?:string[]}> }',
        source: 'engagement:interview'
      });
      if (!result || result.offline || result.aborted || !result.parsed) {
        return generateQuestions(intent);
      }
      var qs = Array.isArray(result.parsed.questions) ? result.parsed.questions : [];
      // Validate + cap. Each question needs id + prompt; type defaults to text.
      var validated = qs.filter(function (q) {
        return q && q.id && String(q.prompt || '').trim();
      }).slice(0, maxQuestions).map(function (q, i) {
        return {
          id: String(q.id),
          prompt: String(q.prompt),
          type: q.type === 'choice' ? 'choice' : 'text',
          options: Array.isArray(q.options) ? q.options.slice(0, 6) : undefined
        };
      });
      if (validated.length === 0) return generateQuestions(intent);
      return validated;
    } catch (_) {
      return generateQuestions(intent);
    }
  }

  // Start interview - returns questions array
  function start(engagement) {
    if (!engagement || !engagement.id) {
      throw new Error('Engagement required');
    }

    var questions = generateQuestions(engagement.initialIntent);
    var now = Date.now();

    return {
      questions: questions,
      completedAt: null
    };
  }

  // Record answer for a question
  function answer(questionId, answer, interview) {
    if (!interview || !interview.questions) {
      throw new Error('Interview data required');
    }

    // Find the question
    var question = interview.questions.find(function(q) { return q.id === questionId; });
    if (!question) {
      throw new Error('Question not found: ' + questionId);
    }

    // Validate answer matches question type
    if (question.type === 'confirm' && !/^(yes|no)$/i.test(answer)) {
      throw new Error('Confirm question requires yes/no answer');
    }

    if (question.type === 'numeric' && isNaN(answer)) {
      throw new Error('Numeric question requires a number');
    }

    if (question.type === 'choice' && question.options) {
      if (question.options.indexOf(answer) === -1) {
        throw new Error('Answer must be one of: ' + question.options.join(', '));
      }
    }

    // Update question with answer (immutable update)
    var updatedQuestions = interview.questions.map(function(q) {
      if (q.id === questionId) {
        return {
          id: q.id,
          prompt: q.prompt,
          type: q.type,
          options: q.options,
          answer: answer
        };
      }
      return q;
    });

    return {
      questions: updatedQuestions,
      completedAt: interview.completedAt
    };
  }

  // Check if interview is complete
  function complete(interview) {
    if (!interview || !interview.questions) {
      return { answers: [], completed: false };
    }

    var totalQuestions = interview.questions.length;
    var answered = interview.questions.filter(function(q) {
      return typeof q.answer !== 'undefined' && q.answer !== null && q.answer !== '';
    });

    // All questions must be answered
    var allAnswered = answered.length === totalQuestions && totalQuestions > 0;

    return {
      answers: answered,
      completed: allAnswered
    };
  }

  // Get next unanswered question
  function getNextQuestion(interview) {
    if (!interview || !interview.questions || interview.questions.length === 0) {
      return null;
    }

    // Return first unanswered question
    var unanswered = interview.questions.filter(function(q) {
      return typeof q.answer === 'undefined' || q.answer === null || q.answer === '';
    });

    return unanswered.length > 0 ? unanswered[0] : null;
  }

  // Get question by id
  function getQuestion(interview, questionId) {
    if (!interview || !interview.questions) return null;
    return interview.questions.find(function(q) { return q.id === questionId; });
  }

  return {
    start: start,
    answer: answer,
    complete: complete,
    getNextQuestion: getNextQuestion,
    getQuestion: getQuestion,
    generateQuestions: generateQuestions,
    generateQuestionsBrain: generateQuestionsBrain   // V6 (Phase 4)
  };
}

module.exports = { createInterview };