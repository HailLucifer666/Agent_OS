// vision-trigger.js — does this utterance want MYTHOS to LOOK at something?
//
// Extracted out of voice-loop.js for the same reason pcm-resample.js was (see
// mythos/ui/CLAUDE.md): voice-loop.js needs a browser, a microphone and an
// AudioContext to import at all, so the phrase matching inside it could never be
// tested. This module is deliberately DOM-free and dependency-free, so
// node:test imports it directly — see test/vision-trigger.test.js.
//
// Why it needs to be interceptable at all: a vision question has to be answered
// with a camera frame attached, and only the client can attach one. So these
// phrases are caught before the utterance reaches the brain, exactly like
// NAV_COMMANDS.
//
// TWO-SIDED CONTRACT, and the second half is the one that breaks things:
//   1. it must catch the natural ways an operator asks MYTHOS to look, and
//   2. it must NOT swallow ordinary commands. "what's the weather" and "what is
//      the time" are questions of the same grammatical shape as "what is this",
//      and routing either of them to the vision lane would answer a weather
//      question with a description of the operator's desk.
// Every pattern is therefore anchored at the start of the utterance AND, where
// the verb alone is ambiguous, requires a deictic object (this/that/here/me) —
// the words that mean "the thing in front of the camera".
const VISION_TRIGGERS = [
  // "what do you see", "what can you see (here)", "what are you seeing"
  /^what\s+(?:do|can|could)\s+you\s+see\b/i,
  /^what\s+are\s+you\s+seeing\b/i,
  // "describe this", "describe what you see", "describe the scene/room/picture"
  /^describe\s+(?:this|that|it|what\s+you\s+see|the\s+(?:scene|room|picture|image|photo))\b/i,
  // "look at this/me/that/here", "take a look (at this)", "have a look"
  /^look\s+at\s+(?:this|that|it|me|here)\b/i,
  /^(?:take|have)\s+a\s+look\b/i,
  // "can you see this", "do you see that", "are you able to see me".
  // The deictic object is REQUIRED: "can you see if the build passed" is a
  // check, not a look, and a bare /can you see/ swallowed it.
  /^(?:can|could|do|does)\s+you\s+see\s+(?:this|that|these|those|it|me|here|anything|what)\b/i,
  /^are\s+you\s+able\s+to\s+see\s+(?:this|that|these|those|it|me|here|anything|what)\b/i,
  // "tell me what you see", "tell me what this is"
  /^tell\s+me\s+what\s+(?:you\s+see|you're\s+seeing|this\s+is|that\s+is)\b/i,
  // "what am i holding/showing/wearing/pointing at"
  /^what\s+am\s+i\s+(?:holding|showing|wearing|pointing\s+at)\b/i,
  // Deictic "what is this" only — NEVER a bare "what is ...", which is every
  // general-knowledge question the brain should answer instead.
  /^what(?:'s|\s+is|\s+are)\s+(?:this|these|that\s+thing)\b/i,
  // "check this out", "check out this"
  /^check\s+(?:this|that|it)\s+out\b/i,
  /^check\s+out\s+(?:this|that)\b/i,
];

export function isVisionQuery(text) {
  if (!text) return false;
  const t = String(text).trim();
  if (!t) return false;
  for (let i = 0; i < VISION_TRIGGERS.length; i++) {
    if (VISION_TRIGGERS[i].test(t)) return true;
  }
  return false;
}
