'use strict';

// Style formatting functions
// ENGAGEMENT-SPEC section 1.2 style interface

// Voice style types
var VOICE_STYLES = {
  NEUTRAL: 'neutral',
  CONFIDENT: 'confident',
  INQUIRING: 'inquiring',
  EXPLANATORY: 'explanatory'
};

// Apply style to text
function applyStyle(text, style) {
  if (!text) return '';

  style = style || VOICE_STYLES.NEUTRAL;

  switch (style) {
    case VOICE_STYLES.CONFIDENT:
      return applyConfidentStyle(text);
    case VOICE_STYLES.INQUIRING:
      return applyInquiringStyle(text);
    case VOICE_STYLES.EXPLANATORY:
      return applyExplanatoryStyle(text);
    default:
      return text;
  }
}

function applyConfidentStyle(text) {
  // Add confident framing
  return text.replace(/^/, 'Absolutely. ');
}

function applyInquiringStyle(text) {
  // Add questioning tone
  if (!text.endsWith('?')) {
    return text + '?';
  }
  return text;
}

function applyExplanatoryStyle(text) {
  // Add explanatory framing
  return text.replace(/^/, 'Here\'s what I understand: ');
}

// Format interview question
function formatInterviewQuestion(question) {
  if (!question) return '';

  var formatted = '';

  switch (question.type) {
    case 'confirm':
      formatted = question.prompt + '\n\nOptions: Yes / No';
      break;
    case 'choice':
      formatted = question.prompt + '\n\nOptions:\n' +
        (question.options || []).map(function(o) { return '- ' + o; }).join('\n');
      break;
    case 'text':
      formatted = question.prompt + '\n\n[Text input]';
      break;
    case 'multi-select':
      formatted = question.prompt + '\n\n[Multiple selection allowed]';
      break;
    case 'numeric':
      formatted = question.prompt + ' (number)\n\n[Numeric input]';
      break;
    default:
      formatted = question.prompt;
  }

  return formatted;
}

// Format spec preview as markdown
function formatSpecPreview(markdown) {
  if (!markdown) return '';
  // Spec markdown is already formatted
  return markdown;
}

// Format completion report
function formatCompletionReport(report) {
  if (!report) return 'No report available';

  var lines = [];
  lines.push('# Engagement Completed');
  lines.push('');
  lines.push(report.markdown || 'No details provided');
  lines.push('');

  if (report.verificationSummary) {
    lines.push('## Verification Summary');
    lines.push('- Passed: ' + (report.verificationSummary.passed || 0));
    lines.push('- Failed: ' + (report.verificationSummary.failed || 0));
    lines.push('- Repaired: ' + (report.verificationSummary.repaired || 0));
  }

  return lines.join('\n');
}

module.exports = {
  applyStyle: applyStyle,
  formatInterviewQuestion: formatInterviewQuestion,
  formatSpecPreview: formatSpecPreview,
  formatCompletionReport: formatCompletionReport,
  VOICE_STYLES: VOICE_STYLES
};