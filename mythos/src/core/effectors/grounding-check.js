'use strict';

// effectors/grounding-check.js — BUG-314: did a research-grounded build actually
// USE its research?
//
// THE DEFECT. The 2026-08-22 AI news digest carried a paragraph under every
// headline — "India has overtaken other APAC countries in AI adoption, with
// significant investments in AI infrastructure and talent development" — that
// exists in no search result. All four "Read more" links were href="#", so none
// of it was checkable, and the hero image was picsum.photos/seed/ai-summit with
// alt="UN Secretary-General at the Global South AI Summit": a random stock image
// presented as a photograph of a real person at a real event.
//
// WHAT WAS ALREADY IN PLACE, measured rather than assumed. researchForBuild()
// already web_fetches the top three results and already writes every result URL
// into the prompt as "N. title — url". That fetch already goes through the
// BUG-303-hardened web_fetch (main.js:488), whose guardedLookup re-validates
// every resolved address at dial time with no pooled sockets. So the sources and
// their text WERE reaching the model on any grounded build.
//
// The shipped page had none of that for one reason: researchStatus was
// 'not-required'. BUG-309 gated a from-scratch landing page as a typo fix and
// research never ran at all.
//
// WHAT WAS GENUINELY MISSING is the check this module is: with research running,
// nothing verified the artifact used it. A grounded build could cite zero of its
// sources, point every link at "#", and caption a stock photo as documentary
// evidence, and every existing gate passed it.
//
// WHY NOT IN design/verify.js. That verifier runs inside build-runner, before
// run(), and researchStatus is not computed until inside run(). A check that
// cannot know whether the build was grounded would have to apply its rules to
// ungrounded builds too, where they are false accusations — an ungrounded build
// has nothing to cite. So this is called from run(), where the answer is known.
//
// DELIBERATELY NOT A RULE: picsum.photos itself. DELIVERABLE_PREAMBLE instructs
// the model to use it ("For photographs use https://picsum.photos/seed/..."), so
// banning it would contradict the brief the same file issues. Only a placeholder
// whose ALT asserts something the spec presents as real is flagged.

// Hosts that serve arbitrary stand-in imagery. A photo from one of these is not
// evidence of anything.
var PLACEHOLDER_IMAGE_HOSTS = [
  'picsum.photos', 'placehold.co', 'via.placeholder.com', 'placekitten.com',
  'dummyimage.com', 'placeimg.com', 'loremflickr.com', 'unsplash.it',
];

// Link text that PROMISES a source. href="#" is perfectly legitimate for
// skip-links, tab controls and disclosure widgets, so the rule keys on the
// promise, not on the href alone.
var SOURCE_LINK_TEXT_RE = /\b(read (?:more|the (?:full )?story|it)|full story|source|sources|via|learn more|see more|continue reading|original article)\b/i;

var ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
var IMG_RE = /<img\b([^>]*)>/gi;
var HREF_RE = /\bhref\s*=\s*"([^"]*)"|\bhref\s*=\s*'([^']*)'/i;
var SRC_RE = /\bsrc\s*=\s*"([^"]*)"|\bsrc\s*=\s*'([^']*)'/i;
var ALT_RE = /\balt\s*=\s*"([^"]*)"|\balt\s*=\s*'([^']*)'/i;

