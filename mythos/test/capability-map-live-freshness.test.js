'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const build = require('../scripts/build-capability-map');
function fixture() {
  const data = { generated: '2026-09-07', clusters: [{id:'x',name:'X'}], nodes: [{c:'x',n:'One',s:'ok',tools:['alpha'],ok:0,f:0}] };
  const deps = { today:'2026-09-07',repo:{registered:['alpha'],voiceReachable:['alpha'],withheld:[],withheldCurated:[]},
    suite:{tests:5,pass:5,fail:0,skipped:0,measuredAt:'2026-09-07'},vault:{reachable:true,untracked:0},
    counts:{reachable:true,roots:[],records:0,duplicates:0,counts:new Map([['alpha',{ok:0,fail:0}]])} };
  deps.html='<script type="application/json" id="map-data">'+JSON.stringify(data)+'</script>';
  deps.html=build.generate(deps).nextHtml;
  return deps;
}
function check(deps) {
  const log=console.log,error=console.error;console.log=console.error=()=>{};
  try{return build.main(['--check'],deps);}finally{console.log=log;console.error=error;}
}
test('check ignores only advancing live measurements while generated output still refreshes them',()=>{
  const deps=fixture();assert.equal(check(deps),0);
  deps.counts.counts.set('alpha',{ok:3,fail:1});deps.counts.records=4;deps.vault.untracked=3;
  const result=build.generate(deps);assert.equal(result.changed,true);assert.deepEqual(result.problems,[]);
  assert.equal(result.next.nodes[0].ok,3);assert.equal(result.next.nodes[0].f,1);assert.equal(result.next.vitals.untriaged.value,3);
  assert.equal(check(deps),0,'live counts alone must not make repository freshness fail');
});
test('check retains repository mapping, counts, metadata and date freshness gates',()=>{
  for(const mutate of [d=>d.repo.registered.push('missing'),d=>d.suite.tests++,d=>d.suite.measuredAt='2026-09-08',d=>d.today='2026-09-08']){
    const deps=fixture();mutate(deps);assert.equal(check(deps),1);
  }
});
test('measured calls still contradict dark and unknown zero-claim labels',()=>{
  for(const state of ['dark','unknown']){
    const deps=fixture();deps.html=deps.html.replace('"s": "ok"','"s": "'+state+'"');deps.counts.counts.set('alpha',{ok:1,fail:0});
    assert.equal(check(deps),1);assert.ok(build.generate(deps).mapping.length>0);
  }
});
