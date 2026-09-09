// BUG-428: a verdict means transcription arrived, including an accepted ratio
// of zero. Keep that fact separate from echo similarity. No acoustic tuning;
// ponytail: two fields suffice until the protocol carries a hold identifier.
export function createEchoVerdictTracker() {
  return {
    transcriptSeen: false,
    echoRatio: null,
    accept(verdict) {
      if (!verdict || typeof verdict.matched !== 'boolean' || !Number.isFinite(verdict.ratio)
        || verdict.ratio < 0 || verdict.ratio > 1) return;
      this.transcriptSeen = true;
      this.echoRatio = verdict.matched ? verdict.ratio : 0;
    },
    reset() { this.transcriptSeen = false; this.echoRatio = null; },
  };
}
