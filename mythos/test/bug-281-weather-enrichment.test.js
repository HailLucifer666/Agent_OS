'use strict';

// BUG-281 / BUG-285 / BUG-286 — weather asks open-meteo for a fraction of what
// it returns, and the "richer card" BUGS.md records as shipped (BUG-176) is
// three uncalled functions.
//
// Measured 2026-08-20 against the real keyless endpoint, one call, HTTP 200:
// 29.6 C actual but apparent_temperature 36.6 C. That single field is the
// difference between a blunt answer and a useful one, and it was always free.
//
// The four open-meteo forecast call sites at the time of writing:
//   src/core/effectors/from-system.js     4 fields (spoken)
//   src/core/effectors/from-dashboard.js  4 fields, twice
//   ui/public/js/widgets/kinds/weather.js 2 fields (the HUD "rich card")
// So this is NOT one enriched path and one blunt one — every path under-asks,
// and the enrichment exists only as exported-but-uncalled formatters.
//
// Fixtures in test-fixtures/open-meteo/ are CAPTURED WIRE RESPONSES, not
// hand-written: a hand-built fixture is how a guard passes while inert.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildTools } = require('../src/core/effectors/from-system');

function toolFn(tools, name) {
  return tools.find((t) => t.name === name).fn;
}

const FIXTURES = path.join(__dirname, '..', 'test-fixtures', 'open-meteo');
const RICH = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'forecast-rich.json'), 'utf8'));
const GEO_MULTI = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'geocode-london-multi.json'), 'utf8'));

// The core current-conditions set every weather path must request. Deliberately
// NOT the full field list — a path may ask for more, never for less. Keeping
// this narrow is what lets the parity guard below stay true as paths diverge
// for good reasons.
const REQUIRED_CURRENT = [
  'temperature_2m',
  'apparent_temperature',
  'weather_code',
  'relative_humidity_2m',
  'wind_speed_10m',
];

describe('BUG-281: the spoken weather effector asks for what open-meteo returns', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  function stubRich(capture) {
    global.fetch = async (url) => {
      capture.push(String(url));
      if (String(url).includes('geocoding-api')) {
        return { ok: true, json: async () => GEO_MULTI };
      }
      return { ok: true, json: async () => RICH };
    };
  }

  it('requests apparent_temperature — the feels-like reading', async () => {
    const urls = [];
    stubRich(urls);
    await toolFn(buildTools({ config: {} }), 'get_weather')({});
    const forecast = urls.find((u) => u.includes('/v1/forecast'));
    assert.ok(forecast, 'a forecast URL must have been requested');
    assert.match(forecast, /apparent_temperature/,
      'the forecast URL must request apparent_temperature');
  });

  it('requests every field in the required current set', async () => {
    const urls = [];
    stubRich(urls);
    await toolFn(buildTools({ config: {} }), 'get_weather')({});
    const forecast = urls.find((u) => u.includes('/v1/forecast'));
    const missing = REQUIRED_CURRENT.filter((f) => !forecast.includes(f));
    assert.deepEqual(missing, [], 'fields missing from the spoken forecast URL');
  });

  it('requests a daily block with timezone=auto', async () => {
    const urls = [];
    stubRich(urls);
    await toolFn(buildTools({ config: {} }), 'get_weather')({});
    const forecast = urls.find((u) => u.includes('/v1/forecast'));
    assert.match(forecast, /[?&]daily=/, 'must request a daily block');
    // timezone=auto is load-bearing, not cosmetic: without it the daily block
    // aligns to UTC and "today" is the wrong day around local midnight.
    assert.match(forecast, /[?&]timezone=auto/, 'daily data without timezone=auto misdates "today"');
  });

  it('surfaces the feels-like temperature in the spoken result', async () => {
    stubRich([]);
    const res = await toolFn(buildTools({ config: {} }), 'get_weather')({});
    assert.equal(res.ok, true);
    assert.equal(res.result.feelsLikeC, RICH.current.apparent_temperature,
      'the feels-like value must reach the spoken result, not just the URL');
  });

  it('surfaces the daily high/low and rain probability', async () => {
    stubRich([]);
    const res = await toolFn(buildTools({ config: {} }), 'get_weather')({});
    assert.equal(res.result.todayHighC, RICH.daily.temperature_2m_max[0]);
    assert.equal(res.result.todayLowC, RICH.daily.temperature_2m_min[0]);
    assert.equal(res.result.rainChancePct, RICH.daily.precipitation_probability_max[0]);
  });

  // Q2 / Stage-3: adding fields must not widen what the failure path swallows.
  // A field open-meteo omitted is not an outage.
  it('still answers when the API omits the optional new fields', async () => {
    global.fetch = async (url) => {
      if (String(url).includes('geocoding-api')) return { ok: true, json: async () => GEO_MULTI };
      return { ok: true, json: async () => ({ current: { temperature_2m: 30, weather_code: 0 } }) };
    };
    const res = await toolFn(buildTools({ config: {} }), 'get_weather')({});
    assert.equal(res.ok, true, 'a missing optional field must not read as an outage');
    assert.equal(res.result.temperatureC, 30);
  });
});

