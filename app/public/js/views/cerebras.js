// cerebras.js — Cerebras chat surface (fastest inference, ~1M tokens/day free).
import { renderAgentChat } from './agent-chat-shared.js';

export async function render(mount) {
  return renderAgentChat(mount, {
    id: 'cerebras',
    name: 'Cerebras',
    accentVar: 'var(--accent-cerebras)',
    description: 'Fastest inference available (~2600 tok/s). Llama 3.1 8B, Llama 4 Scout.',
    tabs: ['Chat'],
    wired: true,
  });
}
