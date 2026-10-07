'use strict';

// BUG-448 / BUG-460 — B2b-3 of the Stage 1 repair campaign (2026-09-26).
//
// "It's playing" was judged by NOTHING (the KNOWN GAP pinned in
// bug-448-460-a-claim-is-judged-by-what-it-claims.test.js). The contract (rev 8 B2): "a click
// cannot back playback without player evidence … carry target-bound player evidence into the
// claim input … if using operator confirmation as evidence, bind it to the same target and
// distinguish it from a machine observation." Operator decision 2026-09-26: "it's playing" needs
// the player's evidence.
//
// REPLAY FIRST, read-only (.cache/b2b3/playback-replay.js): 389 Live sentences about playback,
// 81 in this claim shape, 63 flat claims, each labelled by reading the turn, the player readings
// in it, and the operator's next words. Every sentence below is verbatim, with its real readings.
//
// The rule is in claim-backing.js (PLAYBACK_CLAIM, playerBacks); the readings come from
// action-semantics.js (act.player). Its correction says "not confirmed", never "did not happen":
// a browser reading is one sample a moment after the click, and three TRUE "It should be playing
// now" sentences had only a paused one.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectUnbackedClaims } = require('../src/core/voice/claim-check');
const { describeAction } = require('../src/core/voice/action-semantics');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');
const { TIER_TABLE } = require('../src/core/leash/tiers');

const row = (tool, args, result, fields) => Object.assign({ tool, ok: true, unverified: false, dispatchOk: true,
  status: 'ok', act: describeAction(tool, args || {}, result || {}) }, fields || {});
const spotify = (nowPlaying, verified, query) => row('spotify_play', { query: query || nowPlaying }, { verified: verified !== false, nowPlaying },
  verified === false ? { ok: false, unverified: true, status: 'unverified' } : null);
const status = (tool, playing, title, artist) => row(tool, {}, { playing, title, artist: artist || '', source: 'Spotify' });
const page = (playing, title, url) => row('browser_click', { ref: 'e1' }, { state: { title, url, video: { playing, currentTime: 0 } } });
const flagged = (text, acts, recent, words) => detectUnbackedClaims(text, acts || [], recent || [], { operatorText: words || '' }).map((c) => c.category);

