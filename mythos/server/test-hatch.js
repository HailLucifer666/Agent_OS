'use strict';

// server/test-hatch.js — a deliberately locked-down way to invoke ONE tool
// against a RUNNING MYTHOS, so the packaged .exe can be verified the same way
// the dev tree is.
//
// WHY IT EXISTS. All 34 scripts/verify-*.js harnesses reach MYTHOS through
// verify-lib.js's bootMythos(), which does spawn(process.execPath, [MAIN_PATH])
// — a fresh dev-tree process. Not one of them has ever exercised the installed
// application. That gap is not academic: BUG-360 shipped an installer in which
// all 14 phone_* tools were absent, and every existing check passed. The
// operator now runs the .exe exclusively, so anything a harness cannot reach
// there is, in practice, unverified.
//
// WHY IT IS A WEBSOCKET MESSAGE AND NOT AN HTTP ROUTE. The harnesses already
// speak this protocol: verify-lib's sendUtterance() opens ws://127.0.0.1:<port>/ws
// (with ?token=), sends {type:'utterance', reqId, text} and waits for
// {type:'done', reqId}. A `command` type was already routed here and had been an
// empty three-line stub echoing its own argument since it was written. Adding an
// HTTP route instead would have meant a second authenticated surface, a second
// binding decision and a second thing to get wrong, to reach a socket the tests
// already hold open. The WS upgrade is gated by verifyClient (token + origin
// allowlist) before a single byte of this file runs.
//
// WHY NOT JUST USE `utterance`. It goes through the brain: the model chooses the
// tool, so the same request can take a different path on different runs. A
// verification harness needs to name the tool it means. This is the deterministic
// entrance, and ONLY that — it is not a faster path, not a privileged one, and
// not a way to run something the operator could not run by speaking.
//
// ── THE FOUR LOCKS, and why each is not redundant ────────────────────────────
//
//  1. OFF BY DEFAULT. MYTHOS_TEST_HATCH must be exactly '1', read from the
//     environment at call time. A packaged install sets nothing, so the hatch is
//     absent there without anyone remembering to disable it. Deliberately NOT a
//     config-schema key: schema keys can be set from config.json, which a
//     packaged install carries and an operator can be talked into editing. An
//     environment variable has to be set by whoever launched the process.
//
//  2. LOOPBACK ONLY. Not redundant with the token, and this is the lock that is
//     easiest to argue away. MYTHOS_BIND is 127.0.0.1 by default, but the
//     documented phone-node setup tells the operator to bind 0.0.0.0 and hand
//     the token to the phone — so on exactly the machines that followed the
//     documentation, "has the token" no longer implies "is sitting here".
//
//  3. THE LEASH STILL APPLIES. Every call goes through leash.check() first and a
//     T3/T4 tool still raises a confirm, refused here rather than auto-approved.
//     A test entrance that skipped the leash would be a privilege escalation
//     wearing a test's clothes, and it would also stop testing the thing that
//     matters: what the operator's own install will actually let a tool do.
//
//  4. THROUGH dispatchAction, NEVER effectors.invoke. The single execution
//     surface — audit write, episodic record, breaker check, budget debit,
//     action.completed. server/routes/media.js records what the alternative
//     costs: its raw invoke left 42 of 43 media_key calls with no outcome
//     recorded anywhere. A hatch that bypassed dispatch would verify a code path
//     that no real caller uses, which is worse than not verifying at all.
//
// WHAT THIS IS NOT. It is not a remote-control API and must not grow into one.
// It takes one tool and one args object, returns one result, and holds no state.

// The bare command echo the stub used to send. Preserved EXACTLY for the
// hatch-disabled path: the type was routed and answered long before this file
// existed, and silently changing what a disabled build replies would be a
// behaviour change smuggled in under a feature flag. Pinned by a test.
function legacyEcho(msg, send) {
  send({ type: 'done', reqId: msg.reqId, command: msg.command });
}

