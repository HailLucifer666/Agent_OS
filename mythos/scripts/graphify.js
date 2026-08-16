#!/usr/bin/env node
'use strict';

// graphify.js — regenerate the MYTHOS dependency graph.
//
// Reads the live mythos/ source tree (src/, providers/, adapters/, server/, test/
// plus curated config/docs roots), statically analyses every require() call,
// and emits two artifacts:
//
//   1. mythos/.graph-data.json   — { nodes, edges, communities } (source of truth)
//   2. graphify-out/graph.html   — the rendered vis-network page
//
// The HTML is produced by surgically replacing four data lines in the existing
// file and dropping the NOVA hyperedges block; every other byte of the page
// (CSS, body, vis options, app JS) is preserved verbatim. Run after every
// phase-gate push — mythos/ROADMAP.md (lines 14-22) mandates this file be
// kept in sync, and prior to this script there was no generator so it rotted.
//
// Zero npm deps (CommonJS, Node built-ins only) — matches the repo convention.
//   Usage:  node mythos/scripts/graphify.js

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MYTHOS_ROOT = path.resolve(__dirname, '..');
const GRAPH_HTML = path.join(REPO_ROOT, 'graphify-out', 'graph.html');
const GRAPH_JSON = path.join(MYTHOS_ROOT, '.graph-data.json');

// ---------------------------------------------------------------------------
// Communities
// ---------------------------------------------------------------------------

// Existing MYTHOS palette (cids 0-14) preserved verbatim from the prior
// hand-authored graph so the familiar subsystem colours stay stable.
// Each entry: { cid, label, bg, border }. `border` is a precomputed darker
// shade (~20% HSL lightness reduction); highlight is synthesised downstream as
// { background: '#ffffff', border: <bg> }.
const PALETTE = [
  { label: 'MYTHOS Core Config', bg: '#4E79A7', border: '#3A5F8A' },
  { label: 'Event Bus',          bg: '#F28E2B', border: '#C6711F' },
  { label: 'Config Layer',       bg: '#E15759', border: '#B94042' },
  { label: 'Lifecycle',          bg: '#76B7B2', border: '#5A938E' },
  { label: 'Logger',             bg: '#59A14F', border: '#437D3B' },
  { label: 'Memory',             bg: '#EDC948', border: '#C9A62E' },
  { label: 'Brain',              bg: '#B07AA1', border: '#8D6080' },
  { label: 'Cortex',             bg: '#FF9DA7', border: '#D97D87' },
  { label: 'Goals',              bg: '#9C755F', border: '#7A5D4A' },
  { label: 'Sensors',            bg: '#BAB0AC', border: '#968E8B' },
  { label: 'Quota',              bg: '#76EEC6', border: '#5ABF9E' },
  { label: 'Providers',          bg: '#FF6F61', border: '#D45549' },
  { label: 'Tests',              bg: '#88CCEE', border: '#6AA8C7' },
  { label: 'Vault',              bg: '#CCBB44', border: '#A89837' },
  { label: 'Fable Roadmap',      bg: '#DDCC77', border: '#B8A861' },
];

// Extended palette for the new subsystems (Effectors, Identity, Immune, Leash,
// Engagements, Assistant, Voice, MCP, Adapters, Server, Design, Planner,
// Skills, Agents, Conversation, Boot). Same Tableau-10 family as the existing
// additions (#76EEC6 / #FF6F61 / #88CCEE / #CCBB44) — hand-tuned, no two
// adjacent colours collide.
const EXT_PALETTE = [
  { label: 'Effectors',          bg: '#66C2A5', border: '#4E9C84' },
  { label: 'Identity',           bg: '#FC8D62', border: '#D06D44' },
  { label: 'Immune',             bg: '#A78BFA', border: '#7E63C8' },
  { label: 'Leash',              bg: '#E78AC3', border: '#BB689C' },
  { label: 'Engagements',        bg: '#8DA0CB', border: '#6A7BA3' },
  { label: 'Assistant',          bg: '#E5C870', border: '#BBA34E' },
  { label: 'Voice',              bg: '#7FB3D5', border: '#5A8FB5' },
  { label: 'MCP',                bg: '#F4A582', border: '#CC8155' },
  { label: 'Adapters',           bg: '#D95F02', border: '#A84800' },
  { label: 'Server',             bg: '#7570B3', border: '#56508A' },
  { label: 'Design',             bg: '#E7298A', border: '#B81D6E' },
  { label: 'Planner',            bg: '#66A61E', border: '#4C7F16' },
  { label: 'Skills',             bg: '#E6AB02', border: '#B88501' },
  { label: 'Agents',             bg: '#A6761D', border: '#805A15' },
  { label: 'Conversation',       bg: '#B3B3B3', border: '#8C8C8C' },
  { label: 'Boot',               bg: '#1F78B4', border: '#155A87' },
  { label: 'Scripts',            bg: '#CCEBC5', border: '#A6C9A0' },
];

