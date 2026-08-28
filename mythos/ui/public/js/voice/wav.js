// wav.js — mono PCM to a WAV byte buffer.
//
// Moved out of voice-loop.js verbatim for BUG-347, because that file sits
// EXACTLY on its file-size ratchet ceiling (1075, test/file-size-ratchet.test.js)
// and the fix could not be added there at all. This was the right thing to move:
// it is pure byte manipulation with no closure dependencies and no DOM, so
// unlike the loop around it, it can be driven under a bare `node --test`.
//
// It had never been asserted on. Every pre-roll transcription in the voice path
// is encoded here — `mergePrerollAndTranscribe` decodes the MediaRecorder blob,
// concatenates the ring-buffer pre-roll, and hands the result to this function
// before POSTing to /api/voice/transcribe. A wrong header or a wrong sample
// conversion degrades transcription accuracy rather than throwing, so it would
// have shown up as "STT is bad today" and never as a bug.
//
// WAV is used because it is the simplest uncompressed container and is
// universally decodable by Whisper.

// 44 bytes: RIFF(12) + fmt (24) + data header(8). Mono 16-bit, so two bytes per
// sample and a block align of 2.
const HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

function writeString(view, offset, str) {
  for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

export function encodeWav(samples, sampleRate) {
  var dataBytes = samples.length * BYTES_PER_SAMPLE;
  var buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  var view = new DataView(buffer);
  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(view, 8, 'WAVE');
  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);             // chunk size
  view.setUint16(20, 1, true);              // audio format = PCM
  view.setUint16(22, 1, true);              // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, BYTES_PER_SAMPLE, true);              // block align
  view.setUint16(34, 16, true);             // bits per sample
  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  // PCM samples (float32 -> int16).
  //
  // THE CLAMP IS LOAD-BEARING, not defensive. A float outside [-1,1] scaled and
  // truncated without it wraps to the OPPOSITE sign — full-scale positive audio
  // becomes full-scale negative — which is an audible click, not a quiet
  // rounding error. Concatenating two independently-normalised buffers (which is
  // exactly what the pre-roll merge does) is a realistic way to exceed 1.0.
  var offset = HEADER_BYTES;
  for (var i = 0; i < samples.length; i++, offset += BYTES_PER_SAMPLE) {
    var s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}
