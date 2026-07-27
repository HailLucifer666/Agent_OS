// nim.js — NVIDIA NIM provider (OpenAI-compatible).
// Docs: https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html
// Base URL ends at /v1. NIM requires max_tokens on many models, so alwaysMaxTokens is on.
//
// Exports a factory (createNimProvider) alongside the default 'nim' instance so a second
// key-rotation lane (was providers/nim2.js — byte-identical except name/apiKeyEnv) can be
// built from the same code instead of duplicating the file. See chain.js's `nim2`.
const { createOpenAICompatProvider } = require('./openai-compat');

function createNimProvider(name, apiKeyEnv) {
  return createOpenAICompatProvider({
    name,
    baseURL: process.env.NIM_API_URL || 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv,
    defaultModelEnv: 'NIM_MODEL',
    defaultModel: 'nvidia/llama-3.1-nemotron-70b-instruct',
    alwaysMaxTokens: true,
  });
}

const provider = createNimProvider('nim', 'NIM_API_KEY');
provider.createNimProvider = createNimProvider;

module.exports = provider;
