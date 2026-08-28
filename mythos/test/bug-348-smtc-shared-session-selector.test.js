'use strict';

// BUG-348 - media_status read ONE SMTC session, and the ticket's account of why
// that matters is wrong in three separate ways. Every correction below was
// MEASURED live on 2026-08-28 (Windows 11, PowerShell 5.1, real SMTC), not read.
//
// CORRECTION 1 - the repair plan's mechanism, already flagged in BUGS.md and now
// confirmed: the GetSessions() at ps-automation.ps1:1596 is a C# `private static`
// over Windows AUDIO sessions (IMythosSessionEnumerator, used at :1620/:1641/
// :1674/:1706). It is a different API that merely shares a name, is not callable
// from PowerShell, and is not reusable. Nothing was present-and-unused.
//
// CORRECTION 2 - the predicted COST was wrong in the operator's favour. The WinRT
// GetSessions() is SYNCHRONOUS. It is not an IAsyncOperation, so it needs no
// Await-WinRTOperation and no explicit [type] ResultType. The expensive part the
// ticket feared does not exist.
//
// CORRECTION 3 - and this is the one that changes the fix: GetCurrentSession()
// ALREADY PREFERS A PLAYING SESSION. Measured with three concurrent sessions
// arranged so the newest was Paused and an older one was Playing:
//     Spotify           = Paused
//     older synthetic   = Playing
//     newest synthetic  = Paused
//     GetCurrentSession -> the PLAYING one
// So "song playing but says paused" does NOT reproduce for the reason the ticket
// gives. Enumerating to pick the playing session changes nothing today.
//
// WHAT ACTUALLY MAKES IT SAY PAUSED, found by reading the consumers: every
// failure path in Handle-MediaStatus returned a HASHTABLE. ps-automation.ps1's
// convention is that a handler returns a hashtable for success and a BARE STRING
// for failure, and the hoisted gate before Write-Response converts only strings
// into ok:false. So "SMTC API not available", "Failed to get session manager" and
// the catch-all all shipped as ok:TRUE, server/routes/media.js:37 took its
// success branch, and the widget - which never reads `available` and never reads
// the in-payload `error` - rendered a broken SMTC as an idle player. Being unable
// to tell is not the same as knowing nothing is playing, and the dashboard could
// not tell them apart.
//
// WHY THE SELECTOR IS STILL WORTH SHIPPING: GSMTC is a thin wrapper over the
// private NowPlayingSessionManager, and Microsoft documents NO selection rule for
// GetCurrentSession() at all. Today's preference is an observation of one Windows
// build, not a contract. The selector makes the rule ours, explicit, and shared -
// Send-SmtcControl's own comment already claimed it used "the SAME SMTC session
// the media_status read path uses" while both called GetCurrentSession()
// independently. This makes that sentence true.
//
// HOW THESE TESTS WORK: the selection functions are extracted from the real
// ps-automation.ps1 by name and executed in a fresh powershell.exe against
// FABRICATED session objects. That is behavioural, not source-shape, and it is
// machine-independent - a real-SMTC test would assert on whatever happens to be
// playing and would "fail for good" on any other machine.
//
// Run: cd mythos && node --test test/bug-348-smtc-shared-session-selector.test.js

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PS_PATH = path.join(__dirname, '..', 'adapters', 'pc-child', 'ps-automation.ps1');
const PS = fs.readFileSync(PS_PATH, 'utf8');

// Slice one function out by name, bounded by the next top-level `function` -
// the dominant style for this file (bug-126-screen-read-text-stale-pid.test.js).
function bodyOf(name) {
  const start = PS.indexOf('function ' + name);
  assert.notStrictEqual(start, -1, 'function ' + name + ' must exist in ps-automation.ps1');
  const next = PS.indexOf('\nfunction ', start + 1);
  return next === -1 ? PS.slice(start) : PS.slice(start, next);
}

