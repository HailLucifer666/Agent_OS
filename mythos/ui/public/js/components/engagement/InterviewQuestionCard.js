// InterviewQuestionCard.js — Renders interview question cards with 5 variants
// Variants: confirm, choice, text, multi-select, numeric

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export function renderInterviewCard(question, state = 'ready', answer = null) {
  const questionNum = question.questionNum || 1;
  const totalQuestions = question.totalQuestions || 5;
  const stepDots = renderStepDots(questionNum, totalQuestions);

  const content = {
    confirm: renderConfirmVariant(question, state, answer),
    choice: renderChoiceVariant(question, state, answer),
    text: renderTextVariant(question, state, answer),
    'multi-select': renderMultiSelectVariant(question, state, answer),
    numeric: renderNumericVariant(question, state, answer),
  };

  const variantContent = content[question.type] || '';

  return `
    <div class="engag-interview-card${state === 'loading' ? ' is-loading' : ''}${state === 'error' ? ' is-error' : ''}${state === 'answered' ? ' is-answered' : ''}" role="form" aria-label="Interview question ${questionNum} of ${totalQuestions}">
      <div class="engag-interview-card-header">
        <div class="engag-interview-icon" aria-hidden="true">?</div>
        <div class="engag-interview-progress">
          QUESTION ${questionNum} <span style="opacity: 0.5;">of ${totalQuestions}</span>
        </div>
        <div class="engag-interview-step-dots" aria-hidden="true">
          ${stepDots}
        </div>
        <button class="engag-interview-skip-btn" type="button">Skip All →</button>
      </div>

      <div class="engag-interview-prompt" aria-live="polite">${escapeHtml(question.prompt || '')}</div>

      ${variantContent}

      <div class="engag-interview-actions">
        <button class="engag-interview-back" type="button">← Back</button>
        <button class="engag-interview-next" type="button">${answer ? 'Next →' : 'Continue →'}</button>
      </div>

      <a href="#" class="engag-interview-cancel">Cancel engagement — will discard all progress</a>
    </div>
  `;
}

function renderStepDots(current, total) {
  const dots = [];
  for (let i = 1; i <= total; i++) {
    dots.push(`<div class="engag-interview-step-dot${i === current ? ' active' : ''}${i < current ? ' completed' : ''}"></div>`);
  }
  return dots.join('');
}

function renderConfirmVariant(question, state, answer) {
  if (state === 'loading') {
    return `<div class="engag-skeleton-line" style="width: 40%;"></div>`;
  }

  const options = question.options || ['Yes', 'No'];
  return `
    <div class="engag-interview-confirm-group" role="radiogroup" aria-label="${escapeHtml(question.prompt)}">
      ${options.map((opt) => `
        <button class="engag-pill-btn${String(answer) === opt ? ' selected' : ''}" type="button">${escapeHtml(opt)}</button>
      `).join('')}
    </div>
  `;
}

function renderChoiceVariant(question, state, answer) {
  if (state === 'loading') {
    return `<div class="engag-skeleton-line" style="width: 60%;"></div>`;
  }

  const options = question.options || [];
  return `
    <div class="engag-choice-group" role="radiogroup" aria-label="${escapeHtml(question.prompt)}">
      ${options.map((opt) => `
        <button class="engag-choice-option${String(answer) === opt ? ' selected' : ''}" type="button">${escapeHtml(opt)}</button>
      `).join('')}
    </div>
  `;
}

function renderTextVariant(question, state, answer) {
  if (state === 'loading') {
    return `<div class="engag-skeleton-line"></div>`;
  }

  return `<input type="text" class="engag-text-input" value="${escapeHtml(answer || '')}" placeholder="Type your answer…" />`;
}

function renderMultiSelectVariant(question, state, answer) {
  if (state === 'loading') {
    return '<div class="engag-skeleton-line" style="height: 60px;"></div>';
  }

  const options = question.options || [];
  const selected = Array.isArray(answer) ? answer : [];

  return `
    <div class="engag-multiselect-group" role="group" aria-label="${escapeHtml(question.prompt)}">
      ${options.map((opt) => `
        <div class="engag-multiselect-item${selected.includes(opt) ? ' selected' : ''}" data-value="${escapeHtml(opt)}">
          <div class="engag-multiselect-check" aria-hidden="true">${selected.includes(opt) ? '✓' : ''}</div>
          <span>${escapeHtml(opt)}</span>
        </div>
      `).join('')}
    </div>
    <button class="engag-btn engag-btn-primary" type="button" style="margin-top: 12px;">Done →</button>
  `;
}

function renderNumericVariant(question, state, answer) {
  if (state === 'loading') {
    return `<div class="engag-skeleton-line" style="width: 80px;"></div>`;
  }

  const value = answer != null ? answer : question.min || 0;
  const min = question.min || 0;
  const max = question.max || 100;

  return `
    <div class="engag-numeric-group">
      <button class="engag-numeric-stepper" type="button" aria-label="Decrease" ${value <= min ? 'disabled' : ''}>−</button>
      <span class="engag-numeric-value" aria-live="polite">${value}</span>
      <button class="engag-numeric-stepper" type="button" aria-label="Increase" ${value >= max ? 'disabled' : ''}>+</button>
      <input type="number" class="engag-numeric-input" value="${value}" min="${min}" max="${max}" />
    </div>
  `;
}