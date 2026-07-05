// cloudflare.js — Cloudflare Workers AI provider (OpenAI-compatible).
// Free tier: 10,000 Neurons/day, resets 00:00 UTC. Global edge.
// Docs: https://developers.cloudflare.com/workers-ai/
//
// The base URL includes the account ID:
//   https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1
// Resolved lazily via baseURLGetter so isAvailable() reflects a missing account ID.
// Auth uses a Cloudflare API token (CLOUDFLARE_API_TOKEN), not the global API key.
const { createOpenAICompatProvider } = require('./openai-compat');

const ACCOUNT_PREFIX = 'https://api.cloudflare.com/client/v4/accounts';

function baseURLGetter() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId || !accountId.trim()) return null;
  return `${ACCOUNT_PREFIX}/${accountId.trim()}/ai/v1`;
}

const provider = createOpenAICompatProvider({
  name: 'cloudflare',
  baseURL: ACCOUNT_PREFIX, // fallback only; baseURLGetter is authoritative
  baseURLGetter,
  apiKeyEnv: 'CLOUDFLARE_API_TOKEN',
  defaultModelEnv: 'CLOUDFLARE_MODEL',
  defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
});

// Override isAvailable: requires BOTH token AND account ID.
const tokenPresent = provider.isAvailable;
provider.isAvailable = function isAvailable() {
  return Boolean(baseURLGetter()) && tokenPresent.call(this);
};

module.exports = provider;