// The fake-session rig. A session answers GetPlaybackInfo().PlaybackStatus and
// carries a SourceAppUserModelId, which is everything the selector reads.
const RIG = `
function New-FakeSession($id, $status) {
    $o = New-Object psobject
    $o | Add-Member -MemberType NoteProperty -Name SourceAppUserModelId -Value $id
    $o | Add-Member -MemberType ScriptMethod -Name GetPlaybackInfo -Value ([scriptblock]::Create(
        '$p = New-Object psobject; $p | Add-Member -MemberType NoteProperty -Name PlaybackStatus -Value "' + $status + '"; return $p'))
    return $o
}
function New-FakeManager($sessions, $current) {
    $script:FakeSessions = $sessions
    $script:FakeCurrent = $current
    $m = New-Object psobject
    $m | Add-Member -MemberType ScriptMethod -Name GetSessions -Value { return @($script:FakeSessions) }
    $m | Add-Member -MemberType ScriptMethod -Name GetCurrentSession -Value { return $script:FakeCurrent }
    return $m
}
`;

// Run the real extracted functions plus a scenario, return trimmed stdout.
function runPs(scenario, fns) {
  const names = fns || ['Get-SmtcSessions', 'Get-SmtcPlaybackStatus', 'Get-PrimarySmtcSession', 'Get-SmtcSourceName'];
  // $ErrorActionPreference = 'Stop' is LOAD-BEARING, not hygiene. MEASURED BY
  // MUTATION: without it a fake session that `throw`s a string raises a
  // NON-terminating error, PowerShell carries on and hands back $null, and the
  // scan continues by accident — so deleting the real try/catch guards survived
  // every "survives a throw" test. A real COM failure IS terminating, so the
  // default preference made the rig strictly easier than production.
  const script = "$ErrorActionPreference = 'Stop'\n"
    + names.map(bodyOf).join('\n') + '\n' + RIG + '\n' + scenario;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-bug348-'));
  const file = path.join(dir, 'scenario.ps1');
  fs.writeFileSync(file, script, 'ascii');
  try {
    return execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { encoding: 'utf8', timeout: 120000, windowsHide: true }).trim();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

// `Write-Output ($sel.SourceAppUserModelId)` on $null prints nothing, so a
// selector that returns nothing is distinguishable from one that returns a
// session - print a sentinel rather than an empty line.
const REPORT = `
if ($sel) { Write-Output ('PICK=' + $sel.SourceAppUserModelId) } else { Write-Output 'PICK=<null>' }
`;

describe('BUG-348 - one selector, and it prefers a session that is actually playing', () => {
  it('keeps the current session when the current session is playing', () => {
    const out = runPs(`
$a = New-FakeSession 'spotify.exe' 'Playing'
$b = New-FakeSession 'chrome.exe' 'Playing'
$mgr = New-FakeManager @($a, $b) $a
$sel = Get-PrimarySmtcSession $mgr
${REPORT}`);
    assert.match(out, /PICK=spotify\.exe/,
      'when Windows already points at a playing session there is nothing to correct, and '
      + 'overriding it would move control to an app the operator did not choose');
  });

  it('refuses to rank when TWO sessions are playing, and says so', () => {
    // THE INVARIANT THIS TICKET EXISTS FOR. "First playing session wins" does not
    // deliver it: GetSessions() has no documented ordering, and the read path and
    // the control path enumerate from TWO DIFFERENT manager instances — so with
    // two playing they could pick differently AT THE SAME INSTANT, not merely
    // across time. Falling back to `current` when there is no defensible answer
    // is what makes both call sites agree by construction.
    //
    // An alphabetical tiebreak was considered and rejected: two concurrent
    // sessions were MEASURED reporting the same AppUserModelId ('powershell.exe',
    // one Playing and one Paused), so a sort looks total and is not.
    const out = runPs(`
$p1 = New-FakeSession 'spotify.exe' 'Playing'
$p2 = New-FakeSession 'chrome.exe' 'Playing'
$cur = New-FakeSession 'vlc.exe' 'Paused'
$sel = Get-PrimarySmtcSession (New-FakeManager @($p1, $p2, $cur) $cur)
${REPORT}
Write-Output ('BY=' + $script:LastSmtcSelectedBy)
Write-Output ('N=' + $script:LastSmtcPlayingCount)`);
    assert.match(out, /PICK=vlc\.exe/, 'ambiguity must keep today\'s answer, not invent one');
    assert.match(out, /BY=current-ambiguous/, 'and it must be reported, not silently resolved');
    assert.match(out, /N=2/);
  });

  it('picks the session that is playing when the current one is not', () => {
    const out = runPs(`
$a = New-FakeSession 'spotify.exe' 'Playing'
$b = New-FakeSession 'chrome.exe' 'Paused'
$mgr = New-FakeManager @($a, $b) $b
$sel = Get-PrimarySmtcSession $mgr
${REPORT}`);
    assert.match(out, /PICK=spotify\.exe/,
      'this is the ticket\'s case: a session IS playing while the one Windows names is not');
  });

  it('falls back to the current session when nothing is playing', () => {
    const out = runPs(`
$a = New-FakeSession 'spotify.exe' 'Paused'
$b = New-FakeSession 'chrome.exe' 'Stopped'
$mgr = New-FakeManager @($a, $b) $b
$sel = Get-PrimarySmtcSession $mgr
${REPORT}`);
    assert.match(out, /PICK=chrome\.exe/,
      'a paused player is still the thing the operator is looking at; reporting nothing would '
      + 'be worse than reporting it paused');
  });

  it('names WHICH rule chose the session', () => {
    // The override reports a session Windows did NOT nominate, and that is a real
    // trade rather than a free win: the operator can pick the current session by
    // hand in the media flyout, and a muted background tab that merely reports
    // Playing outranks their deliberately paused player. SMTC exposes no
    // audibility signal, so this cannot be filtered — only named.
    const out = runPs(`
$playing = New-FakeSession 'spotify.exe' 'Playing'
$paused  = New-FakeSession 'chrome.exe' 'Paused'
$sel = Get-PrimarySmtcSession (New-FakeManager @($playing, $paused) $playing)
Write-Output ('A=' + $script:LastSmtcSelectedBy)
$sel = Get-PrimarySmtcSession (New-FakeManager @($playing, $paused) $paused)
Write-Output ('B=' + $script:LastSmtcSelectedBy)
$sel = Get-PrimarySmtcSession (New-FakeManager @($paused) $paused)
Write-Output ('C=' + $script:LastSmtcSelectedBy)
$sel = Get-PrimarySmtcSession (New-FakeManager @() $null)
Write-Output ('D=' + $script:LastSmtcSelectedBy)`);
    assert.match(out, /A=current/, 'Windows nominated a playing session and we kept it');
    assert.match(out, /B=playing-override/,
      'this is the ONLY case where the fix itself can be the thing that is wrong, so it must '
      + 'be visible in the payload rather than inferred');
    assert.match(out, /C=current-idle/);
    assert.match(out, /D=none/);
  });

  it('returns null when there are no sessions at all', () => {
    const out = runPs(`
$mgr = New-FakeManager @() $null
$sel = Get-PrimarySmtcSession $mgr
${REPORT}`);
    assert.match(out, /PICK=<null>/);
  });

  it('survives a current session that is null while sessions exist', () => {
    // Microsoft documents NOTHING about this case - not that it happens, not
    // that it cannot. Every community sample null-checks it anyway, so it is
    // treated as possible rather than described as understood.
    const out = runPs(`
$a = New-FakeSession 'vlc.exe' 'Playing'
$mgr = New-FakeManager @($a) $null
$sel = Get-PrimarySmtcSession $mgr
${REPORT}`);
    assert.match(out, /PICK=vlc\.exe/);
  });

  it('treats Closed, Opened, Changing and Stopped as not-playing', () => {
    // The enum is exactly six values (Closed=0, Opened=1, Changing=2, Stopped=3,
    // Playing=4, Paused=5) and Microsoft documents each with one tautological
    // sentence. Only Playing is knowable, so only Playing wins.
    const out = runPs(`
foreach ($st in @('Closed','Opened','Changing','Stopped')) {
  $a = New-FakeSession ('other-' + $st) $st
  $b = New-FakeSession 'current.exe' 'Paused'
  $sel = Get-PrimarySmtcSession (New-FakeManager @($a, $b) $b)
  Write-Output ('other-' + $st + '=' + $sel.SourceAppUserModelId)
  $c = New-FakeSession 'current.exe' $st
  $play = New-FakeSession 'real-player.exe' 'Playing'
  $sel = Get-PrimarySmtcSession (New-FakeManager @($c, $play) $c)
  Write-Output ('current-' + $st + '=' + $sel.SourceAppUserModelId)
}`);
    for (const st of ['Closed', 'Opened', 'Changing', 'Stopped']) {
      assert.match(out, new RegExp('other-' + st + '=current\\.exe'),
        st + ' must not outrank the current session - its meaning is undocumented, and a '
        + 'ranking that promotes a state nobody can define is guessing');
      // MEASURED BY MUTATION: the first half only ever put the odd status on the
      // OTHER session, so widening the CURRENT-session check to accept Stopped
      // survived every assertion here. Both sides of the comparison need driving.
      assert.match(out, new RegExp('current-' + st + '=real-player\\.exe'),
        'a current session reporting ' + st + ' must not count as playing either');
    }
  });

  it('survives a session whose playback info throws', () => {
    const out = runPs(`
$bad = New-Object psobject
$bad | Add-Member -MemberType NoteProperty -Name SourceAppUserModelId -Value 'broken.exe'
$bad | Add-Member -MemberType ScriptMethod -Name GetPlaybackInfo -Value { throw 'COM went away' }
$good = New-FakeSession 'spotify.exe' 'Playing'
$mgr = New-FakeManager @($bad, $good) $bad
$sel = Get-PrimarySmtcSession $mgr
${REPORT}`);
    assert.match(out, /PICK=spotify\.exe/,
      'a session can disappear between the enumeration and the property read; one dead entry '
      + 'must not take down the whole read');
  });

  it('survives GetSessions() itself throwing', () => {
    const out = runPs(`
$cur = New-FakeSession 'spotify.exe' 'Paused'
$mgr = New-Object psobject
$mgr | Add-Member -MemberType ScriptMethod -Name GetSessions -Value { throw 'enumeration failed' }
$mgr | Add-Member -MemberType ScriptMethod -Name GetCurrentSession -Value ([scriptblock]::Create('return $script:FakeCurrent'))
$script:FakeCurrent = $cur
$sel = Get-PrimarySmtcSession $mgr
${REPORT}`);
    assert.match(out, /PICK=spotify\.exe/,
      'the enumeration is an improvement on GetCurrentSession(), not a replacement for it - '
      + 'if it fails we must be no worse off than before the fix');
  });
});

describe('BUG-348 - counting sessions, where the obvious way is wrong', () => {
  it('Get-SmtcSessions returns an array whose Length is the real count', () => {
    // MEASURED: $sessions.Count DOES NOT COUNT. The returned System.__ComObject
    // exposes no bindable Count, so PowerShell member-enumerates and returns
    // each element's own scalar Count - with three sessions it answered "1 1 1".
    // With exactly ONE session it answers 1, which is right by accident and is
    // why a one-session machine cannot catch this.
    const out = runPs(`
$mgr = New-FakeManager @((New-FakeSession 'a.exe' 'Paused'), (New-FakeSession 'b.exe' 'Playing'), (New-FakeSession 'c.exe' 'Stopped')) $null
Write-Output ('N=' + (Get-SmtcSessions $mgr).Length)`);
    assert.match(out, /N=3/);
  });

  it('returns an empty array, not null, when the manager throws', () => {
    const out = runPs(`
$mgr = New-Object psobject
$mgr | Add-Member -MemberType ScriptMethod -Name GetSessions -Value { throw 'nope' }
Write-Output ('N=' + (Get-SmtcSessions $mgr).Length)`);
    assert.match(out, /N=0/, 'a null here would make .Length throw at every call site');
  });

  it('returns an empty array, not null, for a null manager', () => {
    // MEASURED BY MUTATION: the `-not $mgr` branch had no test at all, so
    // changing it to `return $null` survived. Handle-MediaStatus takes .Length
    // on this result, and .Length on $null is where a null-guard that returns
    // null instead of empty actually bites.
    // MEASURED BY MUTATION: asserting .Length could not catch `return $null`,
    // because $null.Length is 0 in PowerShell 5.1. Ask what the value IS.
    const out = runPs("$r = Get-SmtcSessions $null\nWrite-Output ('NULL=' + ($null -eq $r))\nWrite-Output ('N=' + @($r).Length)");
    assert.match(out, /NULL=False/, 'an empty array, not $null - callers take .Length on it');
    assert.match(out, /N=0/);
  });
});

describe('BUG-348 - the source name a human reads', () => {
  it('maps every real AppUserModelId shape to something legible', () => {
    // MEASURED against real ids. The old expression was -replace \'^.*\\.\', \'\',
    // which is GREEDY and strips to the LAST dot, so EVERY unpackaged app
    // collapsed to the same three letters and the widget rendered "via exe".
    const cases = [
      ['SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', 'Spotify'],
      ['msedge.exe', 'msedge'],
      ['chrome.exe', 'chrome'],
      ['vlc.exe', 'vlc'],
      ['Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic', 'ZuneMusic'],
      ['com.squirrel.Spotify.Spotify', 'Spotify'],
      ['308046B0AF4A39CB.MozillaFirefox_n80bbvh6b1yt2!MozillaFirefox', 'MozillaFirefox'],
      ['foobar2000.exe', 'foobar2000'],
      ['Chrome', 'Chrome'],
    ];
    const script = cases.map(([id]) => `Write-Output (Get-SmtcSourceName '${id}')`).join('\n');
    const lines = runPs(script).split(/\r?\n/).map((l) => l.trim());
    cases.forEach(([id, want], i) => {
      assert.equal(lines[i], want, `${id} should read as "${want}", not "${lines[i]}"`);
    });
  });

  it('never answers the generic packaged ApplicationId "App"', () => {
    // A packaged id is PackageFamilyName!ApplicationId, and a large number of
    // MSIX apps ship the literal generic id "App" — so taking the half after "!"
    // unconditionally made every one of them report the same useless word. The
    // package family name, minus the publisher hash, is the readable half there.
    const out = runPs(`
foreach ($id in @('Microsoft.WindowsMediaPlayer_8wekyb3d8bbwe!App','SomeVendor.SomeApp_abc123!App')) {
  Write-Output (Get-SmtcSourceName $id)
}`);
    const lines = out.split(/\r?\n/).map((l) => l.trim());
    assert.deepEqual(lines, ['WindowsMediaPlayer', 'SomeApp']);
    assert.doesNotMatch(out, /^App$/mi);
  });

  it('never answers "exe"', () => {
    const out = runPs(`
foreach ($id in @('msedge.exe','chrome.exe','vlc.exe','powershell.exe')) { Write-Output (Get-SmtcSourceName $id) }`);
    assert.doesNotMatch(out, /^exe$/m,
      '"via exe" is what the media widget actually displayed for every browser and every '
      + 'unpackaged player');
  });

  it('returns empty for an empty id rather than inventing a name', () => {
    assert.equal(runPs("Write-Output ('[' + (Get-SmtcSourceName '') + ']')"), '[]');
  });
});

describe('BUG-348 - the wiring, and the traps it must not step in', () => {
  it('BOTH SMTC call sites go through the shared selector', () => {
    // Send-SmtcControl's own comment already CLAIMED it used "the SAME SMTC
    // session the media_status read path uses" while calling GetCurrentSession()
    // independently. Status and control diverging is itself a bug, and nothing
    // in the suite would have detected it.
    for (const fn of ['Handle-MediaStatus', 'Send-SmtcControl']) {
      assert.match(bodyOf(fn), /Get-PrimarySmtcSession/,
        fn + ' must select through the shared helper, or the two paths can act on different '
        + 'sessions');
    }
  });

  it('no SMTC call site calls GetCurrentSession() directly any more', () => {
    // Comments stripped first: three test files in this repo have already been
    // burned by a source-shape guard that a COMMENT satisfied.
    const code = PS.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
    const hits = (code.match(/GetCurrentSession\(\)/g) || []).length;
    assert.equal(hits, 1,
      'exactly one live call to GetCurrentSession() should remain, inside the shared selector; '
      + 'found ' + hits);
    assert.match(bodyOf('Get-PrimarySmtcSession'), /GetCurrentSession\(\)/);
  });

  it('never reads a member off the sessions COLLECTION', () => {
    // THE WORST TRAP MEASURED. Reading a member off the collection can poison
    // that member name for the REST OF THE RUNSPACE: every session's
    // SourceAppUserModelId then reads back as an empty string, with no error and
    // no exception. ps-automation.ps1 is spawned once at boot and lives for the
    // whole MYTHOS session, so that would silently blank the media source until
    // a restart. Properties must be read only from a single session object.
    const code = PS.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /GetSessions\(\)\s*\)?\s*\.\s*\w/,
      'a member accessed directly on GetSessions() member-enumerates and can poison the name');

    // SCOPED to the SMTC code, and the reason is this ticket's own lesson. A
    // whole-file search for `$sessions.Count` fires on ps-automation.ps1:1892,
    // which belongs to the app-VOLUME path where $sessions is an ordinary
    // PowerShell array and .Count is entirely correct. That is the same trap
    // BUGS.md already records for this ticket - the C# GetSessions() at :1596
    // merely SHARES A NAME with the WinRT one - and a guard that fell for the
    // sibling of it would have blocked a correct file.
    const smtc = ['Get-SmtcSessions', 'Get-SmtcPlaybackStatus', 'Get-PrimarySmtcSession',
      'Get-SmtcSourceName', 'Handle-MediaStatus', 'Send-SmtcControl']
      .map(bodyOf).join('\n')
      .split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(smtc, /\.\s*Count\b/,
      '.Count on an SMTC session collection does not count - it answered "1 1 1" for three '
      + 'sessions, and answers a correct-looking 1 for one, which is why a single-session '
      + 'machine cannot catch it. Use @(...).Length');
  });

  it('does not pass the synchronous GetSessions() to Await-WinRTOperation', () => {
    assert.doesNotMatch(PS, /Await-WinRTOperation[^\r\n]*GetSessions/,
      'GetSessions() is synchronous; awaiting it is the cost the ticket predicted and it does '
      + 'not exist');
  });

  it('the selector is defined before both of its callers', () => {
    // PowerShell resolves function calls at RUNTIME, so order does not break
    // execution - but the file is read top-to-bottom by humans and by every
    // source-shape guard in this suite, and a helper defined below its callers
    // is how a later edit ends up with two copies.
    const def = PS.indexOf('function Get-PrimarySmtcSession');
    assert.ok(def > 0);
    assert.ok(def < PS.indexOf('function Send-SmtcControl'));
    assert.ok(def < PS.indexOf('function Handle-MediaStatus'));
  });
});

