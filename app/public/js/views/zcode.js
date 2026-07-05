// zcode.js — ZCode (Z.AI GLM) chat surface.
import { renderAgentChat } from './agent-chat-shared.js';

export async function render(mount) {
  return renderAgentChat(mount, {
    id: 'zcode',
    name: 'ZCode',
    accentVar: 'var(--accent-zcode)',
    description: 'Z.AI GLM agent. Coding, reasoning, planning.',
    tabs: ['Chat'],
    wired: true,
  });
}
