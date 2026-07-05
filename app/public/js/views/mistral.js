// mistral.js — Mistral chat surface (free Experiment mode, non-Llama family).
import { renderAgentChat } from './agent-chat-shared.js';

export async function render(mount) {
  return renderAgentChat(mount, {
    id: 'mistral',
    name: 'Mistral',
    accentVar: 'var(--accent-mistral)',
    description: 'Mistral Small / Nemo / Codestral. Non-Llama family, ~1 req/sec free.',
    tabs: ['Chat'],
    wired: true,
  });
}