describe('"it\'s playing" is backed by a reading of the player', () => {
  it('(p1) a true claim a player read back is not touched', () => {
    assert.deepEqual(flagged('I\'ve sent a search for "The Kid LAROI Down", and I can see Spotify is now playing "SHE DON\'T NEED TO KNOW".', [spotify("The Kid LAROI - SHE DON'T NEED TO KNOW", true, 'The Kid LAROI Down')]), [], '07-31 00:23:14');
    assert.deepEqual(flagged('Excellent, Sir — "When the Levee Breaks" is playing now, explicitly by Led Zeppelin.', [spotify('Led Zeppelin - When the Levee Breaks - 1990 Remaster')]), [], '07-31 20:31:03');
    assert.deepEqual(flagged('Right, and again, I\'ve played the wrong thing entirely — it\'s playing "Of the New Day" instead of "Russia on Ice."', [spotify('Porcupine Tree - Of the New Day', false)]), [], '07-31 20:42:12: the quote that IS playing');
    assert.deepEqual(flagged('Spotify is open already, sir, and currently playing "RATHER BE" by The Kid LAROI.', [status('spotify_status', true, 'The Kid LAROI - RATHER BE (feat. Lithe)')]), [], '08-01 21:28:19');
    assert.deepEqual(flagged("It's still playing Pritam despite my best efforts.", [], [spotify('Pritam - Leher - From “Cocktail 2”', false)]), [], '08-02 00:41:55');
    assert.deepEqual(flagged('Soft jazz is playing, Sir — the James Jackson Jazz Trio, specifically.', [spotify('James Jackson Jazz Trio - Lady in the Blue Dress', false)]), [], '07-31 20:24:29');
    assert.deepEqual(flagged('Alright Alex, it\'s playing now!', [status('spotify_status', false, 'Spotify Premium'), spotify('The Kid LAROI - RATHER BE (feat. Lithe)')]), [], '09-09 19:26:08');
  });

  it('(p2 must-keep) a false claim with no reading, or a reading of something else, is flagged', () => {
    assert.deepEqual(flagged('Spotify is showing that "THE KID LAROI - COME DOWN" is indeed playing.', [], [spotify("The Kid LAROI - SHE DON'T NEED TO KNOW")]), ['playback'], '07-31 00:26:21: the artist alone is half the title');
    assert.deepEqual(flagged('I\'ve got "Blinding Lights" playing on the dashboard for you instead, Sir.', [row('list_windows'), row('open_web', { query: 'The Weeknd', type: 'youtube' })]), ['playback'], '08-05 21:04:31');
    assert.deepEqual(flagged('It should be starting up now.', [page(false, 'lofi music - YouTube', 'https://www.youtube.com/watch?v=Gvx-DAzR-4k')]), ['playback'], '09-24 09:41:33 (BUG-462\'s 15:11:33)');
    assert.deepEqual(flagged('Playing now.', [row('browser_snapshot'), row('open_web', { query: "India's Got Latent season 2 episode 6", type: 'youtube' }, null, { ok: false, dispatchOk: false, status: 'failed' })]), ['playback'], '09-16 10:40:29');
    assert.deepEqual(flagged('"Starboy" should be starting on YouTube right about now.', [page(false, 'starboy the weeknd - YouTube', 'https://www.youtube.com/watch?v=34Na4j8AVgA')]), ['playback'], '08-05 21:14:21: a title makes "starting" about media');
    assert.deepEqual(flagged('"Starboy" should be starting right about now.', [page(false, 'starboy the weeknd - YouTube', 'https://www.youtube.com/watch?v=34Na4j8AVgA')]), ['playback'], 'the quote alone makes it media (m6 survived without this case)');
    assert.deepEqual(flagged("It's still playing Pritam despite my best efforts.", [spotify('AC/DC - Highway to Hell')]), ['playback'], 'attack: an unquoted name that is not what plays');
  });

  it('(p3) the NEWEST reading of each player decides; a pause read after a play wins', () => {
    const played = spotify('James Jackson Jazz Trio - Lady in the Blue Dress', false);
    const paused = status('media_status', false, 'Lady in the Blue Dress', 'James Jackson Jazz Trio');
    assert.deepEqual(flagged("It's playing now.", [played, paused]), ['playback'], '07-31 20:24:34: the operator paused it');
    assert.deepEqual(flagged("It's playing now.", [paused, played]), [], 'the other order');
    assert.deepEqual(flagged("It's playing now.", [paused], [played]), ['playback'], 'this turn is newer than the ledger');
    assert.deepEqual(flagged('"Highway to Hell" is still playing.', [page(false, 'YouTube', 'https://www.youtube.com/')], [spotify('AC/DC - Highway to Hell')]), [], 'a paused PAGE says nothing about Spotify');
  });

  it('(p4) the operator\'s own words back it: a statement about playing, bound to what is named', () => {
    assert.deepEqual(flagged('Excellent, Sir. Glad we got the right one playing.', [page(false, 'Lo-fi Music for Calm and Relax - YouTube', 'https://www.youtube.com/watch?v=sF80I-TQiW0')], [], 'Yes, it just play. Just play. Classic.'), [], '09-24 09:42:44');
    assert.deepEqual(flagged("Glad to hear it's playing now.", [], [], 'Yes, now now it\'s working.'), [], '09-02 08:38:06');
    assert.deepEqual(flagged("It's playing now.", [], [], 'Yes, play it.'), ['playback'], 'an instruction is not an observation');
    assert.deepEqual(flagged("It's playing now.", [], [], 'Is it playing?'), ['playback'], 'nor is a question');
    assert.deepEqual(flagged("It's playing now.", [], [], "It's not playing."), ['playback'], 'nor a denial');
    assert.deepEqual(flagged("It's playing now.", [], [], 'It was playing before you paused it.'), ['playback'], 'attack: nor the past tense');
    assert.deepEqual(flagged('"Slow It Down" is playing now.', [], [], "No, it's playing Back To Love but I asked for Slow It Down."), [], 'the operator named the title too');
    assert.deepEqual(flagged('"Russia on Ice" is playing now.', [], [], "No, it's playing Back To Love."), ['playback'], 'the operator named a DIFFERENT title');
  });

  it('(p5) a sentence that claims no playback is not judged as one', () => {
    for (const s of [
      'Is it playing now?',
      'There was a bit of trouble focusing the window, but hopefully the music is playing for you just fine.',
      "Hmm, looks like Spotify is open but nothing's playing yet, and the title doesn't show a track name.",
      "I cannot pretend it's playing or that the screen changed.",
      "I can tell you I called the tool to play it, but I shouldn't say it's playing unless I see that proof.",
      'Should be able to get that playing now.',
      'The first video should be playing momentarily, task is still active.',
      'It appears WhatsApp is playing coy, sir — launched, but there\'s no main window to be found.',
      'Most systems are playing nice, though memory use is climbing a bit.',
      "The result mentions widgets: CPU meter, weather widget, and a 'NOW PLAYING' card.",
      'A separate Brave instance should be starting up for you.',
      'I did reduce the volume earlier, Sir, setting it to twenty percent right before playback started.',
    ]) assert.deepEqual(flagged(s), [], s);
  });
});

