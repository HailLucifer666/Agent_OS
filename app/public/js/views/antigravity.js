// antigravity.js — Antigravity agent chat surface
import { renderAgentChat } from './agent-chat-shared.js';

export async function render(mount) {
  return renderAgentChat(mount, {
    id: 'antigravity',
    name: 'Antigravity',
    accentVar: 'var(--accent-antigravity)',
    description: 'Reasoning-heavy agent seat for the Mastermind room.',
    tabs: ['Chat', 'Workspace', 'Sessions'],
  });
}
