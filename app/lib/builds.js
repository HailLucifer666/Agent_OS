// builds.js — lists real files in vault/builds/ for Game Studio / Free Claude Code galleries.
const fs = require('fs');
const vault = require('./vault');

function listBuilds(kind) {
  const dir = kind ? `builds/${kind}` : 'builds';
  const files = vault.listFiles(dir, '.html');
  return files.map((f) => {
    let stat;
    try {
      stat = fs.statSync(f.full);
    } catch {
      stat = null;
    }
    return {
      name: f.name,
      title: f.name.replace(/\.html$/, '').replace(/[-_]/g, ' '),
      path: `/vault/${dir}/${f.name}`,
      created: stat ? stat.birthtime.toISOString() : null,
      size: stat ? stat.size : 0,
    };
  }).sort((a, b) => (b.created || '').localeCompare(a.created || ''));
}

module.exports = { listBuilds };
