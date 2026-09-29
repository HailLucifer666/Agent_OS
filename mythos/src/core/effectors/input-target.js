'use strict';

// effectors/input-target.js — which window a keyboard or mouse tool would put
// its input into, and whether that needs the operator (2026-09-29 audit, B2e).
//
// THE DEFECT. ui_type, send_key, click_at and their siblings sent input to
// whatever window would receive it, and nothing asked what that was. Typed text
// plus Enter RUNS in a terminal, the Run box, Start search or Explorer's address
// bar; and MYTHOS's own window holds its confirm dialog, so "tab, then space"
// reached Approve and a held call could approve itself. With a voice session
// connected, ui_type/ui_click/click_at/see_and_click auto-allow
// ("operator-present-trusted") and send_key is tier 2 — so a model steered by
// a page or a document could type a command into a terminal and press Enter
// with no prompt anywhere.
//
// THE FIX, in two places that share one classifier:
//   1. ps-automation.ps1's input gate ENFORCES: every input command is checked
//      when pc-child is about to run it, against the window that will actually
//      receive it. MYTHOS's own window is refused, always; a command window is
//      refused unless the command carries the operator's approval for that
//      exact window (pid + process start time + handle); a window it cannot
//      identify is refused. This covers every caller — tools, internal flows
//      like spotify_play's Tab/Enter, scripts — because they all end in pc-child.
//   2. This module lets the operator APPROVE: each input tool gets a prepare()
//      that asks pc-child's read-only input_target which windows the call would
//      reach (the same classifier the gate runs), and an approvalFor() the leash
//      turns into a per-call hold — before the ceiling, goal grants, session
//      grants and operator-present trust, none of which can stand in for it
//      (leash/index.js, B2a). After the operator's click, the call runs inside
//      input-approval.js's scope naming exactly the prepared command windows,
//      which is the only way an approval reaches the gate.
//
// A window that changes between the approval and the input is caught by the
// gate: the new window is not the approved one. The shapes below are what each
// tool will send; if one drifts from its tool, the PROMPT can describe the wrong
// window, but the gate still judges the real one and refuses — the drift fails
// closed. cua_click does not go through pc-child, so the same judgement runs at
// cua-driver's own door (adapters/cua-driver/index.js), with the same approval.
//
// NOT COVERED: see ps-automation.ps1's "Input gate" note — the instant between
// the SendInput-time check and the send itself; command lines inside ordinary
// programs (a browser's address bar, a file dialog, an app's own console) and
// launchers not on its lists; tabs switched inside an approved terminal window;
// an elevated window judged by pid alone. browser_* tools drive a web page
// through the DevTools protocol, not the desktop, and are outside this gate. The
// prepare step waits behind pc-child's single queue, so a slow command in front
// of it (OCR, a long ui_type) can make an input tool answer "the desktop was
// busy — try again".

const pcChild = require('../../../adapters/pc-child');
const inputApproval = require('../../../adapters/pc-child/input-approval');
const implicitTarget = require('./implicit-target');
const { verifyConsent } = require('../leash/consent');
const { PREPARE_TIMEOUT } = require('../leash/prepared');

