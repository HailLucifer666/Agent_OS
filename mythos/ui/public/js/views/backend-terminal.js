// backend-terminal.js — split-screen backend live feed.
// Left pane: structured logs (info/warn/error) — the backend stdout/stderr stream.
// Right pane: API calls + brain activity (actions, brain-spend, health anomalies).
// Subscribes to WS 'log', 'action', 'brain-spend', 'health' — real-time, read-only.

import { subscribe } from '/js/ws.js';

var MAX_LINES = 300;

export async function render(mount) {
  mount.innerHTML = `
    <div class="terminal-wrap">
      <div class="terminal-pane">
        <div class="terminal-pane-header">
          <span class="terminal-pane-title mono">SYSTEM LOGS</span>
          <span class="terminal-pane-count mono" data-role="log-count">0</span>
        </div>
        <div class="terminal-scroll" data-role="log-scroll"></div>
      </div>
      <div class="terminal-divider"></div>
      <div class="terminal-pane">
        <div class="terminal-pane-header">
          <span class="terminal-pane-title mono">API CALLS</span>
          <span class="terminal-pane-count mono" data-role="api-count">0</span>
        </div>
        <div class="terminal-scroll" data-role="api-scroll"></div>
      </div>
    </div>
  `;

  // Inject styles once
  if (!document.getElementById('backend-terminal-css')) {
    var style = document.createElement('style');
    style.id = 'backend-terminal-css';
    style.textContent = `
      .terminal-wrap { display: flex; height: 100%; min-height: 400px; gap: 0; }
      .terminal-pane { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
      .terminal-divider { width: 1px; background: var(--hairline); flex-shrink: 0; }
      .terminal-pane-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 8px 14px; border-bottom: 1px solid var(--hairline);
        background: rgba(10, 16, 28, 0.6);
      }
      .terminal-pane-title { font-size: 10px; letter-spacing: 0.22em; color: var(--text-faint); }
      .terminal-pane-count { font-size: 10px; color: var(--text-dim); }
      .terminal-scroll {
        flex: 1; overflow-y: auto; padding: 6px 0; font-family: var(--font-mono);
        font-size: 11px; line-height: 1.5; scroll-behavior: smooth;
      }
      .terminal-row { display: flex; gap: 8px; padding: 2px 14px; align-items: baseline; }
      .terminal-row:hover { background: rgba(120, 200, 255, 0.04); }
      .terminal-ts { color: var(--text-faint); font-size: 10px; flex-shrink: 0; width: 64px; }
      .terminal-level {
        font-size: 9px; font-weight: 600; flex-shrink: 0; width: 38px;
        text-transform: uppercase; letter-spacing: 0.05em;
      }
      .terminal-level-info  { color: var(--text-dim); }
      .terminal-level-warn  { color: var(--status-degraded); }
      .terminal-level-error { color: var(--status-warn); }
      .terminal-level-debug { color: var(--text-faint); }
      .terminal-msg { color: var(--text); word-break: break-word; flex: 1; }
      .terminal-msg-dim { color: var(--text-dim); }
      .terminal-msg-error { color: var(--status-warn); }
      .terminal-tag {
        font-size: 9px; padding: 1px 5px; border-radius: 3px;
        border: 1px solid var(--hairline); color: var(--text-dim); flex-shrink: 0;
      }
      .terminal-tag-ok   { color: var(--status-ok); border-color: rgba(67,229,160,0.2); }
      .terminal-tag-fail { color: var(--status-warn); border-color: rgba(255,95,102,0.2); }
      .terminal-tag-spend { color: var(--accent); border-color: rgba(79,216,255,0.2); }
      .terminal-tool { color: var(--accent); flex-shrink: 0; }
      .terminal-detail { color: var(--text-dim); font-size: 10px; }
      .terminal-empty { color: var(--text-faint); padding: 20px 14px; text-align: center; font-size: 11px; }
      .terminal-scroll::-webkit-scrollbar { width: 4px; }
      .terminal-scroll::-webkit-scrollbar-track { background: transparent; }
      .terminal-scroll::-webkit-scrollbar-thumb { background: var(--hairline); border-radius: 2px; }
    `;
    document.head.appendChild(style);
  }

  var logScroll = mount.querySelector('[data-role="log-scroll"]');
  var apiScroll = mount.querySelector('[data-role="api-scroll"]');
  var logCountEl = mount.querySelector('[data-role="log-count"]');
  var apiCountEl = mount.querySelector('[data-role="api-count"]');

  var logs = [];
  var apiCalls = [];
  var logCount = 0;
  var apiCount = 0;

  function fmtTs(ts) {
    if (!ts) return '--:--:--';
    var d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
    if (isNaN(d.getTime())) return '--:--:--';
    return String(d.getHours()).padStart(2, '0') + ':' +
           String(d.getMinutes()).padStart(2, '0') + ':' +
           String(d.getSeconds()).padStart(2, '0');
  }

  function shortMsg(msg, max) {
    msg = String(msg || '');
    return msg.length > (max || 120) ? msg.slice(0, max) + '…' : msg;
  }

  function renderLogs() {
    logCountEl.textContent = logCount;
    if (!logs.length) {
      logScroll.innerHTML = '<div class="terminal-empty">Awaiting backend logs…</div>';
      return;
    }
    var html = '';
    for (var i = logs.length - 1; i >= 0; i--) {
      var l = logs[i];
      var level = l.level || 'info';
      var msgClass = level === 'error' ? 'terminal-msg terminal-msg-error' : 'terminal-msg';
      html += '<div class="terminal-row">' +
        '<span class="terminal-ts">' + fmtTs(l.ts) + '</span>' +
        '<span class="terminal-level terminal-level-' + level + '">' + level + '</span>' +
        '<span class="' + msgClass + '">' + escapeHtml(shortMsg(l.msg, 100)) + '</span>' +
      '</div>';
    }
    logScroll.innerHTML = html;
  }

  function renderApi() {
    apiCountEl.textContent = apiCount;
    if (!apiCalls.length) {
      apiScroll.innerHTML = '<div class="terminal-empty">Awaiting API activity…</div>';
      return;
    }
    var html = '';
    for (var i = apiCalls.length - 1; i >= 0; i--) {
      var c = apiCalls[i];
      html += '<div class="terminal-row">' +
        '<span class="terminal-ts">' + fmtTs(c.ts) + '</span>';
      if (c.kind === 'action') {
        var okClass = c.ok ? 'terminal-tag-ok' : 'terminal-tag-fail';
        html += '<span class="terminal-tag ' + okClass + '">' + (c.ok ? 'OK' : 'FAIL') + '</span>' +
          '<span class="terminal-tool">' + escapeHtml(c.tool || '?') + '</span>' +
          '<span class="terminal-detail">' + escapeHtml(shortMsg(c.detail, 80)) + '</span>';
      } else if (c.kind === 'brain-spend') {
        html += '<span class="terminal-tag terminal-tag-spend">BRAIN</span>' +
          '<span class="terminal-tool">' + escapeHtml(c.provider || '?') + '</span>' +
          '<span class="terminal-detail">lane:' + escapeHtml(c.lane || '?') + '</span>';
      } else if (c.kind === 'anomaly') {
        html += '<span class="terminal-tag terminal-tag-fail">ANOMALY</span>' +
          '<span class="terminal-msg-error">' + escapeHtml(shortMsg(c.msg, 80)) + '</span>';
      }
      html += '</div>';
    }
    apiScroll.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Subscribe to all backend activity streams
  var unsubs = [];

  // System logs — the backend stdout/stderr stream
  unsubs.push(subscribe(['log'], function(msg) {
    var p = msg.payload || {};
    logs.push({ ts: p.ts || Date.now(), level: p.level || 'info', msg: p.msg || '' });
    if (logs.length > MAX_LINES) logs.shift();
    logCount++;
    renderLogs();
  }));

  // Tool actions — what the cortex/voice is calling
  unsubs.push(subscribe(['action'], function(msg) {
    var p = msg.payload || {};
    apiCalls.push({ ts: Date.now(), kind: 'action', tool: p.tool, ok: p.ok, detail: p.reason || (p.result ? JSON.stringify(p.result).slice(0, 80) : '') });
    if (apiCalls.length > MAX_LINES) apiCalls.shift();
    apiCount++;
    renderApi();
  }));

  // Brain spend — which provider/lane was called
  unsubs.push(subscribe(['brain-spend'], function(msg) {
    var p = msg.payload || {};
    apiCalls.push({ ts: Date.now(), kind: 'brain-spend', provider: p.provider, lane: p.lane });
    if (apiCalls.length > MAX_LINES) apiCalls.shift();
    apiCount++;
    renderApi();
  }));

  // Health anomalies — errors and degraded states
  unsubs.push(subscribe(['health'], function(msg) {
    var p = msg.payload || {};
    if (p.anomalies && p.anomalies.length) {
      var last = p.anomalies[p.anomalies.length - 1];
      apiCalls.push({ ts: Date.now(), kind: 'anomaly', msg: (last.kind || 'anomaly') + (last.target ? ': ' + last.target : '') });
      if (apiCalls.length > MAX_LINES) apiCalls.shift();
      renderApi();
    }
  }));

  renderLogs();
  renderApi();

  return function() { unsubs.forEach(function(u) { try { u(); } catch (_) {} }); };
}