describe('BUG-285: a malformed WEATHER_LOCATION fails as a config error, not an outage', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  // Measured 2026-08-20: WEATHER_LOCATION="not-a-coordinate" parsed to NaN, went
  // out on the wire as latitude=NaN, and came back "Weather is unavailable right
  // now (forecast HTTP 400)". A typo in the operator's own config presenting as
  // a provider outage is the fallback-that-hides-breakage shape: it sends the
  // reader looking at the wrong system.
  it('names the variable instead of reporting an outage', async () => {
    let called = 0;
    global.fetch = async () => { called += 1; return { ok: false, status: 400 }; };
    const fn = buildTools({ config: { WEATHER_LOCATION: 'not-a-coordinate' } })
      .find((t) => t.name === 'get_weather').fn;
    const res = await fn({});
    assert.equal(res.ok, false);
    assert.match(res.result, /WEATHER_LOCATION/,
      'the failure must name the variable the operator has to fix');
    // Assert the mechanism, not just the string: a config error must be rejected
    // at the edge, before a request is built from a NaN coordinate.
    assert.equal(called, 0, 'no request should be made for an unparseable location');
  });

  it('still accepts a well-formed coordinate pair', async () => {
    global.fetch = async () => ({ ok: true, json: async () => RICH });
    const fn = buildTools({ config: { WEATHER_LOCATION: '51.5,-0.12' } })
      .find((t) => t.name === 'get_weather').fn;
    const res = await fn({});
    assert.equal(res.ok, true, 'a valid pair must not be caught by the new guard');
  });
});

describe('BUG-285: geocoding names which place it answered about', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  // Measured 2026-08-20: count=5&name=London returns London in the United
  // Kingdom, Canada, and three different US states. With count=1 the first hit
  // wins silently and the spoken answer names no country, so an operator asking
  // about London, Ontario is confidently told about London, England.
  it('asks for more than one candidate', async () => {
    const urls = [];
    global.fetch = async (url) => {
      urls.push(String(url));
      if (String(url).includes('geocoding-api')) return { ok: true, json: async () => GEO_MULTI };
      return { ok: true, json: async () => RICH };
    };
    await toolFn(buildTools({ config: {} }), 'get_weather')({ location: 'London' });
    const geo = urls.find((u) => u.includes('geocoding-api'));
    const count = Number((/[?&]count=(\d+)/.exec(geo) || [])[1]);
    assert.ok(count > 1, 'geocoding requested count=' + count + '; one candidate cannot be disambiguated');
  });

  it('disambiguates the label with country and region', async () => {
    global.fetch = async (url) => {
      if (String(url).includes('geocoding-api')) return { ok: true, json: async () => GEO_MULTI };
      return { ok: true, json: async () => RICH };
    };
    const res = await toolFn(buildTools({ config: {} }), 'get_weather')({ location: 'London' });
    assert.equal(res.ok, true);
    const first = GEO_MULTI.results[0];
    assert.match(res.result.location, new RegExp(first.country),
      'the spoken location must name the country, or the operator cannot tell which London answered');
  });
});

// ---------------------------------------------------------------------------
// The class assertions. BUG-281 is another recurrence of "one symptom, two
// paths, only one of them fixed" in this repo, and BUG-286 is another "shipped
// mechanism that never runs". Patching the instances is not enough; these two
// guards run on every commit.
//
// Deliberately written against extracted URL PARAMETERS and reference COUNTS,
// not line numbers or source windows: a source-shape window breaks when someone
// adds a comment, which trains readers to widen the invariant instead of fixing
// the code.
// ---------------------------------------------------------------------------

