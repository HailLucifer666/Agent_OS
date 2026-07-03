// hermes.js — Hermes agent chat surface
import { renderAgentChat } from './agent-chat-shared.js';

export async function render(mount) {
  return renderAgentChat(mount, {
    id: 'hermes',
    name: 'Hermes',
    accentVar: 'var(--accent-hermes)',
    description: 'Nous Research agent. Sessions, skills, kanban — and a chat line.',
    tabs: ['Chat', 'Talk', 'Hermes-Jarvis', 'Studio', 'Sessions', 'Workspace', 'MCPs', 'Manage', 'Control Room', 'Goal Mode'],
    hasProfiles: true,
    wired: true,
    provider: 'ollama',
    modelPicker: true,
  });
}
