'use strict';
var effectorFromTool = require('./adapter').effectorFromTool;
var { reasonText } = require('../util/reason-text');
var { dayKey } = require('../util/day-key');
var { resumeInterruptedAnswer } = require('../voice/unheard-answer'); // BUG-447
var { verifyConsent } = require('../leash/consent'); // BUG-464
function ok(r){return{ok:true,result:r};}
function fail(m){return{ok:false,result:{error:m}};}

// BUG-320 — "[[Note Name]]" -> "Note Name". Applied to note titles only: the
// vault's markdown uses wiki links, so a model that has just read a note hands
// the link back as the lookup key. Empty after stripping ("[[]]") returns '',
// which the caller already treats as "no title given" — the list-my-notes
// branch — rather than searching for an empty string.
function stripWikiLink(s){
  var t=String(s==null?'':s).trim();
  var m=/^\[\[([\s\S]*)\]\]$/.exec(t);
  return (m?m[1]:t).trim();
}

function buildTools(ctx){
  var semantic=ctx&&ctx.semantic, fs=ctx&&ctx.fs, identity=ctx&&ctx.identity, memory=ctx&&ctx.memory;
  // Notes store (memory/notes.js) — plain Obsidian-compatible markdown, the
  // operator's own documents rather than MYTHOS's asserted facts. Optional in
  // this ctx so every existing caller/test that builds these tools without it
  // keeps working; the tools then fail honestly instead of throwing.
  var notes=ctx&&ctx.notes;

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

  // BUG-464 (2026-09-24): the lock. A save needs a consent token for exactly
  // these arguments, minted by the server after the operator's own words asked
  // for it or approved a read-back (voice/authority-gate.js). It arrives in the
  // dispatch context, which the model cannot write; a `consent` key in args is
  // ignored. With no token nothing is written — including from the autonomous
  // loop, which has no operator words at all. The label now says which of the
  // two happened: before this, every line said 'voice-explicit', asked or not.
  async function remember(args, callCtx){
    var text=(args&&(args.text||args.fact||args.note)||'').trim();
    if(!text) return fail('text required — the fact or instruction to remember');
    var STT_NOISE = /^(that you like|the|a|uh+|um+|hmm+)[\s.,!?]*$/i;
    if (text.length < 10 || STT_NOISE.test(text) || !/[a-z]{3,}/i.test(text)) {
      return fail('Rejected: too short or looks like transcription noise.');
    }
    var consent = verifyConsent(callCtx && callCtx.consent, 'remember', args);
    if (!consent.ok) {
      return fail('Not saved (' + consent.reason + '): permanent memory is written only when the operator asks for it '
        + 'in their own words, or says yes after the exact text is read back to them.');
    }
    if(!semantic||typeof semantic.write!=='function') return fail('memory store unavailable');
    try{
      var isIdentityClaim = IDENTITY_CLAIM_RE.test(text);
      var confidence = isIdentityClaim ? IDENTITY_QUARANTINE_CONFIDENCE : 0.9;
      var basisSource = consent.basis === 'approved-proposal' ? 'operator-approved' : 'voice-explicit';
      var sources = isIdentityClaim ? [basisSource,'identity-unconfirmed'] : [basisSource];
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
    }catch(err){return fail('remember failed: '+reasonText(err));}
  }

  // BUG-160: the missing half of remember(). Without it a spoken correction
  // could only ADD a fact next to the wrong one it contradicts — semantic
  // append-dedup is exact-match only, so "actually the URL is X" never
  // displaced "the URL is Y" and retrieval between the two was a coin flip
  // (the operator's "two brains" report, 2026-08-07 04:30). Echoes exactly
  // what it removed: the rewritten file is the oracle, and the spoken reply
  // must name the retired fact so a wrong match is heard immediately.
  async function forget_fact(args){
    var query=(args&&(args.query||args.text||args.fact)||'').trim();
    if(!query) return fail('query required — a distinctive phrase from the fact to forget');
    if(!semantic||typeof semantic.forget!=='function') return fail('memory store unavailable');
    try{
      var res=semantic.forget(query,{topic:(args&&args.topic)||''});
      if(res.error) return fail('forget_fact: '+res.error);
      // Wave 4 (2026-08-13): exact substring found nothing, but semantic.forget's
      // fuzzy fallback found MORE THAN ONE plausible match — a paraphrased forget
      // that happens to land on several stored facts (e.g. "forget the kids thing")
      // must ask which one rather than silently deleting the wrong fact or the
      // exact-match "no stored fact" message, which would be false here.
      if(!res.removed.length && res.candidates && res.candidates.length){
        var list=res.candidates.map(function(c,i){return (i+1)+'. "'+c.text+'" ('+c.topic+')';}).join('; ');
        return fail('Found '+res.candidates.length+' similar facts, none an exact match for "'+
          query.slice(0,80)+'" — which one? '+list);
      }
      if(!res.removed.length) return fail('No stored fact contains "'+query.slice(0,80)+'". Topics searched: '+(res.searched.join(', ')||'none'));
      return ok({forgot:res.removed,topic:res.topic,evidence:'removed '+res.removed.length+' fact(s) from Semantic/'+res.topic+'.md'+(res.matchedBy==='fuzzy'?' (paraphrase match)':'')});
    }catch(err){return fail('forget_fact failed: '+reasonText(err));}
  }

  // BUG-171: the same incident was written twice from one spoken report. The
  // model called log_incident, the turn re-derived, and it called it again —
  // two lines, two ids, one problem. Dedup on the normalized text within a
  // short window. Deliberately in-memory and deliberately short: this guards
  // against a double-fire inside one exchange, NOT against the operator
  // legitimately reporting the same recurring problem again an hour later,
  // which is real signal and must still be recorded.
  var INCIDENT_DEDUP_WINDOW_MS = 60000;
  var recentIncidents = new Map(); // normalized text -> { id, ts, date }

  // Incident ids were `inc-<ts>-<Math.random()>`. Two incidents logged in the
  // same millisecond is the only collision this has to survive, and a counter
  // covers that exactly — while a random suffix sitting one line away from a
  // `status:` field trips AD-5's fabricated-telemetry gate, which is a rule
  // worth keeping sharp rather than allowlisting around.
  var incidentSeq = 0;
  function nextIncidentId(now){
    incidentSeq += 1;
    return 'inc-'+now+'-'+incidentSeq;
  }

  function normalizeIncident(text){
    // BUG-171: ASCII-only keys collapsed distinct non-Latin reports into one.
    // Keep letters, numbers and combining marks; symbol-only reports retain
    // their original key instead of sharing an empty one. This is textual
    // deduplication, not evidence that paraphrases describe the same incident.
    var original=String(text).normalize('NFC').toLowerCase().replace(/\s+/g,' ').trim();
    var normalized=original.replace(/[^\p{L}\p{N}\p{M} ]+/gu,' ').replace(/\s+/g,' ').trim();
    // Variation selectors are marks too: a surviving mark without a letter
    // or number must not collapse different emoji into the same key.
    return /[\p{L}\p{N}]/u.test(normalized) ? normalized : original;
  }

  function pruneRecentIncidents(now){
    for (var entry of recentIncidents) {
      if (now - entry[1].ts >= INCIDENT_DEDUP_WINDOW_MS) recentIncidents.delete(entry[0]);
    }
  }

  async function log_incident(args){
    var text=(args&&(args.text||args.error||args.message)||'').trim();
    if(!text) return fail('text required — describe the incident');
    if(!fs||typeof fs.appendLine!=='function') return fail('fs store unavailable');
    try{
      var severity=(args&&args.severity)||'warn';
      var now=Date.now();
      var norm=normalizeIncident(text);
      pruneRecentIncidents(now);
      var prev=recentIncidents.get(norm);
      if (prev) {
        // Reported honestly rather than silently: the caller is told the
        // record exists and which one it is, so a "logged it" reply is true
        // without a second line appearing in the file.
        return ok({logged:text.slice(0,200),date:prev.date,deduped:true,existingId:prev.id,
          evidence:'already logged '+Math.round((now-prev.ts)/1000)+'s ago as '+prev.id+' — not written twice'});
      }

      var d=dayKey(now);   // F11: one date basis for every dated vault file
      var id=nextIncidentId(now);
      fs.ensureDir('Incidents');
      fs.appendLine('Incidents/'+d+'.jsonl',{id:id,ts:now,text:text,severity:severity,source:'voice',status:'open'});
      recentIncidents.set(norm,{id:id,ts:now,date:d});

      // Learning loop (Layer 3): incidents were write-only — nothing ever read
      // Incidents/ back. Also feed the lesson into the Lessons store so the goal
      // planner can ground against it next time. Best-effort: a failed lesson
      // write must NOT fail the incident log, so the operator's report still lands.
      if (memory && memory.lessons && typeof memory.lessons.recordFailure === 'function') {
        try { memory.lessons.recordFailure({ tool: '', goalTitle: text.slice(0, 60) }, text, { source: 'incident' }); } catch (_) {}
      }
      // BUG-171: index into semantic memory at write time, so recall_memory
      // can surface it. Incidents/ was a dead drop — the operator reported
      // problems all session and nothing could ever find them again, including
      // MYTHOS itself. Own topic, so this never contaminates user-facts.
      // Best-effort for the same reason as the lesson write above.
      if (semantic && typeof semantic.write === 'function') {
        try { semantic.write('incidents',['Incident '+id+' ('+severity+', '+d+'): '+text],
          {confidence:0.9,append:true,sources:['incident']}); } catch (_) {}
      }
      return ok({logged:text.slice(0,200),date:d,id:id,
        evidence:'wrote '+id+' to Incidents/'+d+'.jsonl'});
    }catch(err){return fail('log_incident failed: '+reasonText(err));}
  }

  // BUG-171: the read side. Incidents were written and never read by anything
  // — no tool, no route, no sensor — so "what bugs are still open" had no
  // answer and the log was, in the operator's words, a place reports went to
  // die. Status is not a field that gets rewritten in place (the file is
  // append-only jsonl by design); a status change appends a status line and
  // the LATEST one wins, so nothing is ever lost or overwritten.
  var INCIDENT_STATUSES = ['open','acknowledged','resolved'];
  var INCIDENT_SCAN_LIMIT = 500;

  function readIncidents(){
    if(!fs||typeof fs.readDirLinesReverse!=='function') return null;
    var lines=fs.readDirLinesReverse('Incidents',{limit:INCIDENT_SCAN_LIMIT})||[];
    var byId=new Map();
    var statusById=new Map();
    // newest-first, so the FIRST status line seen for an id is the latest one
    for (var i=0;i<lines.length;i++){
      var e=lines[i];
      if(!e||!e.id) continue;
      if(e.kind==='status'){
        if(!statusById.has(e.id)) statusById.set(e.id,{status:e.status,ts:e.ts,note:e.note||''});
        continue;
      }
      if(!byId.has(e.id)) byId.set(e.id,e);
    }
    var out=[];
    for (var rec of byId.values()){
      var st=statusById.get(rec.id);
      out.push({id:rec.id,ts:rec.ts,text:rec.text,severity:rec.severity||'warn',
        status:(st&&st.status)||rec.status||'open',
        statusNote:(st&&st.note)||'',
        statusTs:(st&&st.ts)||null});
    }
    out.sort(function(a,b){return (b.ts||0)-(a.ts||0);});
    return out;
  }

  function list_incidents(args){
    var incidents=readIncidents();
    if(incidents===null) return fail('incident log unavailable');
    var status=String((args&&args.status)||'open').toLowerCase();
    var limit=Number(args&&args.limit)||10;
    var filtered=(status==='all')?incidents:incidents.filter(function(i){return i.status===status;});
    if(!filtered.length){
      // Honest empty: "no open incidents" is an answer, and it must not be
      // confusable with "the log is broken" or with silence.
      return ok({status:status,count:0,incidents:[],
        note:'no '+(status==='all'?'':status+' ')+'incidents recorded'+
             (status!=='all'&&incidents.length?' ('+incidents.length+' total in the log, none '+status+')':'')});
    }
    return ok({status:status,count:filtered.length,total:incidents.length,
      incidents:filtered.slice(0,limit).map(function(i){
        return {id:i.id,text:i.text.slice(0,200),severity:i.severity,status:i.status,
          when:new Date(i.ts).toISOString().slice(0,16).replace('T',' ')};
      })});
  }

  function incident_status(args){
    var status=String((args&&args.status)||'').toLowerCase().trim();
    if(INCIDENT_STATUSES.indexOf(status)===-1){
      return fail('status must be one of: '+INCIDENT_STATUSES.join(', '));
    }
    var incidents=readIncidents();
    if(incidents===null) return fail('incident log unavailable');
    if(!fs||typeof fs.appendLine!=='function') return fail('fs store unavailable');

    var id=(args&&args.id||'').trim();
    var query=(args&&(args.query||args.text)||'').trim().toLowerCase();
    var target=null;
    if(id) target=incidents.find(function(i){return i.id===id;})||null;
    else if(query){
      var matches=incidents.filter(function(i){return i.text.toLowerCase().indexOf(query)!==-1;});
      if(matches.length>1){
        // Never guess which one. Naming the candidates back is what lets the
        // operator disambiguate by voice in one more turn.
        return fail(matches.length+' incidents match "'+query.slice(0,60)+'". Use id — candidates: '+
          matches.slice(0,5).map(function(i){return i.id+' ("'+i.text.slice(0,50)+'")';}).join('; '));
      }
      target=matches[0]||null;
    } else {
      return fail('id or query required — which incident to update');
    }
    if(!target) return fail('No incident matches '+(id?('id '+id):('"'+query.slice(0,60)+'"'))+'.');
    if(target.status===status){
      return ok({id:target.id,status:status,unchanged:true,
        evidence:target.id+' was already '+status});
    }

    try{
      var d=dayKey();      // F11: one date basis for every dated vault file
      fs.ensureDir('Incidents');
      fs.appendLine('Incidents/'+d+'.jsonl',
        {kind:'status',id:target.id,status:status,ts:Date.now(),note:(args&&args.note)||'',source:'voice'});
      return ok({id:target.id,text:target.text.slice(0,120),from:target.status,status:status,
        evidence:'appended status '+status+' for '+target.id+' to Incidents/'+d+'.jsonl'});
    }catch(err){return fail('incident_status failed: '+reasonText(err));}
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
      var raw=(hits||[]).length;
      var results=(hits||[]).map(function(h){
        return {store:h.store,snippet:h.snippet||(h.record&&h.record.summary)||'',score:h.score};
      }).filter(function(r){ return r.snippet; });
      // BUG-172: an empty recall used to return a bare {count:0,results:[]},
      // which the model read as "the tool worked" and reported as "I recalled
      // that" with nothing behind it. A zero result is a real answer and has
      // to say so in words the reply cannot round off. The raw-vs-kept split
      // matters: "nothing matched" and "matches came back empty" are different
      // failures, and only the second one points at the store.
      if(!results.length){
        return ok({query:query,count:0,results:[],
          note:raw
            ? 'NO USABLE MEMORIES: '+raw+' match(es) came back with empty text. Tell the user you found nothing for "'+query.slice(0,60)+'" — do not invent a recollection.'
            : 'NO MATCHING MEMORIES for "'+query.slice(0,60)+'". Say you do not have anything stored about this — do not invent a recollection.'});
      }
      return ok({query:query,count:results.length,results:results});
    }catch(err){return fail('recall_memory failed: '+reasonText(err));}
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

  // ---- Notes (Obsidian-compatible markdown) --------------------------------
  //
  // These sit next to remember/recall_memory deliberately rather than in a new
  // effector file: the operator says "note that down" and "what did I remember
  // about X" in the same breath, and splitting the family across files is how
  // the model ends up reaching for the wrong half. remember() stores a FACT
  // MYTHOS asserts; note_take stores a DOCUMENT the operator owns and can open
  // in Obsidian. The tool descriptions have to keep that line visible, because
  // nothing else will.
  //
  // Every result carries an oracle-backed `evidence` string (real path + real
  // byte count from statSync, or the real match count) — never a bare ok:true.
  // The evidence contract exists because a UI-type action once audited as
  // delivered while the target app never received the text.

  function notesUnavailable(){
    return fail('notes store unavailable — MYTHOS_NOTES_DIR could not be resolved');
  }

  // BUG-451 (2026-09-23): the entry MYTHOS writes carries its provenance, set by
  // the server from the text (memory/provenance.js), never by the model: a note
  // that states a cause is a HYPOTHESIS. The marker is an HTML comment, so it is
  // hidden in Obsidian's reading view and travels with the entry into note_read;
  // it labels only the entry being written — earlier content, and anything the
  // operator wrote, is left exactly as it is. The result says the label too, so
  // the model is told at once that its diagnosis was stored as a guess.
  var provenanceOf=require('../memory/provenance').provenanceOf;
  function markEntry(text,label){
    return '<!-- mythos-provenance: '+label+(label==='hypothesis'?' (states a cause MYTHOS has not verified)':'')+' -->\n'+text;
  }

  async function note_take(args){
    if(!notes||typeof notes.write!=='function') return notesUnavailable();
    var title=(args&&(args.title||args.name)||'').trim();
    var text=(args&&(args.text||args.body||args.content)||'').trim();
    if(!title) return fail('title required — what to call the note');
    if(!text) return fail('text required — the note body');
    var label=provenanceOf(text);
    try{
      var res=notes.write({title:title,text:markEntry(text,label),mode:(args&&args.mode)||'append',
        tags:(args&&args.tags)||[]});
      return ok({title:res.title,file:res.slug+'.md',mode:res.mode,bytes:res.bytes,provenance:label,
        evidence:(res.created?'created ':'updated ')+res.path+' ('+res.bytes+' bytes on disk)'
          +(label==='hypothesis'?'; stored as an unverified hypothesis, because it states a cause':'')});
    }catch(err){return fail('note_take failed: '+reasonText(err));}
  }

  async function note_read(args){
    if(!notes||typeof notes.read!=='function') return notesUnavailable();
    // BUG-320: strip wiki-link brackets. The model asked for
    // note_read({title:"[[ai-news-digest-v2]]"}) three times across two sessions
    // — the vault's own notes are written with [[...]] links, so it reads a link
    // and passes it back verbatim. The brackets never matched, the error listed
    // the real notes beside a bracketed name, and the healer recorded the same
    // lesson twice. Nothing was broken except the argument.
    var title=stripWikiLink((args&&(args.title||args.name||args.query)||''));
    if(!title){
      // No title given = "what notes do I have". A list is a real answer here,
      // and it is what lets the model name a note back instead of guessing one.
      var all=notes.list();
      if(!all.notes.length){
        return ok({count:0,notes:[],evidence:'no .md notes in '+notes.notesDir(),
          note:'NO NOTES EXIST YET. Say so — do not describe a note you have not read.'});
      }
      return ok({count:all.notes.length,notes:all.notes.map(function(n){return n.slug;}).slice(0,50),
        truncated:all.truncated,evidence:'listed '+all.notes.length+' note file(s) in '+notes.notesDir()});
    }
    try{
      var res=notes.read(title);
      if(!res){
        var listed=notes.list();
        return fail('No note called "'+title.slice(0,60)+'". '+
          (listed.notes.length?('Existing notes: '+listed.notes.map(function(n){return n.slug;}).slice(0,15).join(', ')):'There are no notes yet.'));
      }
      return ok({title:res.title,file:res.slug+'.md',bytes:res.bytes,content:res.content.slice(0,8000),
        evidence:'read '+res.path+' ('+res.bytes+' bytes)'});
    }catch(err){return fail('note_read failed: '+reasonText(err));}
  }

  async function note_search(args){
    if(!notes||typeof notes.search!=='function') return notesUnavailable();
    var query=(args&&(args.query||args.text)||'').trim();
    if(!query) return fail('query required — what to search the notes for');
    try{
      var res=notes.search(query,{limit:(args&&args.limit)||10});
      if(!res.matches.length){
        // BUG-172 shape: an empty result is a real answer and must say so in
        // words the spoken reply cannot round off into "I found your note".
        return ok({query:query,count:0,matches:[],
          evidence:'searched '+res.scanned+' note file(s) in '+notes.notesDir()+', 0 matches',
          note:'NO NOTE MATCHES "'+query.slice(0,60)+'". Say you found nothing — do not invent a note.'});
      }
      return ok({query:query,count:res.matches.length,truncated:res.truncated,
        matches:res.matches.map(function(m){return {note:m.slug,matchedIn:m.matchedIn,line:m.line};}),
        evidence:'searched '+res.scanned+' note file(s), '+res.matches.length+' match(es)'});
    }catch(err){return fail('note_search failed: '+reasonText(err));}
  }

  return [
    // BUG-447 (2026-09-24): Gemini records an answer the operator barged into as fully said, so "go ahead" found nothing to resume. Reads this connection's unheard remainder once; text only.
    {name:'resume_interrupted_answer',description:'Use ONLY when the operator interrupted your last spoken answer and now asks you to continue ("go ahead", "carry on", "sorry, you were saying"). Returns the part of that answer they did NOT hear: their side cut the audio, so your own history shows it as said. Say it from its start, in your own words. Returns nothing when they heard it all. Read-only: it runs nothing again.',params:{},danger:false,fn:resumeInterruptedAnswer},
    {name:'suggest_procedures',description:'Recall stored procedures when the user asks to repeat a familiar task or asks how a past workflow was done. Read-only, untrusted guidance: never replay automatically. Resolve current targets and choose normal tools individually; pass skillRef on a chosen step to attribute its actual outcome. No matching suggestion means no stored guidance.',params:{query:'string — the current task to find guidance for'},danger:false,needs_result:true,fn:async function(args){
      if(!args || typeof args.query !== 'string' || !args.query.trim()) return fail('query required');
      if(!memory || !memory.skills || typeof memory.skills.suggest !== 'function') return fail('procedure store unavailable');
      try { return ok(await memory.skills.suggest(args.query.trim())); }
      catch(err) { return fail('procedure recall failed: '+reasonText(err)); }
    }},
    {name:'note_take',description:'Write a note as a real markdown file the user can open in Obsidian. Use when the user says "take a note","write this down","start a note about X","add to my X note". Obsidian conventions apply: [[wikilinks]] and #tags in the text are kept verbatim. Use this for the user\'s OWN documents and longer content; use remember for a short standing fact or preference about the user.',params:{title:'string — the note title (becomes the filename)',text:'string — the note body (markdown; [[wikilinks]] allowed)',mode:'string (optional) — append (default, adds under a timestamp) or replace',tags:'array (optional) — tag strings for the note frontmatter'},danger:false,fn:note_take},
    {name:'note_read',description:'Read one of the user\'s markdown notes back, or list the notes that exist when called with no title. Use for "read my X note","what\'s in my X note","what notes do I have". Read-only.',params:{title:'string (optional) — the note title to read; omit to list all notes'},danger:false,fn:note_read,needs_result:true},
    {name:'note_search',description:'Search the text of the user\'s markdown notes for a word or phrase. Use for "find the note where I wrote about X","search my notes for X". Returns the matching line from each note so you can quote it. Read-only.',params:{query:'string — the word or phrase to look for',limit:'number (optional) — max results, default 10'},danger:false,fn:note_search,needs_result:true},
    {name:'self_capabilities',description:'Read your own capabilities manifest (tools, tiers, adapters, skills, recent code changes — regenerated every boot). Use when the user asks "what can you do", "what are your capabilities", "what tools do you have for X", or "what\'s new/changed". Pass topic to filter (e.g. "spotify").',params:{topic:'string (optional) — filter lines matching this word'},danger:false,fn:self_capabilities},
    {name:'remember',description:'Save a durable fact, preference, or instruction to permanent memory. Use when user says "remember","note that","don\'t forget","from now on","keep in mind", or states a standing rule. Persists across restarts. When the user CORRECTS something previously remembered, call forget_fact for the old fact first, then remember the corrected one.',params:{text:'string — the fact/preference/instruction'},danger:false,fn:remember},
    {name:'forget_fact',description:'Remove a wrong or outdated fact from permanent memory. Use when the user says "forget that","that\'s wrong, the real X is...","delete that memory", or corrects something previously remembered. Echoes exactly what was removed — repeat it back so the user can catch a wrong match.',params:{query:'string — a distinctive phrase from the fact to remove',topic:'string (optional) — memory topic file to search, e.g. user-facts'},danger:false,fn:forget_fact},
    {name:'log_incident',description:'Record an error/bug/incident the OPERATOR explicitly asks to log. Use ONLY when the operator says "log this","this is wrong","you hallucinated","log this as an error" — a direct request to log, spoken or typed. Do NOT call this on your own initiative to record a mistake you noticed yourself, a tool failure, or anything the operator did not ask you to log; noticing something is wrong is not the same as being asked to log it. Persists to durable incident log.',params:{text:'string — describe the incident',severity:'string (optional) — info|warn|error (default warn)'},danger:false,fn:log_incident},
    {name:'recall_memory',description:'Search past conversations and remembered facts for something relevant. Use when the user references something from earlier that you don\'t have in front of you, or directly asks "what did I say about X" / "do you remember X". Read-only.',params:{query:'string — what to search memory for',limit:'number (optional) — max results, default 8'},danger:false,fn:recall_memory},
    {name:'list_incidents',description:'Read back the incidents the user has logged. Use for "what bugs are open", "what did I report", "any incidents today". Read-only.',params:{status:'string (optional) — open|acknowledged|resolved|all (default open)',limit:'number (optional) — max results, default 10'},danger:false,fn:list_incidents,needs_result:true},
    {name:'incident_status',description:'Mark a logged incident acknowledged or resolved. Use when the user says "that one is fixed","mark it resolved","I know about that one". Identify it by id, or by a distinctive phrase from the incident text.',params:{status:'string — open|acknowledged|resolved',id:'string (optional) — the incident id',query:'string (optional) — a distinctive phrase from the incident text',note:'string (optional) — why'},danger:false,fn:incident_status}
  ];
}
function registerFromMemory(hub,ctx){var t=buildTools(ctx);for(var i=0;i<t.length;i++)hub.register(effectorFromTool(t[i]));return{count:t.length};}
module.exports={registerFromMemory,buildTools};
