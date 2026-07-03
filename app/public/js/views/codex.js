// codex.js — Codex agent chat surface
import { renderAgentChat } from './agent-chat-shared.js';

export async function render(mount) {
  return renderAgentChat(mount, {
    id: 'codex',
    name: 'Codex',
    accentVar: 'var(--accent-codex)',
    description: 'Coding agent seat for the Mastermind room.',
    tabs: ['Chat', 'Workspace', 'Sessions'],
  });
}
