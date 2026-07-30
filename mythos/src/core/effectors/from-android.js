'use strict';

// effectors/from-android.js — Task 10 (Wave 2, ADB phone bridge). Same shape
// as from-pc.js: a delegate() helper that checks the adapter's ONLINE state
// and translates its result into the ok()/fail() shape effectorFromTool
// expects — but backed by adapters/android-child (per-device queues over
// one-shot adb calls) instead of pc-child's persistent PowerShell daemon.
//
// SHIPS 13 TOOLS, NOT 14. `phone_flashlight_toggle` is deliberately NOT
// registered — the plan's own tool table concedes "no reliable stock adb
// command exists", and a tool that always fails pollutes both
// capabilities.md and the Live functionDeclarations list, where model
// accuracy degrades with tool count (AD-4). If a real capability probe ever
// exists, register it then — not before.
//
// `phone_whatsapp_send` RESOLUTION: no physical phone was available to
// live-verify a tap primitive on, and none of these 13 tools taps or types
// (phone_shell is deliberately refused below, same reasoning run_command's
// allowlist already encodes for the desktop — a raw shell tool is a de
// facto T4 bypass of the entire tier table). Rather than ship a
// resource-id-targeted phone_tap nobody can verify against a device, this
// drops the "resolved send tap" step and keeps the honest deep-link-open
// behaviour: it opens WhatsApp to the chat with the message pre-filled and
// reports exactly that — never a claimed send. See MYTHOS-IRIS-Synthesis-
// Plan.md's "Corrections this document needs" for the recorded resolution.
//
// HONEST FAILURE IS THE HARD REQUIREMENT (AD-4). phone_sms_send opens
// Messages pre-filled; it does not send. Report exactly that. Same rule for
// state changes: phone_wifi_toggle, phone_bluetooth_toggle, phone_app_launch
// and phone_app_close used to report success straight from adb's exit code,
// which on a real device is 0 whether or not anything changed — they now read
// the resulting state back and report what was observed. See the "read-back
// verification (AD-4)" block below. Those read-back paths are covered by
// mocked-adapter tests only; no physical Android device was available, so
// they are UNVERIFIED against real hardware.
//
// SECURITY NOTE ON ARGV vs REMOTE SHELL: every adb invocation here goes
// through android-child's sendCommand(), which spawns adb with an argv
// array (never `shell: true`) — so there is no LOCAL shell to inject into.
// But `adb shell <args...>` reconstructs its arguments into ONE command
// line that Android's OWN on-device shell parses, so operator-supplied
// text (phone numbers, message bodies, contact search queries) is sanitized
// to a strict allowlist charset before use, and any value that still needs
// to reach the remote shell as one token (SMS bodies, WhatsApp deep-link
// URIs) is shell-quoted for that remote shell via shQuote() below. Package
// names and phone numbers are validated against strict regexes and never
// reach shQuote at all.

const androidChild = require('../../../adapters/android-child');
const { effectorFromTool } = require('./adapter');
const { resolveSandboxed } = require('./from-computer');

function ok(result) {
  return { ok: true, result: result };
}
function fail(reason) {
  return { ok: false, result: reason };
}

// ---- input sanitization / validation ----

// POSIX single-quote for the REMOTE (on-device) shell that `adb shell`
// hands its reconstructed command line to. Never used for local spawn args.
function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

// Digits and a single leading '+' only — strips anything that could break
// out of an `sms:`/`tel:` intent URI or a remote-shell token.
function sanitizePhoneNumber(raw) {
  const cleaned = String(raw || '').replace(/[^\d+]/g, '');
  if (!/^\+?\d{3,15}$/.test(cleaned)) return null;
  return cleaned;
}

// Android package names: dot-separated identifier segments.
function isValidPackageName(pkg) {
  return typeof pkg === 'string' && /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(pkg) && pkg.length <= 200;
}

