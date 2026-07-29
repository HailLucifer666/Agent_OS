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

  // REMEDIATION P3-9: identity-class claims (the operator's name, or what to
  // call them) are uniquely dangerous — a single STT mis-transcription
  // becomes a permanent "fact" fed back into every future prompt, and it is
  // self-reinforcing (a wrong name gets used, which then looks like more
  // evidence for the reflection pass — see the 2026-07-29 audit, where the
  // wake word "MYTHOS" mis-heard as "my thoughts"/"Mytas" produced "the
  // operator's name is Alex"). remember() can no longer write one of these
  // straight to confidence:0.9 — it is quarantined at a low confidence
  // instead, so it surfaces to the operator honestly ("I only think I heard
  // this once") and the periodic semantic.pruneLowConfidence() sweep
  // archives it away if it is never repeated.
  var IDENTITY_CLAIM_RE = /\b(call (?:me|the operator|him|her|them)\b|my name is\b|the operator'?s? name is\b|prefers? to be called\b|address (?:me|the operator) as\b)/i;
  var IDENTITY_QUARANTINE_CONFIDENCE = 0.3;

  async function remember(args){
    var text=(args&&(args.text||args.fact||args.note)||'').trim();
    if(!text) return fail('text required — the fact or instruction to remember');
    var STT_NOISE = /^(that you like|the|a|uh+|um+|hmm+)[\s.,!?]*$/i;
    if (text.length < 10 || STT_NOISE.test(text) || !/[a-z]{3,}/i.test(text)) {
      return fail('Rejected: too short or looks like transcription noise.');
    }
    if(!semantic||typeof semantic.write!=='function') return fail('memory store unavailable');
    try{
      var isIdentityClaim = IDENTITY_CLAIM_RE.test(text);
      var confidence = isIdentityClaim ? IDENTITY_QUARANTINE_CONFIDENCE : 0.9;
      var sources = isIdentityClaim ? ['voice-explicit','identity-unconfirmed'] : ['voice-explicit'];
      var res=semantic.write('user-facts',[text],{confidence:confidence,append:true,sources:sources});
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

  // P5 Jarvis upgrade: grounded self-knowledge. Reads the boot-generated
  // manifest (vault/Identity/capabilities.md, written by main.js's
  // capabilities-manifest step) — optionally filtered to the sections/lines
  // matching a topic — so "what exactly can you do with Spotify?" cites real
  // registered tools instead of vibes.
  function self_capabilities(args){
    if(!fs||typeof fs.readText!=='function') return fail('fs store unavailable');
    var manifest=fs.readText('Identity/capabilities.md','').trim();
    if(!manifest) return fail('capabilities manifest not generated yet — it is written at boot');
    var topic=(args&&args.topic||'').trim().toLowerCase();
    if(!topic) return ok({manifest:manifest.slice(0,6000)});
    var lines=manifest.split('\n');
    var matched=lines.filter(function(l){return l.toLowerCase().indexOf(topic)!==-1;});
    if(!matched.length) return ok({topic:topic,matches:0,manifest:manifest.slice(0,3000)});
    return ok({topic:topic,matches:matched.length,lines:matched.slice(0,40)});
  }

  return [
    {name:'self_capabilities',description:'Read your own capabilities manifest (tools, tiers, adapters, skills, recent code changes — regenerated every boot). Use when the user asks "what can you do", "what are your capabilities", "what tools do you have for X", or "what\'s new/changed". Pass topic to filter (e.g. "spotify").',params:{topic:'string (optional) — filter lines matching this word'},danger:false,fn:self_capabilities},
    {name:'remember',description:'Save a durable fact, preference, or instruction to permanent memory. Use when user says "remember","note that","don\'t forget","from now on","keep in mind", or states a standing rule. Persists across restarts.',params:{text:'string — the fact/preference/instruction'},danger:false,fn:remember},
    {name:'log_incident',description:'Record an error/bug/incident the user flags. Use when user says "log this","this is wrong","you hallucinated","log this as an error". Persists to durable incident log.',params:{text:'string — describe the incident',severity:'string (optional) — info|warn|error (default warn)'},danger:false,fn:log_incident},
    {name:'recall_memory',description:'Search past conversations and remembered facts for something relevant. Use when the user references something from earlier that you don\'t have in front of you, or directly asks "what did I say about X" / "do you remember X". Read-only.',params:{query:'string — what to search memory for',limit:'number (optional) — max results, default 8'},danger:false,fn:recall_memory}
  ];
}
function registerFromMemory(hub,ctx){var t=buildTools(ctx);for(var i=0;i<t.length;i++)hub.register(effectorFromTool(t[i]));return{count:t.length};}
module.exports={registerFromMemory,buildTools};
