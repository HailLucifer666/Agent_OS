// nim.js — NVIDIA NIM chat surface.
import { renderAgentChat } from './agent-chat-shared.js';

export async function render(mount) {
  return renderAgentChat(mount, {
    id: 'nim',
    name: 'NVIDIA NIM',
    accentVar: 'var(--accent-nim)',
    description: 'NVIDIA NIM agent. Llama / Nemotron inference at scale.',
    tabs: ['Chat'],
    wired: true,
  });
}