// Free-text bodies (SMS/WhatsApp messages) are capped and stripped of
// control characters, then always reach the remote shell via shQuote() —
// never raw-concatenated.
function sanitizeFreeText(raw, maxLen) {
  return String(raw == null ? '' : raw).replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, maxLen || 300);
}

// Contact search: alphanumeric + a few safe punctuation marks only. This
// value is embedded in a SQL-style `--where` selection string sent to the
// contacts ContentProvider, so it is stripped to a strict allowlist rather
// than merely shell-quoted — a raw single quote here would break out of the
// SQL string literal even though the shell layer is separately handled.
function sanitizeContactQuery(raw) {
  return String(raw || '').replace(/[^\w @.,-]/g, '').slice(0, 100);
}

// ---- device resolution ----

// Every device-scoped tool requires an explicit deviceId — never guessed,
// even with exactly one paired device, so a newly-paired second phone can
// never silently steal a command meant for the first. Security-review
// finding: this must also confirm deviceId is a REAL currently-known serial,
// not merely truthy — a stale or fabricated serial must fail loudly rather
// than reach adb (which, prior to android-child's -s-argv fix, would have
// silently run against whatever device adb defaulted to instead).
function checkDevice(deviceId) {
  const status = androidChild.getStatus();
  if (!deviceId) {
    if (!status.devices || status.devices.length === 0) {
      return fail('No Android devices connected. Run phone_list_devices, or pair one via node mythos/scripts/setup-android.js.');
    }
    return fail('Which phone — check phone_list_devices.');
  }
  const known = Array.isArray(status.devices) && status.devices.some(function(d) { return d && d.serial === deviceId; });
  if (!known) {
    return fail('Unknown device "' + deviceId + '" — check phone_list_devices for the current serial.');
  }
  return null;
}

async function delegate(serial, args, opts) {
  const status = androidChild.getStatus();
  if (status.state !== 'ONLINE') {
    return fail('Android bridge is ' + status.state + '. ' + (status.hint || 'Cannot execute phone commands.'));
  }
  const res = await androidChild.sendCommand({ serial: serial, args: args, timeoutMs: opts && opts.timeoutMs });
  if (!res.ok) return fail(res.error || 'adb command failed.');
  return ok({ stdout: res.stdout, stderr: res.stderr });
}

async function shellDelegate(serial, remoteCommand, opts) {
  const res = await delegate(serial, ['shell', remoteCommand], opts);
  if (!res.ok) return res;
  return ok({ output: Buffer.isBuffer(res.result.stdout) ? res.result.stdout.toString('utf8') : String(res.result.stdout || '') });
}

// ---- tool implementations ----

async function phone_list_devices() {
  const status = androidChild.getStatus();
  if (status.state !== 'ONLINE') {
    return fail('Android bridge is ' + status.state + '. ' + (status.hint || 'Cannot list devices.'));
  }
  return ok({ devices: status.devices });
}

async function phone_screenshot({ deviceId }) {
  const devErr = checkDevice(deviceId);
  if (devErr) return devErr;
  const res = await delegate(deviceId, ['exec-out', 'screencap', '-p']);
  if (!res.ok) return res;
  const stdout = res.result.stdout;
  if (!Buffer.isBuffer(stdout) || stdout.length === 0) return fail('No screenshot data received from the device.');
  return ok({ image: stdout.toString('base64'), format: 'png' });
}

async function phone_notifications({ deviceId }) {
  const devErr = checkDevice(deviceId);
  if (devErr) return devErr;
  return delegate(deviceId, ['shell', 'dumpsys', 'notification', '--noredact']).then(function(res) {
    if (!res.ok) return res;
    return ok({ output: Buffer.isBuffer(res.result.stdout) ? res.result.stdout.toString('utf8') : String(res.result.stdout || '') });
  });
}

