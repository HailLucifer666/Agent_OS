'use strict';
var effectorFromTool = require('./adapter').effectorFromTool;
function ok(r){return{ok:true,result:r};}
function fail(m){return{ok:false,result:{error:m}};}

function buildTools(ctx){
  var semantic=ctx&&ctx.semantic, fs=ctx&&ctx.fs, identity=ctx&&ctx.identity;

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
  return [
    {name:'remember',description:'Save a durable fact, preference, or instruction to permanent memory. Use when user says "remember","note that","don\'t forget","from now on","keep in mind", or states a standing rule. Persists across restarts.',params:{text:'string — the fact/preference/instruction'},danger:false,fn:remember},
    {name:'log_incident',description:'Record an error/bug/incident the user flags. Use when user says "log this","this is wrong","you hallucinated","log this as an error". Persists to durable incident log.',params:{text:'string — describe the incident',severity:'string (optional) — info|warn|error (default warn)'},danger:false,fn:log_incident}
  ];
}
function registerFromMemory(hub,ctx){var t=buildTools(ctx);for(var i=0;i<t.length;i++)hub.register(effectorFromTool(t[i]));return{count:t.length};}
module.exports={registerFromMemory,buildTools};
