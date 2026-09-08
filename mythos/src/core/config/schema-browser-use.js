'use strict';
// schema-browser-use.js — config keys for the `browser_task` tool (browser-use agent).
// Spread into SCHEMA from schema.js. A sibling module because schema.js sits at its
// file-size ceiling (test/file-size-ratchet.test.js) and the ratchet's rule is to move new
// code elsewhere, never to raise the number.
//
// "<provider>/<model>". The provider's key must be present (GOOGLE_API_KEY for google,
// GROQ_API_KEY for groq, MISTRAL_API_KEY for mistral, OPENAI_API_KEY[+OPENAI_BASE_URL] for
// openai / openai-compatible). The customer brings the key and pays for the calls. Measured
// 2026-09-08 on browser-use 0.13.10: gemini-3.6-flash and gemini-3.1-flash-lite both played
// the second YouTube result 3/3 and 1/1; a task is 4-25 model calls; Google's FREE tier is
// 20 requests/day/model, Groq's free tier caps a request at 8k tokens (a step needs ~9k).
module.exports = {
  BROWSER_USE_MODEL:          { type: 'string',  default: 'google/gemini-3.6-flash' },
  BROWSER_USE_BROWSER:        { type: 'string',  default: 'brave' },
  BROWSER_USE_MAX_STEPS:      { type: 'number',  default: 25,     min: 3,     max: 100 },
  BROWSER_USE_TIMEOUT_MS:     { type: 'number',  default: 120000, min: 10000, max: 600000 },
};
