'use strict';
// dsh-web.js — start the DeepSeek Harness browser UI, project-local.
//
//   node mythos/scripts/dsh-web.js [--port 8099] [--open]
//
// WHY A LAUNCHER RATHER THAN CALLING dsh DIRECTLY. Two environment facts have to
// be right every time, and both are easy to forget:
//
//   * DSH_HOME decides where dsh keeps its profiles AND its credential store
//     ($DSH_HOME/.credentials.yaml). Left unset it writes under the user
//     profile, outside the project, which root CLAUDE.md forbids. It is pinned
//     here to the gitignored install root, so a key entered through the web
//     Models page stays inside the project and out of git.
//   * DSH_TELEMETRY_DISABLED. The shipped base bundle has NO redaction rule, so
//     an enabled export can carry message text, tool arguments and results, and
//     workspace paths. Any non-empty value is documented as an authoritative
//     hard opt-out, so it is set explicitly rather than assumed.
//
// CREDENTIAL VISIBILITY, and it is the thing most likely to waste someone's
// afternoon: dsh resolves credentials in the order
//   inherited environment -> $DSH_HOME/.credentials.yaml -> the invoking
//   directory's .env -> $DSH_HOME/.env
// The W6 spike pins its own DSH_HOME to a throwaway temp directory, so a key
// stored through THIS web UI is NOT visible to the spike. To feed the spike, put
// DEEPSEEK_API_KEY in mythos/.env instead — the spike loads that into its own
// environment, which is first in the order above and therefore always wins.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');           // mythos/
const INSTALL_ROOT = path.join(REPO_ROOT, '..', 'DeepSeek Harness');
const DSH_ENTRY = path.join(INSTALL_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const DEFAULT_PORT = '8099';   // clear of MYTHOS (4478), edge-tts (5050), design-static (8899)

function main() {
  const argv = process.argv.slice(2);
  let port = DEFAULT_PORT;
  let open = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') { port = String(argv[++i] || ''); continue; }
    if (argv[i] === '--open') { open = true; continue; }
    console.error('unknown argument: ' + argv[i] + ' (usage: --port <n> [--open])');
    process.exit(2);
  }

  if (!fs.existsSync(DSH_ENTRY)) {
    console.error('dsh is not installed. From the repo root:\n'
      + '  cd "DeepSeek Harness" && npm install --save-exact @deepseek-ai/dsh@0.1.1-rc.2\n'
      + 'Looked for: ' + path.relative(process.cwd(), DSH_ENTRY));
    process.exit(2);
  }

  const home = path.join(INSTALL_ROOT, 'home');
  fs.mkdirSync(home, { recursive: true });

  const env = Object.assign({}, process.env);
  env.DSH_HOME = home;
  env.DSH_TELEMETRY_DISABLED = '1';
  delete env.DSH_TELEMETRY_MODE;
  delete env.DSH_TELEMETRY_OTLP_URL;

  // `web` is the first app argument, which the launcher reads as the subcommand;
  // --no-open keeps it headless-friendly (the preview pane opens it instead).
  const args = [DSH_ENTRY, '--profile', 'web', '--port', port];
  if (!open) args.push('--no-open');

  console.log('dsh web on http://127.0.0.1:' + port);
  console.log('DSH_HOME = ' + path.relative(path.join(REPO_ROOT, '..'), home) + '  (gitignored)');
  console.log('A key stored through the Models page lands there, NOT in mythos/.env —');
  console.log('see this file\'s header for which one the W6 spike can actually read.');

  const child = spawn(process.execPath, args, { cwd: INSTALL_ROOT, env: env, stdio: 'inherit' });
  child.on('exit', function (code, signal) {
    process.exit(code == null ? (signal ? 1 : 0) : code);
  });
}

main();
