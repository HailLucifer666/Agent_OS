// openrouter-free.js — OpenRouter free-models chat surface (dozens of $0 models via one key).
import { renderAgentChat } from './agent-chat-shared.js';

export async function render(mount) {
  return renderAgentChat(mount, {
    id: 'openrouter-free',
    name: 'OpenRouter Free',
    accentVar: 'var(--accent-openrouter-free)',
    description: 'One key, dozens of $0 models. Auto-router picks a free model for you.',
    tabs: ['Chat'],
    wired: true,
  });
}
