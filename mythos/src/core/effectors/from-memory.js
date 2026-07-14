'use strict';
var effectorFromTool = require('./adapter').effectorFromTool;
function ok(r){return{ok:true,result:r};}
function fail(m){return{ok:false,result:{error:m}};}

function buildTools(ctx){
  var semantic=ctx&&ctx.semantic, fs=ctx&&ctx.fs;

  async function remember(args){
    var text=(args&&(args.text||args.fact||args.note)||'').trim();
    if(!text) return fail('text required — the fact or instruction to remember');
    if(!semantic||typeof semantic.write!=='function') return fail('memory store unavailable');
    try{
      var res=semantic.write('user-facts',[text],{confidence:0.9,append:true,sources:['voice-explicit']});
      if(res&&res.degraded) return fail('memory write degraded — disk error');
      return ok({remembered:text.slice(0,200),ref:res&&res.ref});
    }catch(err){return fail('remember failed: '+(err.message||err));}
  }

  async function log_incident(args){
    var text=(args&&(args.text||args.error||args.message)||'').trim();
    if(!text) return fail('text required — describe the incident');
    if(!fs||typeof fs.appendLine!=='function') return fail('fs store unavailable');
    try{
      var severity=(args&&args.severity)||'warn';
      var d=new Date().toISOString().slice(0,10);
      fs.ensureDir('Incidents');
      fs.appendLine('Incidents/'+d+'.jsonl',{id:'inc-'+Date.now()+'-'+Math.floor(Math.random()*1e6),ts:Date.now(),text:text,severity:severity,source:'voice'});
      return ok({logged:text.slice(0,200),date:d});
    }catch(err){return fail('log_incident failed: '+(err.message||err));}
  }
  return [
    {name:'remember',description:'Save a durable fact, preference, or instruction to permanent memory. Use when user says "remember","note that","don\'t forget","from now on","keep in mind", or states a standing rule. Persists across restarts.',params:{text:'string — the fact/preference/instruction'},danger:false,fn:remember},
    {name:'log_incident',description:'Record an error/bug/incident the user flags. Use when user says "log this","this is wrong","you hallucinated","log this as an error". Persists to durable incident log.',params:{text:'string — describe the incident',severity:'string (optional) — info|warn|error (default warn)'},danger:false,fn:log_incident}
  ];
}
function registerFromMemory(hub,ctx){var t=buildTools(ctx);for(var i=0;i<t.length;i++)hub.register(effectorFromTool(t[i]));return{count:t.length};}
module.exports={registerFromMemory,buildTools};