// Map a mythos/-relative source path to its community label.
function communityFor(relPath) {
  // relPath uses forward slashes, mythos/-relative (e.g. 'src/core/bus/index.js').
  const parts = relPath.split('/');
  if (parts[0] === 'src' && parts[1] === 'main.js') return 'Boot';
  if (parts[0] === 'src' && parts[1] === 'core' && parts.length >= 3) {
    // src/core/<subdir>/...  → subsystem community by folder name.
    return SUBSYSTEM_LABEL[parts[2]] || 'MYTHOS Core Config';
  }
  if (parts[0] === 'src' && parts[1] === 'core' && parts.length === 2) {
    // Loose files directly under core/: logger.js, quota.js, boot-banner.js.
    return LOOSE_CORE_LABEL[parts[1]] || 'MYTHOS Core Config';
  }
  if (parts[0] === 'providers') return 'Providers';
  if (parts[0] === 'adapters')  return 'Adapters';
  if (parts[0] === 'server')    return 'Server';
  if (parts[0] === 'mcp')       return 'MCP';
  if (parts[0] === 'scripts')   return 'Scripts';
  if (parts[0] === 'test')      return 'Tests';
  if (parts[0] === 'vault')     return 'Vault';
  // Config / docs roots at mythos/ top level.
  if (parts[0] === 'package.json' || parts[0] === '.env.example') return 'MYTHOS Core Config';
  if (parts[0] === 'MYTHOS-ARCHITECTURE.md' || parts[0] === 'ROADMAP.md') return 'MYTHOS Core Config';
  if (parts[0] === 'Mythos Fable Roadmap.txt') return 'Fable Roadmap';
  return 'MYTHOS Core Config';
}

const SUBSYSTEM_LABEL = {
  bus: 'Event Bus',
  config: 'Config Layer',
  lifecycle: 'Lifecycle',
  memory: 'Memory',
  brain: 'Brain',
  cortex: 'Cortex',
  goals: 'Goals',
  sensors: 'Sensors',
  quota: 'Quota',
  immune: 'Immune',
  leash: 'Leash',
  effectors: 'Effectors',
  identity: 'Identity',
  assistant: 'Assistant',
  voice: 'Voice',
  engagements: 'Engagements',
  agents: 'Agents',
  conversation: 'Conversation',
  design: 'Design',
  planner: 'Planner',
  skills: 'Skills',
};

const LOOSE_CORE_LABEL = {
  'logger.js': 'Logger',
  'quota.js': 'Quota',
  'boot-banner.js': 'Boot',
};

// ---------------------------------------------------------------------------
// External specifiers (no edge drawn)
// ---------------------------------------------------------------------------

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'test',
  'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm',
  'wasi', 'worker_threads', 'zlib',
]);

// Read package.json deps so the external list stays correct if deps change.
function readPackageDeps() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(MYTHOS_ROOT, 'package.json'), 'utf8'));
    return new Set(Object.keys(pkg.dependencies || {}));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Node discovery
// ---------------------------------------------------------------------------

// Walk a directory recursively, returning mythos/-relative forward-slashed
// paths for every file matching one of the given extensions.
function walk(absDir, exts) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules') continue;
    const full = path.join(absDir, e.name);
    if (e.isDirectory()) {
      out.push(...walk(full, exts));
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (exts.has(ext)) out.push(full);
    }
  }
  return out;
}

function toRel(absPath) {
  return path.relative(MYTHOS_ROOT, absPath).replace(/\\/g, '/');
}

