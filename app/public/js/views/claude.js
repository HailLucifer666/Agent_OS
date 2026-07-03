// claude.js — Claude agent chat surface
import { renderAgentChat } from './agent-chat-shared.js';

export async function render(mount) {
  return renderAgentChat(mount, {
    id: 'claude',
    name: 'Claude',
    accentVar: 'var(--accent-claude)',
    description: 'Direct streaming line to Claude Code. Full tool use, MCPs, plugins.',
    tabs: ['Chat', 'Workspace', 'Artifacts', 'Ultracode', 'Ant CLI', 'Agents'],
    hasUltracode: true,
    wired: true,
    provider: 'claude-cli',
  });
}
