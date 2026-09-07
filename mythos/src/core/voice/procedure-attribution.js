'use strict';
const { isDeepStrictEqual } = require('node:util');

// BUG-358: suggestions confer no authority. They only identify exact recorded
// steps whose real outcome may update a procedure's reliability. A different
// target still passes normal dispatch, but cannot train the stored procedure.
function createProcedureAttribution() {
  const suggestions = new Map();
  return {
    record(result) {
      suggestions.clear();
      for (const suggestion of result?.suggestions || []) {
        suggestions.set(suggestion.skillRef, structuredClone(suggestion.steps));
      }
    },
    matches(ref, tool, args) {
      return typeof ref === 'string' && suggestions.get(ref)?.some(
        step => step.tool === tool && isDeepStrictEqual(step.args || {}, args));
    },
  };
}
module.exports = { createProcedureAttribution };
