'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function buildBrowserNativeHost(outputDir = path.resolve(__dirname, '../../.cache/native-browser-host')) {
  if (process.platform !== 'win32') throw new Error('The Windows browser native host must be built on Windows');
  const root = path.resolve(__dirname, '../..'), output = path.resolve(outputDir);
  if (!output.startsWith(root + path.sep)) throw new Error('Native host artifacts must stay inside the project');
  fs.mkdirSync(output, { recursive: true });
  const compiler = path.join(process.env.WINDIR || process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  if (!fs.existsSync(compiler)) throw new Error('Windows .NET Framework C# compiler is unavailable');
  const executablePath = path.join(output, 'mythos-browser-host.exe');
  execFileSync(compiler, ['/nologo', '/target:exe', '/optimize+', '/reference:System.Web.Extensions.dll', '/out:' + executablePath, path.join(root, 'electron/native-browser-host.cs')], { cwd: root, windowsHide: true, env: { ...process.env, TEMP: output, TMP: output }, stdio: 'pipe' });
  return executablePath;
}
if (require.main === module) { try { console.log(buildBrowserNativeHost(process.argv[2])); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { buildBrowserNativeHost };
