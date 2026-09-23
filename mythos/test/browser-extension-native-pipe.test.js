'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { createPipeTransport } = require('../adapters/browser-extension/transport');
const { encodeNativeMessage, createNativeDecoder } = require('./fixtures/browser-native-protocol');
const { tempVaultDir, cleanupVaultDir } = require('./helpers');

test('native framing handles split unicode frames and refuses oversize declarations', () => {
  const values = [], decode = createNativeDecoder(x => values.push(x)), bytes = encodeNativeMessage({ text: 'বাংলা ⚠️' });
  for (const byte of bytes) decode(Buffer.from([byte])); assert.deepEqual(values, [{ text: 'বাংলা ⚠️' }]);
  assert.throws(() => createNativeDecoder(() => {})(Buffer.from([255,255,255,255])), /size/);
});
test('actual Windows pipe has protected owner-only allow DACL, rejects anonymous OS token, and carries bidirectional JSON', { skip: process.platform !== 'win32' }, async t => {
  const dir = tempVaultDir(), pipeName = 'mythos-pipe-test-' + process.pid + '-' + Date.now();
  const transport = createPipeTransport({ runtimeDir: path.resolve(dir), pipeName }); let socket;
  t.after(async () => { socket?.destroy(); await transport.stop(); cleanupVaultDir(dir); });
  const proof = await transport.start();
  assert.match(proof.sid, /^S-1-5-21-/); assert.match(proof.sddl, /D:P/, proof.sddl);
  // SDDL writes some account SIDs as ALIASES: the built-in administrator (RID 500)
  // comes out as `LA`, not S-1-5-21-…-500. This account (RID 1001) is spelled in
  // full, so a literal-SID match passed here and failed on CI run 35856005319
  // (2026-09-23), whose runner account is an administrator. Ask Windows how IT
  // spells this SID and require exactly that — the owner-only property is the same.
  const ownerForm = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(New-Object System.Security.AccessControl.RawSecurityDescriptor ('O:${proof.sid}')).GetSddlForm('Owner')`],
    { windowsHide: true, encoding: 'utf8', timeout: 15000 }).trim().replace(/^O:/, '');
  assert.ok(ownerForm === proof.sid || /^[A-Z]{2}$/.test(ownerForm), 'unexpected SDDL spelling of the owner: ' + ownerForm);
  assert.ok(proof.sddl.includes('(A;;0x1f019f;;;' + ownerForm + ')'), 'the one allow ACE must name this account; sddl=' + proof.sddl);
  assert.equal((proof.sddl.match(/\(A;/g) || []).length, 1, 'no Everyone/Users/Authenticated Users allow ACE; sddl=' + proof.sddl);
  assert.match(proof.sddl, /\(D;;0x1f019f;;;NU\)/, 'network token explicitly denied');
  const script = `$ProgressPreference='SilentlyContinue'; Add-Type -TypeDefinition @'
using System; using System.IO.Pipes; using System.Runtime.InteropServices;
public static class AnonymousPipeProbe {
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentThread();
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool ImpersonateAnonymousToken(IntPtr thread);
 [DllImport("advapi32.dll")] static extern bool RevertToSelf();
 public static string Run(string name) {
  if (!ImpersonateAnonymousToken(GetCurrentThread())) throw new Exception("impersonation failed");
  try { using (var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut)) { pipe.Connect(2000); return "UNEXPECTED_ALLOWED"; } }
  catch (UnauthorizedAccessException) { return "OS_ACCESS_DENIED"; }
  finally { RevertToSelf(); }
 }
}
'@
[AnonymousPipeProbe]::Run('${pipeName}')`;
  const denied = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', cwd: dir, env: { ...process.env, TEMP: dir, TMP: dir, PSModuleAnalysisCachePath: path.join(dir, 'powershell-module-cache') }, timeout: 15000 });
  assert.match(denied, /OS_ACCESS_DENIED/);
  const connected = once(transport, 'connected'); socket = net.connect('\\\\.\\pipe\\' + pipeName); await once(socket, 'connect');
  const [clientId] = await connected, message = once(transport, 'message'); socket.write(JSON.stringify({ text: 'বাংলা' }) + '\n');
  assert.deepEqual(await message, [clientId, { text: 'বাংলা' }]);
  const reply = once(socket, 'data'); transport.send(clientId, { confirmed: true }); assert.deepEqual(JSON.parse(String((await reply)[0])), { confirmed: true });
});
