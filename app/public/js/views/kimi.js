// kimi.js — Kimi Code agent chat surface
import { renderAgentChat } from './agent-chat-shared.js';

export async function render(mount) {
  return renderAgentChat(mount, {
    id: 'kimi',
    name: 'Kimi Code',
    accentVar: 'var(--accent-kimi)',
    description: 'Long-context coding agent seat for the Mastermind room.',
    tabs: ['Chat', 'Workspace', 'Sessions'],
  });
}
