'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');

function createPipeTransport({ runtimeDir, pipeName }) {
  const events = new EventEmitter(); let child;
  events.start = () => new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('The browser extension pipe requires Windows'));
    const helper = path.join(__dirname, 'pipe-server.ps1').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-PipeName', pipeName], {
      windowsHide: true, cwd: runtimeDir, env: { ...process.env, TEMP: runtimeDir, TMP: runtimeDir, PSModuleAnalysisCachePath: path.join(runtimeDir, 'powershell-module-cache') }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '', ready = false, stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Secure browser pipe did not become ready')); }, 20000);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 2 * 1024 * 1024) { child.kill(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (!line) continue;
        let value; try { value = JSON.parse(line); } catch { continue; }
        if (value.kind === 'ready') { ready = true; clearTimeout(timer); resolve(value); }
        else if (value.kind === 'message') {
          try { events.emit('message', value.clientId, JSON.parse(Buffer.from(value.payloadBase64, 'base64').toString('utf8'))); }
          catch { events.close(value.clientId); }
        } else if (value.kind === 'fatal') child.kill();
        else events.emit(value.kind, value.clientId);
      }
    });
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => { clearTimeout(timer); if (!ready) reject(new Error('Secure pipe failed (' + code + '): ' + stderr)); events.emit('stopped'); });
  });
  events.send = (clientId, value) => {
    if (!child || !child.stdin.writable) throw new Error('Bridge transport offline');
    child.stdin.write(JSON.stringify({ clientId, payloadBase64: Buffer.from(JSON.stringify(value)).toString('base64') }) + '\n');
  };
  events.close = clientId => { if (child?.stdin.writable) child.stdin.write(JSON.stringify({ clientId, close: true }) + '\n'); };
  events.stop = () => new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    const timer = setTimeout(() => child.kill(), 1000);
    child.once('exit', () => { clearTimeout(timer); resolve(); }); child.stdin.end();
  });
  return events;
}
module.exports = { createPipeTransport };
