'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createInterview } = require('../../src/core/engagements/interview');

describe('engagements/interview', () => {
  let interview;

  beforeEach(function() {
    interview = createInterview({ config: { ENGAGEMENT_INTERVIEW_MAX_Q: 5 } });
  });

  describe('start', () => {
    it('starts interview with default questions', () => {
      const result = interview.start({ id: 'eng-123', initialIntent: 'build a CLI' });
      assert.ok(Array.isArray(result.questions));
      assert.ok(result.questions.length > 0);
      assert.ok(result.questions[0].id);
      assert.ok(result.questions[0].prompt);
      assert.ok(result.completedAt === null);
    });

    it('throws if engagement missing', () => {
      assert.throws(function() {
        interview.start();
      }, /Engagement required/);
    });
  });

  describe('answer', () => {
    it('records answer for text question', () => {
      const int = interview.start({ id: 'eng-1', initialIntent: 'test' });
      // q-stack is a text question (index 1)
      const intWithType = interview.answer('q-type', 'CLI tool', int);
      const updated = interview.answer('q-stack', 'Node.js + TypeScript', intWithType);

      // Find q-stack in updated questions
      const qStack = updated.questions.find(function(q) { return q.id === 'q-stack'; });
      assert.equal(qStack.answer, 'Node.js + TypeScript');
      assert.equal(updated.questions.length, int.questions.length); // Same length
    });

    it('throws for invalid question id', () => {
      const int = interview.start({ id: 'eng-1', initialIntent: 'test' });
      assert.throws(function() {
        interview.answer('invalid', 'answer', int);
      }, /Question not found/);
    });

    it('throws for invalid choice answer', () => {
      const int = interview.start({ id: 'eng-1', initialIntent: 'test' });
      assert.throws(function() {
        interview.answer('q-type', 'Invalid Choice', int);
      }, /must be one of/);
    });

    it('accepts valid choice answer', () => {
      const int = interview.start({ id: 'eng-1', initialIntent: 'test' });
      const updated = interview.answer('q-type', 'CLI tool', int);
      assert.equal(updated.questions.find(function(q) { return q.id === 'q-type'; }).answer, 'CLI tool');
    });

    it('throws for invalid confirm answer', () => {
      const int = interview.start({ id: 'eng-1', initialIntent: 'test' });
      // First set q-type to confirm type
      const questions = int.questions.map(function(q) {
        if (q.id === 'q-type') {
          return { id: 'q-type', prompt: 'Confirm?', type: 'confirm', options: ['Yes', 'No'] };
        }
        return q;
      });
      assert.throws(function() {
        interview.answer('q-type', 'maybe', { questions: questions });
      }, /yes\/no answer/);
    });
  });

  describe('complete', () => {
    it('returns completed false with no answers', () => {
      const int = interview.start({ id: 'eng-1', initialIntent: 'test' });
      const result = interview.complete(int);
      assert.equal(result.completed, false);
      assert.deepEqual(result.answers, []);
    });

    it('returns completed false when some unanswered', () => {
      const int = interview.start({ id: 'eng-1', initialIntent: 'test' });
      // Only answer one question
      const withAnswer = interview.answer('q-type', 'CLI tool', int);
      const result = interview.complete(withAnswer);
      // Not all answered yet - all 5 questions must have answers
      assert.equal(result.completed, false);
    });
  });

  describe('getNextQuestion', () => {
    it('returns first question initially', () => {
      const int = interview.start({ id: 'eng-1', initialIntent: 'test' });
      const next = interview.getNextQuestion(int);
      assert.ok(next);
      assert.equal(next.id, int.questions[0].id);
    });

    it('returns next unanswered question', () => {
      const int = interview.start({ id: 'eng-1', initialIntent: 'test' });
      const withAnswer = interview.answer('q-type', 'CLI tool', int);
      const next = interview.getNextQuestion(withAnswer);
      assert.ok(next);
      assert.notEqual(next.id, 'q-type');
    });

    it('returns null when all answered', () => {
      const int = interview.start({ id: 'eng-1', initialIntent: 'test' });
      // Answer all questions with valid answers
      var current = int;
      for (var i = 0; i < int.questions.length; i++) {
        var q = int.questions[i];
        if (q.type === 'choice') {
          current = interview.answer(q.id, q.options[0], current);
        } else {
          current = interview.answer(q.id, 'answer ' + i, current);
        }
      }
      const next = interview.getNextQuestion(current);
      // When all answered, should return null
      assert.equal(next, null);
    });

    it('returns null for empty interview', () => {
      const next = interview.getNextQuestion({ questions: [] });
      assert.equal(next, null);
    });
  });
});