describe('BUG-348 - a failure must not arrive dressed as an idle player', () => {
  // ps-automation.ps1's convention: a handler returns a HASHTABLE for success and
  // a BARE STRING for failure, and one hoisted gate turns a string into ok:false.
  // Handle-MediaStatus returned a hashtable on EVERY failure path, so
  // "SMTC API not available", "Failed to get session manager" and the catch-all
  // all shipped as ok:true. server/routes/media.js:37 took its success branch,
  // and the widget never reads `available` or the in-payload `error` - so a
  // broken SMTC rendered as a paused player. THAT is "says paused".
  const body = () => bodyOf('Handle-MediaStatus');

  it('returns a bare string when the SMTC API is missing', () => {
    assert.match(body(), /return 'SMTC API not available[^']*'/,
      'a hashtable here is reported as ok:true and the dashboard shows an idle player');
  });

  it('returns a bare string when the session manager cannot be obtained', () => {
    assert.match(body(), /return 'Failed to get[^']*session manager[^']*'/);
  });

  it('returns a bare string from the catch, not a hashtable', () => {
    const b = body();
    const at = b.lastIndexOf('} catch {');
    assert.ok(at > 0, 'the outer catch must still exist');
    const tail = b.slice(at);
    assert.doesNotMatch(tail, /@\{/,
      'the catch-all shipped @{ available = $true; playing = $false; error = ... } as a SUCCESS');
    assert.match(tail, /return[^\r\n]*Exception\.Message/,
      'the message must survive - a failure whose cause is dropped is worse than the failure');
  });

  // The SUCCESS payload only — `$result = @{ ... }` up to its closing brace.
  // MEASURED BY MUTATION: asserting these over the whole function passed while
  // the fields were deleted from the success payload, because the no-session
  // early return ALSO contains `available = $true` and `sessionCount`. The
  // assertion was matching a different occurrence than the one it named, which
  // is the same defect this campaign has now hit in five separate files.
  const successPayload = () => {
    const b = body();
    const at = b.indexOf('$result = @{');
    assert.ok(at > 0, 'the success payload must still be built as $result = @{');
    const end = b.indexOf('\n        }', at);
    assert.ok(end > at, 'the success payload must still close');
    return b.slice(at, end);
  };

  it('still returns available:$true on the SUCCESS path', () => {
    // scripts/verify-bug-001-spotify-play.js:147 reads `!m.result.available` as
    // its SMTC oracle. Dropping the field would make that read undefined and the
    // oracle would fail open on every run.
    assert.match(successPayload(), /available\s*=\s*\$true/);
  });

  it('builds the source name with the shared helper, not a regex', () => {
    // MEASURED BY MUTATION: testing Get-SmtcSourceName in isolation passed while
    // Handle-MediaStatus went back to the greedy `-replace '^.*\.', ''`. A helper
    // nothing calls is not a fix.
    assert.match(successPayload(), /source = Get-SmtcSourceName/);
    // CODE, not prose about code — the comment sitting above this very line
    // explains the greedy replace and therefore contains it. That is the sixth
    // time in this campaign an assertion has scored a mention as a statement.
    const code = successPayload().split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /-replace/,
      "the greedy replace is what produced 'exe' for every unpackaged app");
  });

  it('reports how many sessions were seen, and which rule chose', () => {
    // The selector picks one of several and says nothing about the others. A
    // wrong pick with no session count is indistinguishable from a right one.
    const p = successPayload();
    assert.match(p, /sessionCount = \$allSessions\.Length/,
      'a count is what makes a wrong pick diagnosable instead of invisible');
    assert.match(p, /selectedBy/,
      'and WHICH rule fired, because playing-override is the one case where this fix can '
      + 'itself be the thing that is wrong');
    assert.match(p, /sourceId/,
      'plus the raw AppUserModelId, so a wrong pick is identifiable and not merely wrong');
  });

  it('keeps the no-session case a SUCCESS, not a failure', () => {
    // Nothing playing is a true and useful answer. Turning it into ok:false
    // would make the widget show an error every time the operator is not
    // listening to anything.
    assert.match(body(), /source\s*=\s*'none'/);
  });
});

