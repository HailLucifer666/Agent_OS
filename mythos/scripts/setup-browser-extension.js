'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { HOST_NAME, validId } = require('../adapters/browser-extension');
// Generates a reviewable, current-user-only registration; it never imports the
// registry file or changes a browser profile. The console host ships beside app.asar.
function prepareBrowserExtensionSetup({ outputDir, runtimeDir, executablePath, extensionIds }) {
  if (!path.isAbsolute(outputDir || '') || !path.isAbsolute(runtimeDir || '') || !path.isAbsolute(executablePath || '')) throw new Error('Absolute output/runtime directories and packaged executable are required');
  if (!fs.existsSync(executablePath) || path.extname(executablePath).toLowerCase() !== '.exe') throw new Error('The packaged native-host executable must exist');
  if (path.basename(executablePath).toLowerCase() !== 'mythos-browser-host.exe' || path.basename(path.dirname(executablePath)).toLowerCase() !== 'resources' || !fs.existsSync(path.join(path.dirname(executablePath), 'app.asar'))) throw new Error('Select the packaged resources/mythos-browser-host.exe; the GUI executable cannot host native messaging');
  if (!Array.isArray(extensionIds) || !extensionIds.length || extensionIds.some(id => !validId(id))) throw new Error('Explicit unpacked/store extension IDs are required; no wildcard origins');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'browser-extension-setup.json'), JSON.stringify({ allowedExtensionIds: [...new Set(extensionIds)] }, null, 2) + '\n');
  const manifestPath = path.join(outputDir, 'native-host.json');
  const manifest = { name: HOST_NAME, description: 'MYTHOS current-user browser operator', path: executablePath, type: 'stdio', allowed_origins: [...new Set(extensionIds)].map(id => 'chrome-extension://' + id + '/') };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const escaped = manifestPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const keys = ['Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\', 'Software\\Google\\Chrome\\NativeMessagingHosts\\'];
  const runtimeRegistration = '[HKEY_CURRENT_USER\\Software\\MYTHOS\\BrowserOperator]\r\n"RuntimeDir"="' + runtimeDir.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"\r\n';
  fs.writeFileSync(path.join(outputDir, 'register-current-user.reg'), '\uFEFFWindows Registry Editor Version 5.00\r\n\r\n' + keys.map(key => '[HKEY_CURRENT_USER\\' + key + HOST_NAME + ']\r\n@="' + escaped + '"\r\n').join('\r\n') + '\r\n' + runtimeRegistration, 'utf16le');
  fs.writeFileSync(path.join(outputDir, 'SETUP.txt'), [
    '1. Review the native-host manifest and HKCU registry entries before importing.',
    '2. Load mythos/browser-extension in the existing Brave profile (chrome://extensions compatibility supported). Copy the actual extension ID; regenerate if different.',
    '3. Configure the backend allowedExtensionIds with exactly these IDs and start its restricted pipe.',
    '4. Import register-current-user.reg only after setup approval, then click the MYTHOS extension action to connect.',
    '5. Existing signed-in browser profiles are reused. No profile is copied, launched, or switched by this setup.',
    '6. Native host uses MYTHOS_BROWSER_EXTENSION_RUNTIME_DIR, else MYTHOS_TOOLS_DIR/runtime/browser-extension, else the shared child-runtime default. Both processes must resolve this runtime directory: ' + runtimeDir,
    'Permission: chrome.debugger allows broad tab access. The operator sees the browser debugging banner; detaching it invalidates observations.',
    'Top-level HTTP(S) frames only in Stage 1. Incognito, internal pages, cross-origin child-frame control and providers requiring trusted native input can refuse.',
  ].join('\n') + '\n');
  return { manifestPath, extensionIds: manifest.allowed_origins, registryPath: path.join(outputDir, 'register-current-user.reg') };
}
if (require.main === module) {
  const args = process.argv.slice(2), value = key => args.indexOf(key) < 0 ? undefined : args[args.indexOf(key) + 1];
  try { console.log(JSON.stringify(prepareBrowserExtensionSetup({ outputDir: path.resolve(value('--output') || '.cache/browser-extension-setup'), runtimeDir: value('--runtime-dir') ? path.resolve(value('--runtime-dir')) : undefined, executablePath: value('--exe'), extensionIds: (value('--ids') || '').split(',').filter(Boolean) }), null, 2)); }
  catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = { prepareBrowserExtensionSetup };
