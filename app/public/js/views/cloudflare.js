// cloudflare.js — Cloudflare Workers AI chat surface (global edge, 10K Neurons/day free).
import { renderAgentChat } from './agent-chat-shared.js';

export async function render(mount) {
  return renderAgentChat(mount, {
    id: 'cloudflare',
    name: 'Cloudflare AI',
    accentVar: 'var(--accent-cloudflare)',
    description: 'Global edge inference. Llama 3.3 70B fp8. 10,000 Neurons/day free.',
    tabs: ['Chat'],
    wired: true,
  });
}