function classify(relPath, absPath) {
  // Returns { file_type, size, fontSize }. The categorical sizing rule is
  // preserved from the hand-authored graph (verified empirically: not
  // degree-based — providers/claude-cli.js is degree 0 but size 15; tests are
  // degree 5 but size 12). font.size 0 hides the label (keeps leaf/auxiliary
  // nodes from cluttering the canvas).
  const parts = relPath.split('/');
  const base = parts[parts.length - 1];
  const isIndex = base === 'index.js';

  // Vault placeholders.
  if (parts[0] === 'vault') return { file_type: 'code', size: 8, fontSize: 0 };

  // Tests.
  if (parts[0] === 'test' && base.endsWith('.test.js')) {
    return { file_type: 'test', size: 12, fontSize: 0 };
  }
  if (parts[0] === 'test') {
    // test/helpers.js, test/eval/*.eval.js — test support files.
    return { file_type: 'test', size: 12, fontSize: 0 };
  }

  // Config / docs.
  if (base === 'package.json' || base === '.env.example') {
    return { file_type: 'config', size: 10, fontSize: 0 };
  }
  if (base.endsWith('.md') || base.endsWith('.txt')) {
    return { file_type: 'docs', size: 10, fontSize: 0 };
  }

  // Code: hub index.js / main.js get size 20 (the visibly larger hubs in the
  // existing graph — bus/index.js, memory/index.js, etc.), everything else 15.
  if (base.endsWith('.js')) {
    if (isIndex || relPath === 'src/main.js') return { file_type: 'code', size: 20, fontSize: 12 };
    return { file_type: 'code', size: 15, fontSize: 12 };
  }

  // Fallback for any other file type slipped in (e.g. .json data files).
  return { file_type: 'docs', size: 10, fontSize: 0 };
}

function deriveId(relPath) {
  return relPath.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function deriveLabel(relPath) {
  // Short, path-aware display label matching the existing convention
  // ('bus/index.js', 'providers/zcode.js', 'test/brain.test.js').
  return relPath;
}

function deriveTitle(relPath, file_type) {
  const label = path.basename(relPath);
  if (file_type === 'test') return `${label} — test`;
  if (file_type === 'config') return `${label} — config`;
  if (file_type === 'docs') return `${label} — documentation`;
  return `${relPath}`;
}

// Curated non-.js roots to include (config + docs + vault placeholders).
function curatedRoots() {
  const roots = [
    'package.json',
    '.env.example',
    'MYTHOS-ARCHITECTURE.md',
    'ROADMAP.md',
    'Mythos Fable Roadmap.txt',
  ];
  const out = [];
  for (const r of roots) {
    const abs = path.join(MYTHOS_ROOT, r);
    if (fs.existsSync(abs)) out.push(abs);
  }
  // vault/*/.gitkeep placeholders.
  const vaultDir = path.join(MYTHOS_ROOT, 'vault');
  if (fs.existsSync(vaultDir)) {
    for (const sub of fs.readdirSync(vaultDir, { withFileTypes: true })) {
      if (sub.isDirectory()) {
        const keep = path.join(vaultDir, sub.name, '.gitkeep');
        if (fs.existsSync(keep)) out.push(keep);
      }
    }
  }
  return out;
}

function discoverNodes() {
  const jsDirs = ['src', 'providers', 'adapters', 'server', 'mcp', 'scripts', 'test'];
  const absFiles = new Set();
  for (const d of jsDirs) {
    const absDir = path.join(MYTHOS_ROOT, d);
    if (fs.existsSync(absDir)) for (const f of walk(absDir, new Set(['.js']))) absFiles.add(f);
  }
  for (const f of curatedRoots()) absFiles.add(f);

  const nodes = [];
  const relToNode = new Map();
  for (const abs of [...absFiles].sort()) {
    const rel = toRel(abs);
    const { file_type, size, fontSize } = classify(rel, abs);
    const node = {
      id: deriveId(rel),
      label: deriveLabel(rel),
      size,
      font: { size: fontSize, color: '#ffffff' },
      title: deriveTitle(rel, file_type),
      source_file: rel,
      file_type,
      _rel: rel,
      _abs: abs,
    };
    nodes.push(node);
    relToNode.set(rel, node);
  }
  return { nodes, relToNode };
}

// ---------------------------------------------------------------------------
// require() static analysis → edges
// ---------------------------------------------------------------------------

const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

// Strip // line comments and /* */ block comments so commented-out requires
// (e.g. effectors/pipeline.js:9) don't produce false edges.
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      // Line comment — skip to newline.
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      // Block comment — skip to closing */.
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'") {
      // String literal — copy verbatim so a '//' inside a string isn't seen
      // as a comment. (Backticks for template literals handled below.)
      const quote = c;
      out += c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) { out += src[i]; out += src[i + 1]; i += 2; continue; }
        out += src[i];
        i++;
      }
      if (i < n) { out += src[i]; i++; }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Resolve a relative require specifier from a file's directory to a
