'use strict';
// Stand-in for services/browser-use-runner.py in tests. Reads the same stdin JSON and
// picks its behaviour from a marker at the start of the task text, so a test can drive
// every exit code and every malformed shape without Python, a browser, or a model.
//
// `node --test` with no arguments executes EVERY .js under test/, this file included. Without
// the guard below it would wait on a stdin that never ends and hang the whole suite, so it
// does nothing unless invoked the way the effector invokes it: with --as-runner.
if (process.argv[2] !== '--as-runner') return;
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const req = JSON.parse(input);
  const t = String(req.task);
  const base = { model: req.provider + '/' + req.model, steps: 6, seconds: 42.0, urls: [], errors: [] };
  const say = (o, code) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(code); };
  if (t.startsWith('DONE_WATCH')) return say({ ...base, ok: true, done: true, successful: true, result: 'Played it.', final_url: 'https://www.youtube.com/watch?v=abc', final_title: 'Song - YouTube', urls: ['https://www.youtube.com/', 'https://www.youtube.com/watch?v=abc'] }, 0);
  if (t.startsWith('DONE_BLANK')) return say({ ...base, ok: true, done: true, successful: true, result: 'Done.', final_url: 'about:blank', final_title: '' }, 0);
  if (t.startsWith('EXIT2')) return say({ ...base, ok: false, done: false, error: 'stopped before the task was done', steps: 20, final_url: 'https://www.youtube.com/watch?v=reached', final_title: 'Reached - YouTube' }, 2);
  if (t.startsWith('EXIT3')) return say({ ...base, ok: false, error: '429 RESOURCE_EXHAUSTED quota exceeded' }, 3);
  if (t.startsWith('EXIT4')) return say({ ...base, ok: false, error: 'no debuggable browser at ' + req.cdp_url }, 4);
  if (t.startsWith('GARBAGE')) { process.stdout.write('not json at all\n'); process.stderr.write('Traceback: boom\n'); process.exit(1); }
  if (t.startsWith('HANG')) { setInterval(() => {}, 1000); return; }
  if (t.startsWith('ECHO_ENV')) return say({ ...base, ok: true, done: true, successful: true, result: JSON.stringify(Object.keys(process.env).filter((k) => /_API_KEY$|SECRET|TOKEN/.test(k)).sort()), final_url: 'https://example.com/' }, 0);
  say({ ...base, ok: false, error: 'unknown fixture task' }, 5);
});
