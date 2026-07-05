// openrouter-free.js — OpenRouter free-models provider (OpenAI-compatible).
// One key reaches dozens of genuinely-$0 models with the `:free` suffix, plus the
// `openrouter/free` auto-router that picks a free model for you.
// Docs: https://openrouter.ai/docs/guides/routing/routers/free-router
//
// Note: this is distinct from the existing openrouter.js, which targets the paid
// Mastermind seats (gemini/codex/glm). This wrapper specifically defaults to the
// free auto-router so the orchestrator/chat can use $0 models.
const { createOpenAICompatProvider } = require('./openai-compat');

const provider = createOpenAICompatProvider({
  name: 'openrouter-free',
  baseURL: process.env.OPENROUTER_FREE_API_URL || 'https://openrouter.ai/api/v1',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  defaultModelEnv: 'OPENROUTER_FREE_MODEL',
  defaultModel: 'openrouter/free',
});

module.exports = provider;
