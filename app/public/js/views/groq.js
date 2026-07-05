// groq.js — Groq chat surface (free LPU inference).
import { renderAgentChat } from './agent-chat-shared.js';

export async function render(mount) {
  return renderAgentChat(mount, {
    id: 'groq',
    name: 'Groq',
    accentVar: 'var(--accent-groq)',
    description: 'Fastest free LPU inference. Llama 3.3 70B. ~30 RPM, ~14,400 req/day.',
    tabs: ['Chat'],
    wired: true,
  });
}