// mythos/-relative path, honouring Node's index.js-for-directory convention.
function resolveRequire(specifier, fromAbs) {
  const fromDir = path.dirname(fromAbs);
  const candidate = path.resolve(fromDir, specifier);
  const candidates = [candidate];
  // Directory require: '../bus' → ../bus/index.js
  candidates.push(path.join(candidate, 'index.js'));
  // Extension-less require: './foo' → ./foo.js. Also handle specifiers whose
  // name contains a dot but no real extension (e.g. './lanes.default' — Node
  // treats the whole thing as a filename and resolves ./lanes.default.js).
  const ext = path.extname(candidate);
  if (ext !== '.js' && ext !== '.json') {
    candidates.push(candidate + '.js');
    candidates.push(path.join(candidate, 'index.js'));
  }
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      return toRel(c);
    }
  }
  return null;
}

function isExternal(specifier, pkgDeps) {
  // Bare specifier: Node builtin or npm package (incl. @scope/name).
  const top = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
  return NODE_BUILTINS.has(top) || pkgDeps.has(top);
}

function buildEdges(nodes, relToNode) {
  const pkgDeps = readPackageDeps();
  const edges = [];
  const seen = new Set(); // dedupe (from, to)
  const warnings = [];
  for (const node of nodes) {
    if (!node._abs || !node.source_file.endsWith('.js')) continue;
    let src;
    try {
      src = fs.readFileSync(node._abs, 'utf8');
    } catch {
      continue;
    }
    const cleaned = stripComments(src);
    let m;
    REQUIRE_RE.lastIndex = 0;
    while ((m = REQUIRE_RE.exec(cleaned)) !== null) {
      const spec = m[1];
      if (isExternal(spec, pkgDeps)) continue;
      if (!spec.startsWith('.')) {
        // Bare but not in deps/builtins — treat as external, note it.
        continue;
      }
      const targetRel = resolveRequire(spec, node._abs);
      if (!targetRel) {
        warnings.push(`${node.source_file}: require('${spec}') could not be resolved`);
        continue;
      }
      const target = relToNode.get(targetRel);
      if (!target) {
        warnings.push(`${node.source_file}: require('${spec}') → ${targetRel} not in graph`);
        continue;
      }
      if (target.id === node.id) continue; // self-loop guard
      const key = `${node.id}\u0001${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: node.id, to: target.id, _fromNode: node, _toNode: target, _spec: spec });
    }
  }
  return { edges, warnings };
}

// ---------------------------------------------------------------------------
// Colour + community assembly
// ---------------------------------------------------------------------------

function buildCommunityTable(nodeList) {
  // Determine which labels are actually used, then assign cids preserving the
  // existing palette order (so familiar subsystems keep their stable colour).
  const usedLabels = new Set(nodeList.map((n) => n._communityLabel));
  const table = [];
  let cid = 0;
  for (const p of [...PALETTE, ...EXT_PALETTE]) {
    if (!usedLabels.has(p.label)) continue;
    table.push({ cid: cid++, label: p.label, bg: p.bg, border: p.border });
  }
  return table;
}

function finalize(nodes, edges, communityTable) {
  const labelToCid = new Map(communityTable.map((c) => [c.label, c.cid]));
  const labelToColor = new Map(communityTable.map((c) => [c.label, c]));

  // Attach community + colour to each node, drop internal _fields.
  const finalNodes = nodes.map((n) => {
    const cid = labelToCid.get(n._communityLabel);
    const comm = labelToColor.get(n._communityLabel);
    const color = {
      background: comm.bg,
      border: comm.border,
      highlight: { background: '#ffffff', border: comm.bg },
    };
    return {
      id: n.id,
      label: n.label,
      color,
      size: n.size,
      font: n.font,
      title: n.title,
      community: cid,
      community_name: comm.label,
      source_file: n.source_file,
      file_type: n.file_type,
      degree: 0, // filled after edges
    };
  });

  // Compute degree (undirected: in + out) per node.
  const degreeById = new Map(finalNodes.map((n) => [n.id, 0]));
  const finalEdges = edges.map((e) => {
    const fromComm = labelToCid.get(e._fromNode._communityLabel);
    const fromColor = labelToColor.get(e._fromNode._communityLabel).bg;
    const toComm = labelToCid.get(e._toNode._communityLabel);
    let width;
    if (e._fromNode.file_type === 'test') {
      width = 1;
    } else if (fromComm === toComm) {
      width = 2;
    } else if (e._fromNode.source_file === 'src/main.js') {
      width = 2; // boot deps promoted to strong
    } else {
      width = 1.5; // cross-community code edge
    }
    degreeById.set(e.from, (degreeById.get(e.from) || 0) + 1);
    degreeById.set(e.to, (degreeById.get(e.to) || 0) + 1);
    return {
      from: e.from,
      to: e.to,
      color: { color: fromColor },
      width,
      title: `require('${e._spec}')`,
    };
  });
  for (const n of finalNodes) n.degree = degreeById.get(n.id) || 0;

  // Communities with counts.
  const countByCid = new Map();
  for (const n of finalNodes) countByCid.set(n.community, (countByCid.get(n.community) || 0) + 1);
  const communities = communityTable.map((c) => ({
    cid: c.cid,
    label: c.label,
    color: c.bg,
    count: countByCid.get(c.cid) || 0,
  }));

  return { finalNodes, finalEdges, communities };
}

// ---------------------------------------------------------------------------
// HTML emission — surgical 4-line replacement + hyperedge block removal
// ---------------------------------------------------------------------------

const STATS_RE = /<div id="stats">[^<]*<\/div>/;
const RAW_NODES_RE = /const RAW_NODES = \[[\s\S]*?\];/;
const RAW_EDGES_RE = /const RAW_EDGES = \[[\s\S]*?\];/;
const LEGEND_RE = /const LEGEND = \[[\s\S]*?\];/;
// The trailing hyperedges <script> block references NOVA node ids; for a
// MYTHOS-only graph it must be dropped. Match from the comment marker through
// the closing </script>.
const HYPEREDGES_RE = /<script>\s*\/\/ Render hyperedges as shaded regions[\s\S]*?<\/script>\s*(<\/body>)/;

function writeHtml(finalNodes, finalEdges, communities) {
  const html = fs.readFileSync(GRAPH_HTML, 'utf8');

  const statsLine = `<div id="stats">${finalNodes.length} nodes &middot; ${finalEdges.length} edges &middot; ${communities.length} communities</div>`;
  const nodesLine = `const RAW_NODES = ${JSON.stringify(finalNodes)};`;
  const edgesLine = `const RAW_EDGES = ${JSON.stringify(finalEdges)};`;
  const legendLine = `const LEGEND = ${JSON.stringify(communities)};`;

  let out = html;
  const steps = [
    ['stats', STATS_RE, statsLine],
    ['RAW_NODES', RAW_NODES_RE, nodesLine],
    ['RAW_EDGES', RAW_EDGES_RE, edgesLine],
    ['LEGEND', LEGEND_RE, legendLine],
  ];
  for (const [name, re, replacement] of steps) {
    if (!re.test(out)) throw new Error(`could not find ${name} marker in graph.html`);
    out = out.replace(re, replacement);
  }

  // Drop the NOVA hyperedges block (if present).
  if (HYPEREDGES_RE.test(out)) {
    out = out.replace(HYPEREDGES_RE, '$1');
  }

  // Retitle: set title to "graphify — MYTHOS".
  out = out.replace(
    /<title>.*<\/title>/,
    '<title>graphify — MYTHOS</title>'
  );

  fs.writeFileSync(GRAPH_HTML, out);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { nodes, relToNode } = discoverNodes();

  // Tag each node with its community label (temp field).
  for (const n of nodes) n._communityLabel = communityFor(n._rel);

  const { edges, warnings } = buildEdges(nodes, relToNode);
  const communityTable = buildCommunityTable(nodes);
  const { finalNodes, finalEdges, communities } = finalize(nodes, edges, communityTable);

  // Deterministic ordering for stable diffs.
  finalNodes.sort((a, b) => (a.source_file < b.source_file ? -1 : 1));
  finalEdges.sort((a, b) =>
    a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1
  );
  communities.sort((a, b) => a.cid - b.cid);

  // Emit .graph-data.json (strip the synthetic 'degree' from communities? —
  // keep node schema identical to the hand-authored file).
  const data = { nodes: finalNodes, edges: finalEdges, communities };
  fs.writeFileSync(GRAPH_JSON, JSON.stringify(data, null, 2) + '\n');

  writeHtml(finalNodes, finalEdges, communities);

  // Report.
  console.log('graphify: regenerated MYTHOS dependency graph');
  console.log(`  nodes:       ${finalNodes.length}`);
  console.log(`  edges:       ${finalEdges.length}`);
  console.log(`  communities: ${communities.length}`);
  console.log(`  → ${path.relative(REPO_ROOT, GRAPH_JSON)}`);
  console.log(`  → ${path.relative(REPO_ROOT, GRAPH_HTML)}`);
  if (warnings.length) {
    console.log(`  warnings (${warnings.length}):`);
    for (const w of warnings.slice(0, 40)) console.log(`    ${w}`);
    if (warnings.length > 40) console.log(`    ... and ${warnings.length - 40} more`);
  } else {
    console.log('  warnings:    none');
  }
}

main();
