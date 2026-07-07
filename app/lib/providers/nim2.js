// nim2.js — second NVIDIA NIM key lane (rotation partner for providers/nim.js).
// Same catalog/base URL as nim.js; a distinct key lets lib/models/chain.js keep going
// when the first key hits a rate limit instead of failing the whole NIM lane.
const { createOpenAICompatProvider } = require('./openai-compat');

const provider = createOpenAICompatProvider({
  name: 'nim2',
  baseURL: process.env.NIM_API_URL || 'https://integrate.api.nvidia.com/v1',
  apiKeyEnv: 'NIM_API_KEY_2',
  defaultModelEnv: 'NIM_MODEL',
  defaultModel: 'nvidia/llama-3.1-nemotron-70b-instruct',
  alwaysMaxTokens: true,
});

module.exports = provider;
