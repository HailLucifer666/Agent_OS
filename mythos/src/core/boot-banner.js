'use strict';

// boot-banner.js — the console boot cinematic: ANSI MYTHOS wordmark revealed
// line-by-line, a short "neural handshake" sweep, then the pretty logger
// (logger.js pretty mode) takes over rendering the 14 lifecycle steps.
// TTY-only cosmetics: disabled on pipes and under the test runner, so
// test/boot.test.js and any log-scraping consumer still see plain JSON with
// zero added latency. MYTHOS_LOG_PRETTY=force enables it on a pipe (debug),
// MYTHOS_LOG_PRETTY=false disables it everywhere.

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', brightCyan: '\x1b[96m', blue: '\x1b[34m',
  gray: '\x1b[90m', green: '\x1b[92m', white: '\x1b[97m',
};

const WORDMARK = [
  '███╗   ███╗██╗   ██╗████████╗██╗  ██╗ ██████╗ ███████╗',
  '████╗ ████║╚██╗ ██╔╝╚══██╔══╝██║  ██║██╔═══██╗██╔════╝',
  '██╔████╔██║ ╚████╔╝    ██║   ███████║██║   ██║███████╗',
  '██║╚██╔╝██║  ╚██╔╝     ██║   ██╔══██║██║   ██║╚════██║',
  '██║ ╚═╝ ██║   ██║      ██║   ██║  ██║╚██████╔╝███████║',
  '╚═╝     ╚═╝   ╚═╝      ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚══════╝',
];

// brightest at the center rows, dimmer at the edges — a cheap "glow"
const ROW_TONES = [C.cyan, C.brightCyan, C.white + C.bold, C.white + C.bold, C.brightCyan, C.cyan];

function enabled() {
  if (process.env.MYTHOS_LOG_PRETTY === 'force') return true;
  if (process.env.MYTHOS_LOG_PRETTY === 'false') return false;
  if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return false;
  return Boolean(process.stdout.isTTY);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function print({ name, port } = {}) {
  if (!enabled()) return;
  const out = process.stdout;
  out.write('\x1b[2J\x1b[H'); // clear screen, home cursor
  out.write('\n');
  for (let i = 0; i < WORDMARK.length; i++) {
    out.write('   ' + (ROW_TONES[i] || C.cyan) + WORDMARK[i] + C.reset + '\n');
    await sleep(45);
  }
  out.write('\n   ' + C.gray + '─'.repeat(56) + C.reset + '\n');
  out.write('   ' + C.brightCyan + C.bold + (name || 'MYTHOS') + C.reset
    + C.gray + '  //  PERSONAL AI OPERATING SYSTEM' + C.reset + '\n');
  out.write('   ' + C.gray + '─'.repeat(56) + C.reset + '\n\n');

  // neural handshake sweep — one line of motion before the step cascade
  const frames = ['◐', '◓', '◑', '◒'];
  const label = ' establishing neural link ';
  for (let i = 0; i < 12; i++) {
    const bar = '▰'.repeat(i + 1) + '▱'.repeat(12 - i - 1);
    out.write('\r   ' + C.cyan + frames[i % frames.length] + C.reset
      + C.dim + label + C.reset + C.brightCyan + bar + C.reset);
    await sleep(55);
  }
  out.write('\r   ' + C.green + '●' + C.reset + C.dim + label + C.reset
    + C.green + '▰'.repeat(12) + C.reset + '\n\n');
  out.write('   ' + C.gray + 'initializing entity on 127.0.0.1:' + (port || 4478) + ' ...' + C.reset + '\n\n');
}

module.exports = { print, enabled };