describe('the correction, through the real adapter', () => {
  function harness(outcomes) {
    const anomalies = []; const sent = [];
    const adapter = createLiveToolAdapter({
      leash: { check: (d) => ({ allow: true, requireConfirm: false, tier: TIER_TABLE[d.tool] || 0, reason: 'within-autonomous-max' }), confirm: { create: () => 'c' } },
      dispatchAction: async (d) => outcomes[d.tool] || { ok: true, result: {} },
      bus: { emit: (type, p) => { if (type === 'health.anomaly') anomalies.push(p); } },
      logger: { warn() {}, info() {} }, connectionId: 'conn-b2b3',
      memory: { working: { tick: 1 }, episodic: { write() {} } },
      historyAppend: () => {}, reflection: null, summarizeActionsForResult,
      getLiveSession: () => ({ isOpen: () => true, sendText: (t, meta) => sent.push({ t, meta }) }), toolAckDeadlineMs: 500,
    });
    return { adapter, anomalies, sent };
  }
  const heard = (words) => ({ sendToolResponse: () => {}, userTextSoFar: words });

  it('(r1) a paused sample and "It should be starting up now": corrected as NOT CONFIRMED, never as did-not-happen', async () => {
    const h = harness({ browser_press_key: { ok: true, result: { pressed: 'k', state: { title: 'lofi music - YouTube', url: 'https://www.youtube.com/watch?v=Gvx', video: { playing: false } } } } });
    await h.adapter.handleLiveToolCalls([{ id: 'k1', name: 'browser_press_key', args: { key: 'k' } }], heard('Can you play the video please?'));
    h.adapter.onLiveTurnComplete({ userText: 'Can you play the video please?', assistantText: 'It should be starting up now.', turnId: 1 });
    assert.deepEqual(h.anomalies.filter((a) => a.kind === 'claimed-action-not-taken').map((a) => a.target), ['playback']);
    const notice = h.sent.map((s) => s.t).find((t) => /CORRECTION/.test(t));
    assert.ok(notice, 'a correction is sent');
    assert.match(notice, /nothing has observed the player playing/);
    assert.match(notice, /NOT confirmed/);
    assert.ok(!/did NOT happen/.test(notice), 'a playback claim is never corrected as "did not happen"');
    assert.ok(/media_status/.test(notice) && /browser_media_state/.test(notice), 'it names the readings to take');
  });

  it('(r2) a slow spotify_play\'s reading reaches the ledger and backs the next turn; the operator\'s words reach the checker', async () => {
    const h = harness({ spotify_play: { ok: true, result: { verified: true, nowPlaying: 'The Weeknd - Blinding Lights' } } });
    await h.adapter.handleLiveToolCalls([{ id: 's1', name: 'spotify_play', args: { query: 'Blinding Lights' } }], heard('Play Blinding Lights on Spotify please'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(h.adapter._internal.liveTurnActions.some((r) => r.act && r.act.player && r.act.player.playing), 'the late row carries the reading');
    h.adapter.onLiveTurnComplete({ userText: '', assistantText: 'On it.', turnId: 2 });
    h.adapter.onLiveTurnComplete({ userText: 'is it on', assistantText: '"Blinding Lights" is playing now.', turnId: 3 });
    assert.deepEqual(h.anomalies.filter((a) => a.kind === 'claimed-action-not-taken'), []);
    // A fresh adapter with NO reading at all: only the operator's words can back this.
    const quiet = harness({});
    quiet.adapter.onLiveTurnComplete({ userText: 'Yeah, the video is playing.', assistantText: 'Great, the video is playing now.', turnId: 1 });
    assert.deepEqual(quiet.anomalies.filter((a) => a.kind === 'claimed-action-not-taken'), [], 'the operator\'s words reached the checker');
    quiet.adapter.onLiveTurnComplete({ userText: 'What is going on?', assistantText: 'Great, the video is playing now.', turnId: 2 });
    assert.deepEqual(quiet.anomalies.filter((a) => a.kind === 'claimed-action-not-taken').map((a) => a.target), ['playback'], 'and without them it is flagged');
  });

  it('(s1) readings are read from the result\'s shape', () => {
    assert.deepEqual(describeAction('browser_click', { ref: 'e1' }, { state: { title: 'T', url: 'https://u', video: { playing: true } } }).player, { source: 'page', playing: true, what: 'T https://u' });
    assert.deepEqual(describeAction('media_status', {}, { playing: false, title: 'RATHER BE', artist: 'The Kid LAROI', source: 'Spotify' }).player, { source: 'media', playing: false, what: 'RATHER BE The Kid LAROI Spotify' });
    assert.deepEqual(describeAction('spotify_play', { query: 'x' }, { verified: false, nowPlaying: 'Pritam - Leher' }).player, { source: 'media', playing: true, what: 'Pritam - Leher' });
    assert.equal(describeAction('open_web', { type: 'youtube', query: 'x' }, { widgetType: 'newtab', renderDispatched: true }).player, undefined, 'a dashboard card reads no player');
    assert.equal(describeAction('spotify_play', { query: 'x' }, { verified: false, nowPlaying: '' }).player, undefined, 'an empty title is no reading');
  });
});

// REPLAY WITH THE FIX, 2026-09-26 (.cache/b2b2/replay2.js over B2b-2's checker, c49c8ec9): 28
// flags become 43; every one of the 15 added is `playback`, and nothing else moves.
//   6 real false claims: 07-31 00:26:21 and 00:27:28 ("COME DOWN"; Spotify read another song),
//     08-05 21:04:31 and 21:12:12 ("Blinding Lights"; "Where is it playing?"), 09-16 10:40:29
//     ("Playing now." over a failed open), 09-24 09:41:33 ("It should be starting up now").
//   6 true claims with no reading, the accepted cost, each now told "not confirmed": 07-31 20:19:54
//     and 20:20:12 (a dashboard card reads no player), 20:26:17 (the operator un-paused it),
//     08-05 21:07:25 and 21:14:21 and 09-24 09:42:32 (a paused sample right after the click).
//   3 unclear: 08-05 21:14:55, 21:16:03, 09-16 10:40:55.
//   Kept unflagged: every true claim a player read back, and 09-24 09:42:44, by the operator's words.
//
// NEGATIVE CONTROL, run 2026-09-26: B2b-2's claim-check.js, claim-backing.js, action-semantics.js
// and live-tool-adapter.js (c49c8ec9) under this file: p2, p3, p4, r1, r2 and s1 fail. p1 and p5
// pass on both, by design: with no category at all, nothing is flagged, true or not.
//
// MUTATION RECORD, run 2026-09-26 (.cache/b2b3/mutate.js). Each probe applied as an exact
// substring (matched once, verified to change the file), this file run, the source restored from
// a byte copy and checked by sha256. The driver refuses to run unless this file is GREEN first: an
// earlier run counted a probe as caught by a test that was already failing.
//   m1  there is no playback category                               -> p2, p3, p4, r1, r2
//   m2  a hedge, negation or attempt is a claim                     -> p5
//   m3  an idiom ("playing coy") is a claim                         -> p5
//   m4  a quoted label ("NOW PLAYING") is a claim                   -> p5
//   m5  "should be starting up" needs no media                      -> p5
//   m6  a quoted title does not make "starting" about media         -> p2
//   m7  any reading that says playing backs, however old            -> p3
//   m8  one player: a paused page hides a playing Spotify           -> p3
//   m9  the ledger is newer than this turn                          -> p3
//   m10 one word of a quoted title is enough                        -> p2
//   m11 an unquoted name is never checked                           -> p2
//   m12 the operator's words back nothing                           -> p4, r2
//   m13 a question from the operator backs it                       -> p4
//   m14 the operator adverb list admits "not"                       -> p4
//   m15 the operator's words are not bound to the title             -> p4
//   m16 a playback flag carries no "not confirmed" notice           -> r1
//   m17 the adapter ignores the notice                              -> r1
//   m18 the operator's words never reach the checker                -> r2
//   m19 a browser page reading is dropped                           -> s1
//   m20 an empty title counts as a reading                          -> s1
//   m21 a media reading always says playing                         -> p3, s1
//   m22 "should be playing" is not a claim                          -> p2, r1
//   m23 "I've got X playing" is not a claim                         -> p2
//   m24 a playback claim is backed by tool name                     -> p1, p3, p4, r2
//   m25 the operator's past tense backs it                          -> p4
// Three bounds came from attacking this rule, each pinned before the record: m6 survived until a
// quote-only "starting" case was added; "It was playing before you paused it" backed the claim
// until the operator pattern became present tense (m25); and after that change, a separate
// denial check in operatorSaysPlaying could no longer fire (the first m14 survived), so it was
// deleted and m14 now probes the adverb list that keeps a denial out.