const REPO = path.join(__dirname, '..');

function readIfPresent(rel) {
  const p = path.join(REPO, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

const WEATHER_SOURCES = [
  'src/core/effectors/from-system.js',
  'src/core/effectors/from-dashboard.js',
  'ui/public/js/widgets/kinds/weather.js',
];

// Two earlier versions of this guard were wrong, and how they were wrong is the
// point of these comments:
//
//   1. Matching `current=<list>` in raw source reported wind_speed_10m as
//      "missing" from a URL that contains it, because the field list was split
//      across two concatenated strings for readability. A guard that fails on
//      formatting teaches the reader to widen the invariant.
//   2. Collapsing the concatenation fixed that and then went BLIND: hoisting the
//      field list into a named CURRENT_FIELDS constant removed the literal
//      `current=` from from-system.js entirely, so that file contributed zero
//      matches and would have passed vacuously. Its own negative control is the
//      only reason this was caught rather than shipped.
//
// So the guard no longer parses URL shapes at all. It asserts the blunt thing
// that cannot go blind: every required field NAME appears in the file's code.
// Comments are stripped first — a field named only in a comment while absent
// from the request is exactly the vacuous pass this is guarding against.
// Third correction, and this one has a prior incident in this repo: stripping
// trailing `//` comments with a regex deletes the rest of any line containing a
// URL, because `https://` matches. It blanked all three files and the negative
// control caught it — the same way a smoke test's comment stripper once blanked
// a file on `/api/*`. Whole-line comments only. Residual, accepted, and stated
// so nobody has to rediscover it: a required field named in a TRAILING comment
// on a code line would still satisfy this. The behavioural tests above assert
// the assembled URL for the spoken path, which is the path that can be executed
// here; this guard exists for the two that cannot.
function strippedCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

describe('BUG-281 parity guard: every open-meteo path asks for the same core fields', () => {
  it('no weather source omits a required current field', () => {
    const offences = [];
    for (const rel of WEATHER_SOURCES) {
      const src = readIfPresent(rel);
      if (src === null) { offences.push(rel + ': file not found'); continue; }
      const code = strippedCode(src);
      const missing = REQUIRED_CURRENT.filter((f) => !code.includes(f));
      if (missing.length) offences.push(rel + ' does not request ' + missing.join(', '));
    }
    assert.deepEqual(offences, [],
      'A weather path was enriched alone. Enrich them together or this guard fails again.');
  });

  it('the guard is reading real forecast call sites (negative control)', () => {
    // Proves the files under inspection are the weather paths, and that comment
    // stripping did not gut the source out from under the assertion above.
    for (const rel of WEATHER_SOURCES) {
      const code = strippedCode(readIfPresent(rel) || '');
      assert.match(code, /api\.open-meteo\.com\/v1\/forecast/,
        rel + ' no longer contains an open-meteo forecast URL — the guard above is inspecting the wrong file');
    }
  });
});

describe('BUG-286: the HUD weather enrichment must actually be wired', () => {
  // BUG-176 is recorded in BUGS.md as shipped — "feels-like, humidity, wind,
  // and a real 5-day min/max row". What shipped was formatConditions(),
  // formatForecast() and renderForecast(): exported or defined, called from
  // nowhere, referenced by no test, fed by a daily block the widget never
  // requests. The operator has never seen that card.
  const HUD = 'ui/public/js/widgets/kinds/weather.js';

  for (const fn of ['formatConditions', 'formatForecast', 'renderForecast']) {
    it(fn + '() has a call site', () => {
      const raw = readIfPresent(HUD);
      assert.ok(raw !== null, HUD + ' must exist');
      // Comments stripped first, and this is not defensive tidiness — mutation
      // testing caught this guard passing while the call site was deleted,
      // because the comment explaining the fix names all three functions. A
      // guard that counts its own documentation as coverage is worse than none.
      const src = strippedCode(raw);
      // Count references that are not the definition itself.
      const refs = (src.match(new RegExp('\\b' + fn + '\\b', 'g')) || []).length;
      const defs = (src.match(new RegExp('function\\s+' + fn + '\\b', 'g')) || []).length;
      assert.ok(refs - defs > 0,
        fn + ' is defined ' + defs + 'x and referenced ' + refs + 'x — an exported formatter '
        + 'with no call site is inert, and its passing unit tests read as coverage.');
    });
  }
});