function attr(re, s) {
  var m = re.exec(String(s || ''));
  if (!m) return '';
  return (m[1] !== undefined ? m[1] : m[2]) || '';
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Recovers the result URLs from a research brief.
//
// COUPLED, ON PURPOSE, to the format researchForBuild() emits in
// agent-actions.js: `N. <title> — <url>` per result. The alternative was
// changing that function's return shape, which is a wider change to a file
// already at its size ceiling. The coupling is not silent: the test for this
// module carries a fixture in the producer's exact format, so changing the
// producer fails the test rather than making this quietly return nothing.
function sourcesFromBrief(brief) {
  var text = String(brief == null ? '' : brief);
  if (!text) return [];
  var out = [];
  var re = /^\s*\d+\.\s.*?\s—\s(https?:\/\/\S+)\s*$/gim;
  var m;
  while ((m = re.exec(text)) !== null) {
    if (out.indexOf(m[1]) === -1) out.push(m[1]);
  }
  return out;
}

// Distinctive multi-word phrases the spec presents as fact. Used to decide
// whether an image caption is asserting real-world content. Four words minimum:
// shorter overlaps ("AI news", "dark theme") are design vocabulary, not claims.
function specPhrases(spec) {
  var words = String(spec || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter(Boolean);
  var phrases = [];
  for (var i = 0; i + 4 <= words.length; i++) {
    phrases.push(words.slice(i, i + 4).join(' '));
  }
  return phrases;
}

// html      — the artifact
// opts.spec — the clean topic the build was asked for
// opts.sources — result URLs the build was handed (from sourcesFromBrief)
//
// Returns an array of issue strings. EMPTY when there are no sources: an
// ungrounded build has nothing to cite and must never be accused of failing to.
function checkGrounding(html, opts) {
  var o = opts || {};
  var sources = Array.isArray(o.sources) ? o.sources.filter(Boolean) : [];
  var content = String(html == null ? '' : html);
  var issues = [];
  if (!sources.length) return issues;
  // Only HTML deliverables have anchors and images to audit. A grounded markdown
  // report is a legitimate output and is left alone.
  if (!/<a\b|<img\b/i.test(content)) return issues;

  // R1 — did it cite anything at all? The shipped page cited zero of four.
  var cited = sources.filter(function(u) { return content.indexOf(u) !== -1; });
  if (!cited.length) {
    issues.push('the deliverable cites none of the ' + sources.length
      + ' research sources it was given — every claim in it is unverifiable');
  }

  // R2 — links that promise a source and deliver nothing.
  var dead = [];
  var m;
  ANCHOR_RE.lastIndex = 0;
  while ((m = ANCHOR_RE.exec(content)) !== null) {
    var href = attr(HREF_RE, m[1]).trim();
    var text = stripTags(m[2]);
    if (!SOURCE_LINK_TEXT_RE.test(text)) continue;
    if (href === '' || href === '#') {
      if (dead.indexOf(text) === -1) dead.push(text);
    }
  }
  if (dead.length) {
    issues.push('these links promise a source but are href="#": '
      + dead.slice(0, 5).map(function(t) { return '"' + t + '"'; }).join(', '));
  }

  // R3 — a stand-in image captioned as real content.
  var phrases = specPhrases(o.spec);
  IMG_RE.lastIndex = 0;
  while ((m = IMG_RE.exec(content)) !== null) {
    var src = attr(SRC_RE, m[1]).toLowerCase();
    var isPlaceholder = PLACEHOLDER_IMAGE_HOSTS.some(function(h) { return src.indexOf(h) !== -1; });
    if (!isPlaceholder) continue;
    var alt = attr(ALT_RE, m[1]).toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!alt) continue;
    var asserts = phrases.some(function(p) { return alt.indexOf(p) !== -1; });
    if (asserts) {
      issues.push('a placeholder image (' + src.slice(0, 60)
        + ') is captioned as real content from the spec — a stand-in photo must not '
        + 'be presented as a picture of the story');
    }
  }

  return issues;
}

// Folds grounding findings into a review verdict, so the existing
// reject-and-retry machinery handles them: the builder is regenerated with the
// issues appended, which is exactly the right response to "you cited nothing".
//
// One call per ship path keeps agent-actions.js's diff to a single line each —
// it is at its recorded size ceiling — and keeps the pipeline and kanban paths
// from drifting, which is how the review-status defect (BUG-316) came to exist
// in two places at once.
//
// Returns `review` unchanged unless the build was grounded AND has findings.
function reviewWithGrounding(review, raw, opts) {
  var o = opts || {};
  if (o.researchStatus !== 'grounded') return review;
  var issues = checkGrounding(raw, {
    spec: o.spec,
    sources: sourcesFromBrief(o.brief),
  });
  if (!issues.length) return review;
  var prior = (review && review.issues) || [];
  return {
    verdict: 'reject',
    issues: prior.concat(issues),
    visualDescription: (review && review.visualDescription) || '',
    _visualSkipped: review && review._visualSkipped,
    _visualSkipReason: review && review._visualSkipReason,
  };
}

module.exports = {
  checkGrounding: checkGrounding,
  sourcesFromBrief: sourcesFromBrief,
  reviewWithGrounding: reviewWithGrounding,
  _PLACEHOLDER_IMAGE_HOSTS: PLACEHOLDER_IMAGE_HOSTS,
};
