'use strict';

// Interview orchestration
// ENGAGEMENT-SPEC section 1.1 interview interface

function createInterview({ config, brain, buildEngine }) {
  if (!config) throw new Error('config required');

  var maxQuestions = (config.ENGAGEMENT_INTERVIEW_MAX_Q || 5);
  // V6 (Phase 4): brain is optional. When absent or offline, every method
  // falls back to the canned DEFAULT_QUESTIONS template (honest-inert).
  // Phase B: buildEngine (DeepSeek Harness) is now the preferred generator for
  // generateQuestionsBrain() below, same single-engine reasoning as
  // executor.js's build stage. Unlike brain.think (schemaHint pre-parses the
  // reply into result.parsed), buildEngine.generate() only returns raw
  // result.content, so the generator path parses the JSON object itself
  // (extractJsonObject below, mirroring plan-builder.js's array extractor).

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
    var generator = buildEngine && typeof buildEngine.generate === 'function' ? buildEngine : null;
    if (!generator && (!brain || typeof brain.think !== 'function')) return generateQuestions(intent);
    var intentText = (intent && typeof intent === 'string') ? intent :
                     (intent && intent.text) || '';
    if (!intentText.trim()) return generateQuestions(intent);
    var prompt =
      'You are scoping a software engagement. The operator said: "' + intentText + '".\n' +
      'Generate ' + maxQuestions + ' targeted interview questions that will clarify the ' +
      'deliverable, scope, and constraints SPECIFIC to this intent. Don\'t ask generic ' +
      'questions — tailor them to what you already know about the domain.\n' +
      'Respond as JSON: {"questions": [{"id":"q-kebab-name","prompt":"the question",' +
      '"type":"text|choice","options":["a","b"]}, ...]}\n' +
      'type:choice must include options. Max ' + maxQuestions + ' questions.';
    try {
      var parsed;
      if (generator) {
        var result = await generator.generate({ prompt: prompt, source: 'engagement:interview' });
        if (!result || result.offline || result.aborted || !result.content) return generateQuestions(intent);
        parsed = extractJsonObject(result.content);
      } else {
        // lane 'reasoning' (2026-08-14) — the questions this generates shape the
        // whole engagement, and there is a hand-written fallback right below if
        // the lane is down, so a slower/better model costs nothing.
        var brainResult = await brain.think({
          lane: 'reasoning',
          messages: [{ role: 'user', content: prompt }],
          schemaHint: '{ questions: Array<{id:string,prompt:string,type:string,options?:string[]}> }',
          source: 'engagement:interview'
        });
        if (!brainResult || brainResult.offline || brainResult.aborted || !brainResult.parsed) {
          return generateQuestions(intent);
        }
        parsed = brainResult.parsed;
      }
      if (!parsed) return generateQuestions(intent);
      var qs = Array.isArray(parsed.questions) ? parsed.questions : [];
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

  // Pull a JSON object out of the generator's (possibly prose-wrapped) reply.
  // Mirrors plan-builder.js's extractJsonArray, but balances '{'/'}' instead
  // of '['/']' since buildEngine.generate() has no schemaHint pre-parsing.
  function extractJsonObject(content) {
    if (!content) return null;
    if (typeof content === 'object') return content;
    if (typeof content !== 'string') return null;
    var direct = tryParseJson(content);
    if (direct && typeof direct === 'object') return direct;
    var start = content.indexOf('{');
    if (start === -1) return null;
    var depth = 0;
    for (var i = start; i < content.length; i += 1) {
      if (content[i] === '{') depth += 1;
      else if (content[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          var parsed = tryParseJson(content.slice(start, i + 1));
          return (parsed && typeof parsed === 'object') ? parsed : null;
        }
      }
    }
    return null;
  }

  function tryParseJson(s) {
    try { return JSON.parse(s); } catch (_) { return null; }
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