// True only for a socket whose peer is this machine. Node reports IPv4-mapped
// IPv6 for a dual-stack listener, so '::ffff:127.0.0.1' has to be accepted or
// the hatch is unreachable on the very default (127.0.0.1) it is meant for.
// Anything unparseable is treated as NOT loopback — an address we cannot read is
// not evidence that the caller is local.
function isLoopbackAddress(address) {
  if (!address || typeof address !== 'string') return false;
  const addr = address.replace(/^::ffff:/i, '');
  if (addr === '::1') return true;
  if (addr === 'localhost') return true;
  // The whole 127/8 block, not just 127.0.0.1 — 127.0.0.2 is equally local, and
  // a range check here beats a string compare that quietly excludes it.
  return /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(addr)
    && addr.split('.').slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
}

function hatchEnabled(env) {
  return String((env || process.env).MYTHOS_TEST_HATCH || '') === '1';
}

// Read the peer address off whichever shape the caller has. ws._socket is the
// underlying net.Socket; a plain object with remoteAddress is what tests pass.
function remoteAddressOf(socketLike) {
  if (!socketLike) return null;
  if (typeof socketLike.remoteAddress === 'string') return socketLike.remoteAddress;
  if (socketLike._socket && typeof socketLike._socket.remoteAddress === 'string') return socketLike._socket.remoteAddress;
  return null;
}

// One refusal shape for every lock, carrying `error:true` so a harness that only
// reads {type:'done'} still sees the failure rather than mistaking a refusal for
// an empty success. `say` is what the existing done-frames use for human text.
function refuse(msg, send, reason) {
  send({ type: 'done', reqId: msg.reqId, error: true, say: reason, refused: reason });
}

async function handleCommand(msg, deps) {
  const { send, leash, dispatchAction, connectionId, socket, env, logger } = deps || {};

  // Lock 1. A disabled hatch answers exactly as the old stub did — it does not
  // announce that a hatch exists.
  if (!hatchEnabled(env)) return legacyEcho(msg, send);

  // A `command` frame with no tool is not a hatch call at all; keep the old
  // behaviour rather than inventing an error for a shape that used to work.
  const tool = msg && typeof msg.tool === 'string' ? msg.tool.trim() : '';
  if (!tool) return legacyEcho(msg, send);

  // Lock 2.
  const address = remoteAddressOf(socket);
  if (!isLoopbackAddress(address)) {
    if (logger && logger.warn) logger.warn('test-hatch.refused-remote', { address: address || 'unknown', tool });
    return refuse(msg, send, 'The test hatch only answers on loopback.');
  }

  if (!leash || typeof leash.check !== 'function' || typeof dispatchAction !== 'function') {
    return refuse(msg, send, 'The test hatch is not wired on this server.');
  }

  const args = msg.args && typeof msg.args === 'object' ? msg.args : {};

  // Lock 3. Same call shape server/routes/media.js uses — leash.check owns the
  // audit write for the denial (AD-2), so a refusal here is recorded too.
  let verdict;
  try {
    verdict = leash.check({ tool, args }, { goalId: null, connectionId: connectionId || null });
  } catch (err) {
    return refuse(msg, send, 'The leash could not evaluate that: ' + (err && err.message));
  }

  if (!verdict || !verdict.allow) {
    const reason = (verdict && verdict.reason) || 'refused by the leash';
    // requireConfirm is reported, never satisfied. A confirm is a human saying
    // yes; a test harness answering on their behalf would make every T3/T4 run
    // unattended and would stop this from testing the operator's real ceiling.
    return send({
      type: 'done',
      reqId: msg.reqId,
      error: true,
      say: reason,
      refused: reason,
      requireConfirm: Boolean(verdict && verdict.requireConfirm),
      tier: verdict ? verdict.tier : undefined,
    });
  }

  // Lock 4.
  try {
    const result = await dispatchAction({ tool, args }, { tier: verdict.tier, channel: 'test-hatch' });
    send({ type: 'done', reqId: msg.reqId, tool, tier: verdict.tier, result: result });
  } catch (err) {
    send({ type: 'done', reqId: msg.reqId, error: true, tool, say: 'Dispatch failed: ' + (err && err.message) });
  }
}

module.exports = { handleCommand, isLoopbackAddress, hatchEnabled, legacyEcho };
