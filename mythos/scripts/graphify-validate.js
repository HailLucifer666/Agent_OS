#!/usr/bin/env node
'use strict';

// graphify-validate.js — integrity checks for the regenerated graph artifacts.
// Not part of the build; a one-shot validator run after graphify.js. Verifies
// the structural guarantees the vis-network page needs to render correctly.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GRAPH_HTML = path.join(REPO_ROOT, 'graphify-out', 'graph.html');
const GRAPH_JSON = path.join(__dirname, '..', '.graph-data.json');

let failures = 0;
function ok(msg) { console.log('  PASS  ' + msg); }
function fail(msg) { console.log('  FAIL  ' + msg); failures++; }

// --- 1. .graph-data.json parses and has the right shape ---
let data;
try {
  data = JSON.parse(fs.readFileSync(GRAPH_JSON, 'utf8'));
  ok('.graph-data.json parses');
} catch (e) {
  fail('.graph-data.json does not parse: ' + e.message);
  process.exit(1);
}
const { nodes, edges, communities } = data;
if (!Array.isArray(nodes) || !Array.isArray(edges) || !Array.isArray(communities)) {
  fail('top-level shape wrong: need nodes/edges/communities arrays');
} else {
  ok('top-level shape {nodes, edges, communities}');
}

// --- 2. node id uniqueness + schema completeness ---
const nodeIds = new Set(nodes.map((n) => n.id));
const nodeFields = ['id', 'label', 'color', 'size', 'font', 'title', 'community', 'community_name', 'source_file', 'file_type', 'degree'];
let schemaBad = 0;
const dupes = [];
const seenIds = new Set();
for (const n of nodes) {
  for (const f of nodeFields) if (!(f in n)) schemaBad++;
  if (seenIds.has(n.id)) dupes.push(n.id);
  seenIds.add(n.id);
}
schemaBad === 0 ? ok('every node has all required fields') : fail(`${schemaBad} node field gaps`);
dupes.length === 0 ? ok('node ids are unique') : fail(`duplicate node ids: ${dupes.slice(0, 5).join(', ')}`);

// --- 3. every edge references a real node ---
const dangling = edges.filter((e) => !nodeIds.has(e.from) || !nodeIds.has(e.to));
dangling.length === 0 ? ok('every edge endpoint is a real node') : fail(`${dangling.length} dangling edges (e.g. ${JSON.stringify(dangling[0])})`);

// --- 4. no self-loops ---
const selfLoops = edges.filter((e) => e.from === e.to);
selfLoops.length === 0 ? ok('no self-loop edges') : fail(`${selfLoops.length} self-loops`);

// --- 5. every node.community matches a community cid ---
const cids = new Set(communities.map((c) => c.cid));
const orphanComms = nodes.filter((n) => !cids.has(n.community));
orphanComms.length === 0 ? ok('every node.community maps to a community cid') : fail(`${orphanComms.length} nodes with unknown community`);

// --- 6. community counts match node distribution ---
let countBad = 0;
for (const c of communities) {
  const actual = nodes.filter((n) => n.community === c.cid).length;
  if (actual !== c.count) countBad++;
}
countBad === 0 ? ok('community counts match node distribution') : fail(`${countBad} communities with stale counts`);

// --- 7. no NOVA/app node leakage (MYTHOS-only check) ---
const novaLeak = nodes.filter((n) => n.source_file && (n.source_file.startsWith('app/') || n.source_file.startsWith('public/')));
novaLeak.length === 0 ? ok('no NOVA app/ nodes (MYTHOS-only confirmed)') : fail(`${novaLeak.length} NOVA nodes leaked: ${novaLeak.slice(0, 3).map((n) => n.source_file).join(', ')}`);

// --- 8. graph.html: RAW_NODES/EDGES/LEGEND parse, counts consistent ---
const html = fs.readFileSync(GRAPH_HTML, 'utf8');
const extract = (name) => {
  const re = new RegExp(`const ${name} = (\\[.*?\\]);`, 's');
  const m = html.match(re);
  if (!m) { fail(`${name} marker missing from graph.html`); return null; }
  try { return JSON.parse(m[1]); } catch (e) { fail(`${name} in graph.html is not valid JSON: ${e.message}`); return null; }
};
const hNodes = extract('RAW_NODES');
const hEdges = extract('RAW_EDGES');
const hLegend = extract('LEGEND');
if (hNodes && hEdges && hLegend) {
  hNodes.length === nodes.length ? ok(`graph.html RAW_NODES count matches (${hNodes.length})`) : fail(`RAW_NODES mismatch: html=${hNodes.length} json=${nodes.length}`);
  hEdges.length === edges.length ? ok(`graph.html RAW_EDGES count matches (${hEdges.length})`) : fail(`RAW_EDGES mismatch: html=${hEdges.length} json=${edges.length}`);
  hLegend.length === communities.length ? ok(`graph.html LEGEND count matches (${hLegend.length})`) : fail(`LEGEND mismatch: html=${hLegend.length} json=${communities.length}`);
}

// --- 9. stats line reflects actual counts ---
const statsM = html.match(/<div id="stats">(\d+) nodes &middot; (\d+) edges &middot; (\d+) communities<\/div>/);
if (statsM) {
  const [_, n, e, c] = statsM;
  (+n === nodes.length && +e === edges.length && +c === communities.length)
    ? ok(`stats line accurate (${n} / ${e} / ${c})`)
    : fail(`stats line stale: says ${n}/${e}/${c}, actual ${nodes.length}/${edges.length}/${communities.length}`);
} else {
  fail('stats line not found or malformed');
}

// --- 10. HTML structural balance (count <script ...> with any attributes, e.g. the CDN tag) ---
const scriptOpen = (html.match(/<script\b[^>]*>/g) || []).length;
const scriptClose = (html.match(/<\/script>/g) || []).length;
scriptOpen === scriptClose ? ok(`<script> tags balanced (${scriptOpen}/${scriptClose})`) : fail(`<script> unbalanced: ${scriptOpen} open / ${scriptClose} close`);
(html.includes('</body>') && html.includes('</html>')) ? ok('graph.html has </body> and </html>') : fail('graph.html missing closing body/html tags');

// --- 11. NOVA hyperedges block removed ---
html.includes('Render hyperedges as shaded regions')
  ? fail('NOVA hyperedges <script> block still present (should be dropped)')
  : ok('NOVA hyperedges block dropped');

// --- 12. title retitled ---
html.includes('<title>graphify — MYTHOS</title>')
  ? ok('title retitled to graphify — MYTHOS')
  : fail('title not retitled');

// --- 13. no leftover +50 community offset artifacts (max cid should be < communities.length) ---
const maxCid = Math.max(...communities.map((c) => c.cid));
const maxNodeComm = Math.max(...nodes.map((n) => n.community));
(maxCid < communities.length && maxNodeComm < communities.length)
  ? ok(`community cids in range (max cid ${maxCid}, ${communities.length} communities) — no +50 offset`)
  : fail(`cid out of range: max cid ${maxCid}, max node community ${maxNodeComm}, ${communities.length} communities`);

console.log('');
if (failures === 0) {
  console.log(`ALL CHECKS PASSED — ${nodes.length} nodes, ${edges.length} edges, ${communities.length} communities`);
} else {
  console.log(`${failures} CHECK(S) FAILED`);
}
process.exit(failures === 0 ? 0 : 1);