describe('BUG-348 - the widget half', () => {
  const MEDIA_JS = fs.readFileSync(
    path.join(__dirname, '..', 'ui', 'public', 'js', 'widgets', 'kinds', 'media.js'), 'utf8');

  it('does not render the no-session sentinel as a source name', () => {
    // 'none' is a TRUTHY STRING, so `m.source ? via ${m.source} : ...` printed the
    // literal text "via none" — and that is the most common state on a machine
    // with no media app open, so it was the state the operator saw most often.
    assert.match(MEDIA_JS, /m\.source !== 'none'/,
      "the sentinel must be excluded explicitly; truthiness alone treats 'none' as a name");
    assert.doesNotMatch(MEDIA_JS, /\(m\.source \? `via \$\{m\.source\}`/,
      'the raw truthiness test is what produced "via none"');
  });

  it('says "no media playing" rather than "unknown artist" when nothing is playing', () => {
    // MEASURED BY MUTATION: a bare search for the phrase survived deleting it
    // from THIS line, because the separate idle branch above already contains it.
    // Assert the fallback expression itself.
    assert.match(MEDIA_JS, /sourceName \? `via \$\{sourceName\}` : 'no media playing'/);
  });
});

describe('BUG-348 - the script still parses', () => {
  let errors = null;
  before(() => {
    const cmd = '$t=$null;$e=$null;'
      + '[void][System.Management.Automation.Language.Parser]::ParseFile('
      + "'" + PS_PATH.replace(/'/g, "''") + "',[ref]$t,[ref]$e);"
      + 'if($e){$e | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }}';
    errors = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { encoding: 'utf8', timeout: 120000, windowsHide: true }).trim();
  });

  it('reports no parse errors', () => {
    assert.equal(errors, '', 'PowerShell reported parse errors:\n' + errors);
  });

  it('has balanced braces', () => {
    const open = (PS.match(/\{/g) || []).length;
    const close = (PS.match(/\}/g) || []).length;
    assert.equal(open, close, 'brace imbalance: ' + open + ' open vs ' + close + ' close');
  });
});