async function phone_contacts_search({ deviceId, query }) {
  const devErr = checkDevice(deviceId);
  if (devErr) return devErr;
  if (!query) return fail('query is required.');
  const safeQuery = sanitizeContactQuery(query);
  if (!safeQuery) return fail('query contains no searchable characters after sanitization.');
  const where = "display_name LIKE '%" + safeQuery.replace(/'/g, '') + "%'";
  const cmd = 'content query --uri content://com.android.contacts/data --where ' + shQuote(where);
  return shellDelegate(deviceId, cmd);
}

// AD-4: opens Messages pre-filled via SENDTO — never claims delivery.
async function phone_sms_send({ deviceId, number, text }) {
  const devErr = checkDevice(deviceId);
  if (devErr) return devErr;
  const safeNumber = sanitizePhoneNumber(number);
  if (!safeNumber) return fail('A valid phone number is required.');
  const safeText = sanitizeFreeText(text, 300);
  const cmd = 'am start -a android.intent.action.SENDTO -d ' + shQuote('sms:' + safeNumber) +
    ' --es sms_body ' + shQuote(safeText);
  const res = await shellDelegate(deviceId, cmd);
  if (!res.ok) return res;
  return ok({ opened: true, sent: false, note: 'Opened Messages with the number and text pre-filled — a human tap on Send is still required. Not sent.' });
}

async function phone_call({ deviceId, number }) {
  const devErr = checkDevice(deviceId);
  if (devErr) return devErr;
  const safeNumber = sanitizePhoneNumber(number);
  if (!safeNumber) return fail('A valid phone number is required.');
  const cmd = 'am start -a android.intent.action.CALL -d ' + shQuote('tel:' + safeNumber);
  return shellDelegate(deviceId, cmd);
}

// WhatsApp resolution (b): no phone_tap primitive shipped (see file header).
// Opens the chat via wa.me deep link with the message pre-filled; a human
// tap is still required to actually send. Never claims a message was sent.
async function phone_whatsapp_send({ deviceId, number, text }) {
  const devErr = checkDevice(deviceId);
  if (devErr) return devErr;
  const safeNumber = sanitizePhoneNumber(number);
  if (!safeNumber) return fail('A valid phone number (E.164, e.g. +15551234567) is required.');
  const safeText = sanitizeFreeText(text, 300);
  const uri = 'https://wa.me/' + safeNumber.replace(/^\+/, '') + (safeText ? '?text=' + encodeURIComponent(safeText) : '');
  const cmd = 'am start -a android.intent.action.VIEW -d ' + shQuote(uri);
  const res = await shellDelegate(deviceId, cmd);
  if (!res.ok) return res;
  return ok({ opened: true, sent: false, note: 'Opened the WhatsApp chat with the message pre-filled — a human tap on Send is still required. Not sent.' });
}

function validateToggleState(state) {
  const s = String(state || '').trim().toLowerCase();
  if (s !== 'enable' && s !== 'disable') return null;
  return s;
}

// ---- read-back verification (AD-4) ----
//
// `svc wifi enable|disable`, `svc bluetooth enable|disable`, `am force-stop`
// and `monkey -p <pkg> -c LAUNCHER 1` all commonly exit 0 on a real device
// WITHOUT the requested change happening: an OEM build that ignores the
// state, a permission-restricted package, an already-in-that-state no-op, or
// monkey finding no launchable activity at all. Reporting that bare exit code
// as success is exactly the fabrication AD-4 forbids — the same reason
// phone_hotspot_toggle is labelled best-effort and phone_sms_send reports
// "opened, needs a tap" rather than "sent". So each of those four tools now
// reads the resulting state back and reports what was ACTUALLY observed.
//
// Three outcomes, and the third is the one that is easy to get wrong:
//   observed == requested  -> ok, with verified:true and the observed state
//   observed != requested  -> fail; the device itself contradicts the claim
//   nothing observable     -> ok with verified:false, dispatched:true and the
//                             unobserved field null (AD-5: unmeasured means
//                             absent, never estimated). A broken read-back is
//                             NOT evidence of failure any more than it is
//                             evidence of success, so it must not be reported
//                             as either.

// State changes land asynchronously — the framework flips the setting or
// forks the process shortly AFTER the dispatch command has already exited 0.
// A single immediate read-back would therefore fabricate FAILURES about as
// often as the bare exit code fabricated successes, so the read-back is
// retried a bounded number of times and stops at the first observation that
// matches what was asked for.
const READBACK_ATTEMPTS = 3;
const READBACK_DELAY_MS = 250;

// Fixed marker used to carry a remote command's exit code back in stdout —
// see readAppRunning() for why. Never operator-supplied; exported only so the
// tests can build read-back fixtures without duplicating the literal.
const READBACK_MARKER = '__mythos_rc';

function delay(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// readFn() -> Promise<{ verified: boolean, on?: boolean, reason?: string }>
//
// A verified observation must win over a later unreadable one: if an earlier
// attempt verifies a MISMATCH (the phone actively contradicts the request)
// and a later attempt then can't read the state at all (device drops,
// permission error), the caller must still see that mismatch — not the
// unreadable attempt's `verified:false`, which would smuggle a contradicted
// request through as "dispatched-but-unverified" instead of a real failure.
async function observeState(readFn, want) {
  let observed = { verified: false, reason: 'read-back never ran.' };
  for (let attempt = 0; attempt < READBACK_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(READBACK_DELAY_MS);
    const result = await readFn();
    if (result.verified && result.on === want) return result;
    if (result.verified || !observed.verified) observed = result;
  }
  return observed;
}

// 1/0 integer flags in Android's global settings namespace. `settings get`
// prints "null" (exit 0) for an absent key — that is unreadable, NOT off.
async function readGlobalFlag(serial, key) {
  const res = await shellDelegate(serial, 'settings get global ' + shQuote(key));
  if (!res.ok) return { verified: false, reason: 'read-back command failed: ' + String(res.result) };
  const raw = String(res.result.output || '').trim();
  if (raw === '1') return { verified: true, on: true };
  if (raw === '0') return { verified: true, on: false };
  return { verified: false, reason: 'settings global ' + key + ' returned ' + (raw ? JSON.stringify(raw) : 'nothing') };
}

// pidof answers in its EXIT CODE (0 = running, 1 = no such process), and
// `adb shell` propagates the remote exit code, which android-child turns into
// ok:false. A bare `pidof` would therefore make "the app is not running"
// indistinguishable from "the oracle broke" — and reporting the latter as the
// former is a fabricated failure. Appending a fixed `; echo <marker>=$?`
// (our own literal, no operator input, so nothing new reaches the remote
// shell unquoted) keeps the invocation exit-0 and moves the real status into
// stdout, where 127 (no pidof on this device) can be told apart from 1.
async function readAppRunning(serial, packageName) {
  const res = await shellDelegate(serial, 'pidof ' + shQuote(packageName) + '; echo ' + READBACK_MARKER + '=$?');
  if (!res.ok) return { verified: false, reason: 'read-back command failed: ' + String(res.result) };
  const output = String(res.result.output || '');
  const marker = new RegExp(READBACK_MARKER + '=(\\d+)').exec(output);
  if (!marker) return { verified: false, reason: 'read-back returned no status marker.' };
  const rc = Number(marker[1]);
  if (rc === 1) return { verified: true, on: false };
  if (rc === 0) {
    if (/\d/.test(output.slice(0, marker.index))) return { verified: true, on: true };
    return { verified: false, reason: 'pidof exited 0 but printed no pid.' };
  }
  return { verified: false, reason: 'pidof is unavailable or errored on this device (exit ' + rc + ').' };
}

function unverified(field, reason) {
  const result = { verified: false, dispatched: true };
  result[field] = null;
  result.note = 'Dispatched and adb reported no error, but the resulting state could not be read back (' +
    reason + ') — UNVERIFIED. Do not treat this as either success or failure.';
  return result;
}

async function toggleWithReadBack(deviceId, field, settingKey, svcName, s) {
  const res = await shellDelegate(deviceId, 'svc ' + svcName + ' ' + shQuote(s));
  if (!res.ok) return res;
  const want = s === 'enable';
  const observed = await observeState(function() { return readGlobalFlag(deviceId, settingKey); }, want);
  if (!observed.verified) return ok(unverified(field, observed.reason));
  if (observed.on !== want) {
    return fail('Asked to ' + s + ' ' + field + ', but the phone still reports it ' +
      (observed.on ? 'on' : 'off') + ' (' + settingKey + '=' + (observed.on ? 1 : 0) +
      ') — the change did not take effect. `svc ' + svcName + '` exits 0 even on builds that ignore it.');
  }
  const result = { verified: true, observed: settingKey + '=' + (observed.on ? 1 : 0) };
  result[field] = s;
  return ok(result);
}

async function phone_wifi_toggle({ deviceId, state }) {
  const devErr = checkDevice(deviceId);
  if (devErr) return devErr;
  const s = validateToggleState(state);
  if (!s) return fail('state must be "enable" or "disable".');
  return toggleWithReadBack(deviceId, 'wifi', 'wifi_on', 'wifi', s);
}

async function phone_bluetooth_toggle({ deviceId, state }) {
  const devErr = checkDevice(deviceId);
  if (devErr) return devErr;
  const s = validateToggleState(state);
  if (!s) return fail('state must be "enable" or "disable".');
  return toggleWithReadBack(deviceId, 'bluetooth', 'bluetooth_on', 'bluetooth', s);
}

// Best-effort: no single stock command works across all OEMs/versions —
// honest per-device failure, never a fabricated success.
async function phone_hotspot_toggle({ deviceId, state }) {
  const devErr = checkDevice(deviceId);
  if (devErr) return devErr;
  const s = validateToggleState(state);
  if (!s) return fail('state must be "enable" or "disable".');
  const cmd = s === 'enable'
    ? 'cmd wifi start-softap'
    : 'cmd wifi stop-softap';
  const res = await shellDelegate(deviceId, cmd);
  if (!res.ok) return fail('Hotspot toggle is best-effort and not supported the same way on every device: ' + res.result);
  return ok({ hotspot: s, note: 'Best-effort — no single stock command is guaranteed across OEMs/Android versions.' });
}

async function phone_app_launch({ deviceId, packageName }) {
  const devErr = checkDevice(deviceId);
  if (devErr) return devErr;
  if (!isValidPackageName(packageName)) return fail('A valid Android package name is required (e.g. com.whatsapp).');
  const cmd = 'monkey -p ' + shQuote(packageName) + ' -c android.intent.category.LAUNCHER 1';
  const res = await shellDelegate(deviceId, cmd);
  if (!res.ok) return res;
  const observed = await observeState(function() { return readAppRunning(deviceId, packageName); }, true);
  if (!observed.verified) {
    const result = unverified('launched', observed.reason);
    result.running = null;
    result.packageName = packageName;
    return ok(result);
  }
  if (observed.on !== true) {
    return fail('Dispatched a LAUNCHER intent for ' + packageName + ', but no process for it is running afterwards — ' +
      'monkey exits 0 even when the package has no launchable activity or the launch was blocked.');
  }
  return ok({ launched: packageName, running: true, verified: true });
}

async function phone_app_close({ deviceId, packageName }) {
  const devErr = checkDevice(deviceId);
  if (devErr) return devErr;
  if (!isValidPackageName(packageName)) return fail('A valid Android package name is required (e.g. com.whatsapp).');
  const res = await shellDelegate(deviceId, 'am force-stop ' + shQuote(packageName));
  if (!res.ok) return res;
  const observed = await observeState(function() { return readAppRunning(deviceId, packageName); }, false);
  if (!observed.verified) {
    const result = unverified('closed', observed.reason);
    result.running = null;
    result.packageName = packageName;
    return ok(result);
  }
  if (observed.on !== false) {
    return fail('Ran force-stop on ' + packageName + ', but a process for it is still running afterwards — ' +
      'am force-stop exits 0 even when the package is protected or immediately restarted.');
  }
  return ok({ closed: packageName, running: false, verified: true });
}

// Device-side path — not sandboxed to the PC's roots (it is the phone's own
// filesystem, and adb pull/push run over adb's binary sync protocol, never
// through `adb shell`, so it is not subject to remote-shell reinterpretation
// either). The LOCAL destination path IS sandboxed, same as from-pc.js's
// set_wallpaper.
async function phone_file_pull({ deviceId, remotePath, localPath }) {
  const devErr = checkDevice(deviceId);
  if (devErr) return devErr;
  if (!remotePath) return fail('remotePath (on the phone) is required.');
  if (!localPath) return fail('localPath (on this PC) is required.');
  const sandboxed = resolveSandboxed(localPath);
  if (!sandboxed.ok) return fail(sandboxed.reason);
  const res = await delegate(deviceId, ['pull', remotePath, sandboxed.resolved], { timeoutMs: 60000 });
  if (!res.ok) return res;
  return ok({ pulled: true, remotePath: remotePath, localPath: sandboxed.resolved });
}

async function phone_file_push({ deviceId, localPath, remotePath }) {
  const devErr = checkDevice(deviceId);
  if (devErr) return devErr;
  if (!localPath) return fail('localPath (on this PC) is required.');
  if (!remotePath) return fail('remotePath (on the phone) is required.');
  const sandboxed = resolveSandboxed(localPath);
  if (!sandboxed.ok) return fail(sandboxed.reason);
  const res = await delegate(deviceId, ['push', sandboxed.resolved, remotePath], { timeoutMs: 60000 });
  if (!res.ok) return res;
  return ok({ pushed: true, localPath: sandboxed.resolved, remotePath: remotePath });
}

// ---- tool catalog ----
// 13 tools. phone_flashlight_toggle deliberately NOT registered — see file
// header. phone_shell deliberately NOT registered — a raw shell tool would
// be a de facto T4 bypass of the entire tier table.

const TOOLS = [
  { name: 'phone_list_devices', description: 'List paired/connected Android devices with their serial, model, and authorization state.', params: {}, danger: false, fn: phone_list_devices, needs_result: true },
  { name: 'phone_screenshot', description: 'Capture a screenshot of the phone screen.', params: { deviceId: 'string - device serial from phone_list_devices' }, danger: false, fn: phone_screenshot, needs_result: true },
  { name: 'phone_notifications', description: 'Read the phone\'s current notification shade.', params: { deviceId: 'string - device serial from phone_list_devices' }, danger: false, fn: phone_notifications, needs_result: true },
  { name: 'phone_contacts_search', description: 'Search the phone\'s contacts by display name.', params: { deviceId: 'string - device serial from phone_list_devices', query: 'string - contact name to search for' }, danger: false, fn: phone_contacts_search, needs_result: true },
  { name: 'phone_sms_send', description: 'Open the Messages app pre-filled with a number and text. Does NOT send — a human tap on Send is still required.', params: { deviceId: 'string - device serial from phone_list_devices', number: 'string - recipient phone number', text: 'string - message body' }, danger: true, fn: phone_sms_send },
  { name: 'phone_call', description: 'Start a phone call to a number.', params: { deviceId: 'string - device serial from phone_list_devices', number: 'string - phone number to call' }, danger: true, fn: phone_call },
  { name: 'phone_whatsapp_send', description: 'Open WhatsApp to a chat with a number, pre-filled with text via a wa.me deep link. Does NOT send — a human tap on Send is still required.', params: { deviceId: 'string - device serial from phone_list_devices', number: 'string - recipient phone number, E.164 format preferred', text: 'string (optional) - message text to pre-fill' }, danger: true, fn: phone_whatsapp_send },
  { name: 'phone_wifi_toggle', description: 'Enable or disable WiFi on the phone, then read the state back and report what was actually observed. If the state cannot be read back, reports the command as dispatched-but-unverified rather than as success.', params: { deviceId: 'string - device serial from phone_list_devices', state: 'string - enable|disable' }, danger: false, fn: phone_wifi_toggle, needs_result: true },
  { name: 'phone_bluetooth_toggle', description: 'Enable or disable Bluetooth on the phone, then read the state back and report what was actually observed. If the state cannot be read back, reports the command as dispatched-but-unverified rather than as success.', params: { deviceId: 'string - device serial from phone_list_devices', state: 'string - enable|disable' }, danger: false, fn: phone_bluetooth_toggle, needs_result: true },
  { name: 'phone_hotspot_toggle', description: 'Best-effort enable or disable the phone\'s WiFi hotspot. Not guaranteed to work on every device — no single stock command covers all OEMs.', params: { deviceId: 'string - device serial from phone_list_devices', state: 'string - enable|disable' }, danger: false, fn: phone_hotspot_toggle },
  { name: 'phone_app_launch', description: 'Launch an app on the phone by its Android package name, then confirm a process for it is actually running. If that cannot be checked, reports the launch as dispatched-but-unverified rather than as success.', params: { deviceId: 'string - device serial from phone_list_devices', packageName: 'string - Android package name, e.g. com.whatsapp' }, danger: false, fn: phone_app_launch, needs_result: true },
  { name: 'phone_app_close', description: 'Force-stop an app on the phone by its Android package name, then confirm no process for it is left running. If that cannot be checked, reports the close as dispatched-but-unverified rather than as success.', params: { deviceId: 'string - device serial from phone_list_devices', packageName: 'string - Android package name' }, danger: false, fn: phone_app_close, needs_result: true },
  { name: 'phone_file_pull', description: 'Copy a file from the phone to this PC. Creates or OVERWRITES the destination file with phone-side content — same risk class as write_file.', params: { deviceId: 'string - device serial from phone_list_devices', remotePath: 'string - source path on the phone', localPath: 'string - destination path on this PC' }, danger: true, fn: phone_file_pull, needs_result: true },
  { name: 'phone_file_push', description: 'Copy a file from this PC to the phone.', params: { deviceId: 'string - device serial from phone_list_devices', localPath: 'string - source path on this PC', remotePath: 'string - destination path on the phone' }, danger: true, fn: phone_file_push },
];

function registerFromAndroid(hub) {
  for (let i = 0; i < TOOLS.length; i++) {
    hub.register(effectorFromTool(TOOLS[i]));
  }
  return { count: TOOLS.length };
}

module.exports = {
  registerFromAndroid: registerFromAndroid,
  TOOLS: TOOLS,
  READBACK_MARKER: READBACK_MARKER, // exported for read-back unit tests only
  phone_list_devices: phone_list_devices,
  phone_screenshot: phone_screenshot,
  phone_notifications: phone_notifications,
  phone_contacts_search: phone_contacts_search,
  phone_sms_send: phone_sms_send,
  phone_call: phone_call,
  phone_whatsapp_send: phone_whatsapp_send,
  phone_wifi_toggle: phone_wifi_toggle,
  phone_bluetooth_toggle: phone_bluetooth_toggle,
  phone_hotspot_toggle: phone_hotspot_toggle,
  phone_app_launch: phone_app_launch,
  phone_app_close: phone_app_close,
  phone_file_pull: phone_file_pull,
  phone_file_push: phone_file_push,
};