function pidOf(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// tool -> a pc-child command whose receiving window is the one this tool's
// input will reach, as input_target needs it (it only asks WHICH window; the
// placeholder key sends nothing — input_target never acts).
//
// With a target pid, the prompt is about THAT window: ui_type and ui_click
// bring it to the front before typing (foregroundThenRetry), so the window
// that happens to be in front while the operator reads the prompt — often
// their own editor — is not where the input goes. The gate checks the real
// foreground when the input is sent, after that focus. Without a pid, the
// input goes to whatever is in front, and that is what is judged.
function toWindowOf(pid) { return pid ? { cmd: 'ui_click', pid } : { cmd: 'send_key', key: 'x' }; }
const SHAPES = {
  ui_type: (a) => toWindowOf(pidOf(a.pid) || implicitTarget.get()),
  send_key: (a) => toWindowOf(pidOf(a.pid)),
  ui_click: (a) => ({ cmd: 'ui_click', pid: pidOf(a.pid) || implicitTarget.get() || undefined, hwnd: a.hwnd }),
  click_at: (a) => ({ cmd: 'click_at', x: a.x, y: a.y }),
  right_click_at: (a) => ({ cmd: 'right_click_at', x: a.x, y: a.y }),
  scroll_at: (a) => ({ cmd: 'scroll_at', x: a.x, y: a.y }),
  drag: (a) => ({ cmd: 'drag', x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 }),
  // Its click point is found on screen later, so the call is judged by the
  // window it looks in; the gate judges the window under the point it clicks.
  see_and_click: (a) => toWindowOf(pidOf(a.pid)),
  // cua-driver clicks the pid's (or its window_id's) window, often in the
  // background — never necessarily the one in front — so with no pid there is
  // nothing true to show the operator (B2e review, 2026-09-30: judging the
  // foreground let a click reach a background HUD). cua-driver's own door
  // (adapters/cua-driver/index.js) refuses the same call.
  cua_click: (a) => (pidOf(a.pid) ? { cmd: 'ui_click', pid: pidOf(a.pid) } : null),
};
// Keystroke tools whose approved window must be brought forward before they run:
// the operator's click on Approve leaves MYTHOS's own window in front, where the
// gate would (rightly) refuse the keys.
const FOCUS_FIRST = new Set(['send_key', 'ui_type']);

async function query(shape) {
  let res;
  try {
    res = await pcChild.sendCommand({ cmd: 'input_target', target: shape });
  } catch (err) {
    return { resolved: false, reason: 'pc-child could not be asked (' + ((err && err.message) || 'no answer') + ')' };
  }
  if (!res || !res.ok || !res.result || !Array.isArray(res.result.windows)) {
    return { resolved: false, reason: String((res && res.error) || 'pc-child gave no window list') };
  }
  return { resolved: true, windows: res.result.windows };
}

function prepareFor(toolName) {
  return function prepare(args) {
    const shape = SHAPES[toolName](args || {});
    if (!shape) return Promise.resolve({ resolved: false, reason: toolName + ' needs the pid of the window it acts in, so that window can be checked' });
    return query(shape);
  };
}

function describe(w) {
  const which = Number(w.hwnd) ? '' : ' (any window of this program)';
  return (w.process ? w.process + '.exe' : 'pid ' + w.pid) + (w.title ? ', "' + w.title + '"' : '') + which;
}

// The sentences below are what the model reads (src/core/CLAUDE.md, Refusals).
function approvalFor(target) {
  if (!target || target.resolved !== true) {
    if (target && target.reason === PREPARE_TIMEOUT) {
      return { approval: 'refuse', detail: 'The desktop was busy and could not say which window this input would reach, so nothing was sent. Try again in a moment.' };
    }
    return { approval: 'refuse', detail: 'Nothing was sent: which window this input would reach could not be checked (' + ((target && target.reason) || 'unknown') + ').' };
  }
  const windows = target.windows;
  const own = windows.find((w) => w.kind === 'own');
  if (own) {
    return { approval: 'refuse', code: 'target-refused', detail: 'Nothing was sent: ' + own.role + ' is MYTHOS\'s own window (' + own.why + '). '
      + 'MYTHOS never types or clicks into itself; its prompts are the operator\'s to answer.' };
  }
  const unknown = windows.find((w) => w.kind === 'unknown');
  if (unknown) {
    return { approval: 'refuse', code: 'target-refused', detail: 'Nothing was sent: ' + unknown.role + ' could not be identified (' + unknown.why + ').' };
  }
  const commands = windows.filter((w) => w.kind === 'command');
  if (commands.length) {
    return { approval: 'required', detail: 'input into ' + commands.map((w) => describe(w) + ' — ' + w.why).join('; ') + '. Input there can run commands' };
  }
  return { approval: 'none', detail: '' };
}

function sameWindow(a, b) {
  return Number(a.pid) === Number(b.pid) && String(a.start || '') === String(b.start || '') && Number(a.hwnd || 0) === Number(b.hwnd || 0);
}

// Every refusal names its tool: an audit reader has to know which effector to
// open (effector-failure-reason-class.test.js holds every tool to that).
function refused(name, detail, extra) {
  const text = detail.indexOf(name) === 0 ? detail : name + ': ' + detail;
  return Object.assign({ ok: false, result: text }, extra || {});
}

// Wraps one tool entry. The leash path hands the effector ctx.prepared (the
// record the operator saw) and, after an approval, ctx.consent. A caller with
// no leash (an internal flow, a test) prepares nothing here: the gate in
// pc-child still judges every window, and no approval exists for it.
function guardTool(tool) {
  const name = tool.name;
  const run = tool.fn;
  const prepare = prepareFor(name);
  async function fn(args, ctx) {
    const target = ctx && ctx.prepared;
    if (!target) return run(args, ctx);
    const verdict = approvalFor(target);
    if (verdict.approval === 'refuse') return refused(name, verdict.detail);
    if (verdict.approval === 'required') {
      const consent = verifyConsent(ctx && ctx.consent, name, { target });
      if (!consent.ok) {
        return refused(name, name + ' did NOT run: this is ' + verdict.detail + ', so it needs the operator\'s approval for this one call. '
          + 'Tell the operator which window it is and ask; it runs only after they say yes.', { requiresApproval: true, reason: consent.reason });
      }
      const approved = target.windows.filter((w) => w.kind === 'command');
      return inputApproval.runApproved(approved, async () => {
        if (FOCUS_FIRST.has(name) && approved[0] && approved[0].pid) {
          // Best effort: Windows may refuse the focus change (foreground lock); then
          // the gate finds MYTHOS's window in front and refuses, which is honest.
          try { await pcChild.sendCommand({ cmd: 'focus_window', pid: approved[0].pid }); } catch (_) { /* the gate decides */ }
        }
        return run(args, ctx);
      });
    }
    return run(args, ctx);
  }
  return Object.assign({}, tool, { fn, prepare, approvalFor });
}

// effectorFromTool() passes every tool through here; only the input tools change.
function guardIfInput(tool) {
  if (!tool || !Object.prototype.hasOwnProperty.call(SHAPES, tool.name) || typeof tool.prepare === 'function') return tool;
  return guardTool(tool);
}

module.exports = { guardIfInput, approvalFor, prepareFor, SHAPES };
