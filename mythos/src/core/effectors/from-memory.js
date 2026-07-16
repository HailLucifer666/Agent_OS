'use strict';
var effectorFromTool = require('./adapter').effectorFromTool;
function ok(r){return{ok:true,result:r};}
function fail(m){return{ok:false,result:{error:m}};}

function buildTools(ctx){
  var semantic=ctx&&ctx.semantic, fs=ctx&&ctx.fs, identity=ctx&&ctx.identity, memory=ctx&&ctx.memory;

  // Detect preference-shaped text: starts with "I like", "I prefer", "always", "never", etc.
  function isPreferenceShape(text) {
    var prefPattern = /^\s*(i\s+(?:like|prefer|want|enjoy|love|hate|dislike)|always|never|must|should)\b/i;
    return prefPattern.test(text);
  }

  async function remember(args){
    var text=(args&&(args.text||args.fact||args.note)||'').trim();
    if(!text) return fail('text required — the fact or instruction to remember');
    var STT_NOISE = /^(that you like|the|a|uh+|um+|hmm+)[\s.,!?]*$/i;
    if (text.length < 10 || STT_NOISE.test(text) || !/[a-z]{3,}/i.test(text)) {
      return fail('Rejected: too short or looks like transcription noise.');
    }
    if(!semantic||typeof semantic.write!=='function') return fail('memory store unavailable');
    try{
      var res=semantic.write('user-facts',[text],{confidence:0.9,append:true,sources:['voice-explicit']});
      if(res&&res.degraded) return fail('memory write degraded — disk error');
      // If text looks like a stated preference, also populate Learned Preferences
      if (isPreferenceShape(text) && identity && typeof identity.learn === 'function') {
        identity.learn({ text: text, sourceEpId: 'remember-tool' }).catch(function(err) {
          // Swallow learn() errors — don't fail the remember() call if identity write fails
          console.warn('identity.learn() failed in remember:', err.message);
        });
      }
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

  // Item 9 stretch (RAG follow-up): explicit mid-conversation memory search —
  // server/index.js's handleUtterance already calls recallHybrid once per turn
  // BEFORE the model sees the utterance (auto-recall); this lets the model
  // reach for memory a SECOND time, deliberately, when a first pass didn't
  // surface what it needed (e.g. a specific past detail the user references).
  // Read-only — same recallHybrid used by auto-recall, just model-triggered.
  async function recall_memory(args){
    var query=(args&&args.query||'').trim();
    if(!query) return fail('query required — what to search memory for');
    if(!memory||typeof memory.recallHybrid!=='function') return fail('memory recall unavailable');
    var limit=(args&&Number(args.limit))||8;
    try{
      var hits=await memory.recallHybrid(query,{limit:limit});
      var results=(hits||[]).map(function(h){
        return {store:h.store,snippet:h.snippet||(h.record&&h.record.summary)||'',score:h.score};
      }).filter(function(r){ return r.snippet; });
      return ok({query:query,count:results.length,results:results});
    }catch(err){return fail('recall_memory failed: '+(err.message||err));}
  }

  return [
    {name:'remember',description:'Save a durable fact, preference, or instruction to permanent memory. Use when user says "remember","note that","don\'t forget","from now on","keep in mind", or states a standing rule. Persists across restarts.',params:{text:'string — the fact/preference/instruction'},danger:false,fn:remember},
    {name:'log_incident',description:'Record an error/bug/incident the user flags. Use when user says "log this","this is wrong","you hallucinated","log this as an error". Persists to durable incident log.',params:{text:'string — describe the incident',severity:'string (optional) — info|warn|error (default warn)'},danger:false,fn:log_incident},
    {name:'recall_memory',description:'Search past conversations and remembered facts for something relevant. Use when the user references something from earlier that you don\'t have in front of you, or directly asks "what did I say about X" / "do you remember X". Read-only.',params:{query:'string — what to search memory for',limit:'number (optional) — max results, default 8'},danger:false,fn:recall_memory}
  ];
}
function registerFromMemory(hub,ctx){var t=buildTools(ctx);for(var i=0;i<t.length;i++)hub.register(effectorFromTool(t[i]));return{count:t.length};}
module.exports={registerFromMemory,buildTools};
