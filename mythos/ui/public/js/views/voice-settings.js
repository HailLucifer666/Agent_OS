// voice-settings.js — the VOICE panel: which voice the entity speaks in.
//
// A thin adapter, on purpose. All the behaviour lives in
// /js/voice/voice-picker.js, which the first-run wizard also mounts (compact) —
// two surfaces, one component, so the wizard and the panel can never disagree
// about what this machine can speak with.
//
// Panel contract (overlay-manager.js): `export async function render(mount,
// payload)` returning a teardown fn. Same shape as mic-settings.js.
import { createVoicePicker } from '/js/voice/voice-picker.js';

export async function render(mount) {
  const picker = createVoicePicker(mount, { compact: false });
  return () => picker.dispose();
}
