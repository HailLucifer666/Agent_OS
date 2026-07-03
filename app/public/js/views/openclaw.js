// openclaw.js — OpenClaw agent chat surface
import { renderAgentChat } from './agent-chat-shared.js';

export async function render(mount) {
  return renderAgentChat(mount, {
    id: 'openclaw',
    name: 'OpenClaw',
    accentVar: 'var(--accent-openclaw)',
    description: 'Local agent gateway. Chat one-shot or open the control room.',
    tabs: ['Chat', 'Workspace', 'Sessions'],
  });
}
