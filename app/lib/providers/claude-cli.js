// claude-cli.js — Claude Code CLI streaming provider (Phase 2), via child_process.
const path = require('path');
const { spawn, execFile } = require('child_process');

const APP_DIR = path.join(__dirname, '..', '..');
const MODEL_RE = /^[a-zA-Z0-9._/-]+$/;

// convId -> claude CLI session_id, so --resume keeps history server-side.
const sessions = new Map();

function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    } catch {
      // best-effort
    }
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      // best-effort
    }
  }
}

async function chat(messages, opts = {}) {
  const { onToken, signal, convId } = opts;

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  const existingSession = convId ? sessions.get(convId) : null;
  if (existingSession) {
    args.push('--resume', existingSession);
  }
  const model = process.env.CLAUDE_MODEL;
  if (model && MODEL_RE.test(model)) {
    args.push('--model', model);
  }

  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  const promptText = lastUserMessage ? lastUserMessage.content : '';

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { shell: true, cwd: APP_DIR, windowsHide: true });

    let settled = false;
    let stdoutBuf = '';
    let stderrBuf = '';
    let resultText = '';
    let accumulated = '';
    let sawResult = false;

    function cleanup() {
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    function onAbort() {
      killTree(child);
    }
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort);
      }
    }

    child.stdin.write(promptText);
    child.stdin.end();

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }

        if (evt.type === 'system' && evt.session_id && convId) {
          sessions.set(convId, evt.session_id);
        }

        if (evt.type === 'stream_event') {
          const delta = evt.event?.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            accumulated += delta.text;
            if (onToken) onToken(delta.text);
          }
        }

        if (evt.type === 'result') {
          sawResult = true;
          resultText = evt.result != null ? String(evt.result) : accumulated;
          if (evt.session_id && convId) sessions.set(convId, evt.session_id);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`claude cli failed to start: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal && signal.aborted) {
        resolve(sawResult ? resultText : accumulated);
        return;
      }
      if (code !== 0) {
        const tail = stderrBuf.trim().slice(-800) || `exit code ${code}`;
        reject(new Error(`claude cli exited with error: ${tail}`));
        return;
      }
      resolve(sawResult ? resultText : accumulated);
    });
  });
}

module.exports = { chat };
