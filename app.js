'use strict';
/* Additional v1 UI. The original simulation core remains available offline. */

/* Add useful what-if suggestions for fixed-count writes and strcat. */
const baseHypotheses=deriveHypotheses;
deriveHypotheses=function(events){
  const proposals=baseHypotheses(events);
  for(let i=0;i<events.length;i++){
    const e=events[i];
    if(!['strncpy','memcpy','fill','strcat','strncat'].includes(e.op))continue;
    let capacity=null;
    for(let j=i-1;j>=0;j--){
      const a=events[j];if(a.var!==e.var)continue;
      if(['malloc','calloc','realloc'].includes(a.op)){
        capacity=a.op==='calloc'?Number(a.args[0])*Number(a.args[1]):Number(a.args[a.op==='realloc'?1:0]);break;
      }
    }
    if(!Number.isSafeInteger(capacity)||capacity<0)continue;
    if(['memcpy','strncpy'].includes(e.op)&&Number.isInteger(e.limit)){
      const exceeds=e.limit>capacity;
      proposals.push({text:`${e.op}(${e.var}, …, ${e.limit}) écrit potentiellement ${e.limit} octets dans un buffer de ${capacity}. ${exceeds?'Dans le modèle, cette taille dépasse le tampon.':'Essayer une longueur supérieure à '+capacity+' pour tester la limite si elle est contrôlable.'} ${e.lengthArg?'L’argument argv['+e.lengthArg+'] contrôle cette longueur.':'La source de la longueur n’est pas confirmée.'} À confirmer par ASan.`,payload:e.lengthArg?String(capacity+1):null,argv:e.lengthArg||'2',needed:capacity+1});
    }
    if(e.op==='fill'&&e.count>capacity){
      proposals.push({text:`memset/fill : ${e.count} octets prévus pour ${capacity} octets demandés. Teste une taille bornée avant l’écriture.`,payload:null,argv:'2',needed:capacity});
    }
    if(e.op==='strcat'||e.op==='strncat'){
      proposals.push({text:`${e.op} ajoute du texte à ${e.var} : il faut additionner la longueur déjà présente, celle ajoutée et le NUL terminal. Le simulateur vérifie l’espace restant si une fin de chaîne est connue.`,payload:null,argv:e.argvSource||'1',needed:capacity});
    }
  }
  return proposals;
};
const earlierSourceRun=$('sourceRun').onclick;
$('sourceRun').onclick=()=>{
  earlierSourceRun();
  if(/\b(if|while|for|switch)\s*\(/.test($('sourcecode').value)){
    state.parserWarnings=[...(state.parserWarnings||[]),'ATTENTION : les conditions et boucles ne sont pas évaluées ; les opérations reconnues sont déroulées dans l’ordre textuel.'];
    render();
  }
};

const baseLoad = load;
const baseRender = render;
state.mode = 'simulation';
state.realRecords = [];
state.lastReal = null;
load = function(events, warnings=[]){
  state.mode='simulation';state.realRecords=[];state.lastReal=null;
  baseLoad(events,warnings);
};
render = function(){
  baseRender();
  $('modeLabel').textContent=state.mode==='reel'
    ? 'OBSERVÉ · glibc x86-64 · snapshots aux appels'
    : state.mode==='options'?'HYPOTHÈSE · options CLI ↔ règles déclarées':'SIMULÉ · glibc 64 bits simplifiée';
};

/* Extract shell-like argv but never invoke a shell; the server passes a list. */
function shellTokens(s){
  const tokens=[], re= /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"']+/g;
  for (const part of (s.match(re)||[])){
    let t=part;
    if(t[0]==='"'&&t.at(-1)==='"'){
      try{t=JSON.parse(t);}catch{t=t.slice(1,-1);}
    } else if(t[0]==="'"&&t.at(-1)==="'")t=t.slice(1,-1);
    tokens.push(t);
  }
  return tokens;
}
function cliVars(s){
  const t=shellTokens(s),vars={};
  for(let i=0;i<t.length;i++){
    const x=t[i];if(!/^--[a-zA-Z][\w-]*/.test(x))continue;
    let [k,...v]=x.slice(2).split('=');
    const value=v.length?v.join('='):(t[i+1]&&!t[i+1].startsWith('--')?t[++i]:'1');
    vars[k.replaceAll('-','_')]=value;
  }
  return vars;
}
function optionsToScript(args,rules){
  const vars=cliVars(args);
  const missing=new Set();
  const resolved=rules.replace(/\$([a-zA-Z_]\w*)/g,(_,name)=>{
    if(!(name in vars)){missing.add(name);return `"<MISSING:${name}>"`;}
    const value=vars[name];
    return /^\d+$/.test(value)?value:JSON.stringify(value);
  });
  if(missing.size)throw Error('Options absentes pour les règles : '+[...missing].map(x=>'--'+x).join(', '));
  return resolved;
}
$('optionsRun').onclick=()=>{
  try{
    const scenario=optionsToScript($('cliArgs').value,$('cliRules').value);
    const parsed=parseScript(scenario);
    if(!parsed.events.length)throw Error('Aucune opération prise en charge. Vérifie les règles.');
    load(parsed.events,parsed.ignored.length?[`Lignes de règles ignorées : ${parsed.ignored.join(', ')}`]:[]);
    state.mode='options';render();
    $('optionsNotice').textContent='Hypothèse simulée à partir des règles que tu as écrites (et non inférée du programme). Scénario obtenu : '+scenario.replace(/\n/g,'  →  ');
  }catch(err){alert(err.message);}
};
$('optionsPreset').onclick=()=>{
  $('cliArgs').value='--size 24 --data '+ 'A'.repeat(24)+' --free';
  $('cliRules').value='A = malloc($size)\nB = malloc(32)\nstrcpy(A, $data)\nfree(A)';
  $('optionsRun').click();
};

/* Restore the model confidence labels when the user loads normal JSON events. */
function pointer(p){
  if(typeof p!=='string'||p==='(nil)'||p==='0x0'||p==='0x0000000000000000')return null;
  try {return Number(BigInt(p));}catch{return null;}
}
function byteArr(hex){
  if(typeof hex!=='string'||!/^(?:[0-9a-fA-F]{2})*$/.test(hex))return [];
  return (hex.match(/.{2}/g)||[]).map(x=>parseInt(x,16));
}
function nativeChunk(a,id){
  const addr=pointer(a.ptr),request=Number(a.requested)||0;
  if(addr===null)return null;
  let raw=0;
  try{raw=Number(BigInt(a.raw_size||'0x0'));}catch{}
  const physical=(raw&~15)||cap(request);
  const data=Array(Math.min(Math.max(physical,96),4096)).fill(null);
  let rawCopy=raw;
  for(let k=0;k<8;k++){data[8+k]=rawCopy&255;rawCopy=Math.floor(rawCopy/256);}
  for(const [j,byte] of byteArr(a.hex).entries())if(16+j<data.length)data[16+j]=byte;
  return {id,start:addr-16,size:physical,requested:request,usable:Math.max(0,Number(a.usable)||0),
    var:'ptr '+a.ptr,freed:false,damaged:false,data,rawSize:a.raw_size};
}
function nativeDescription(e){
  const loc=e.ptr==='(nil)'?'NULL':e.ptr;
  if(e.op==='free-before')return `Avant free(${loc}) · snapshot du contenu`;
  if(e.op==='free')return `free(${loc}) · libération observée`;
  if(e.op==='exit')return 'Fin du programme · dernier snapshot';
  if(e.op==='calloc')return `calloc(${e.count}, ${e.size}) → ${loc}`;
  if(e.op==='realloc')return `realloc(${e.old}, ${e.size}) → ${loc}`;
  return `malloc(${e.size}) → ${loc}`;
}
function nativeFrames(records){
  const live=new Map(),freed=new Map(),frames=[];
  let nextId=1;
  const makeFrame=(desc)=>{
    let chunks=[...freed.values(),...live.values()].sort((a,b)=>a.start-b.start);
    /* Allocated locations replace prior freed generations. */
    let allocated=[...live.values()].map(c=>c.id);
    chunks=chunks.filter(c=>!allocated.includes(c.id)); // no-op for distinct generations
    chunks.push(...live.values());
    chunks.sort((a,b)=>a.start-b.start);
    frames.push({desc,kind:'native',heap:{chunks:clone(chunks),pointers:{},issues:[]}});
  };
  makeFrame('État initial · aucune allocation observée par le traceur.');
  for(const e of records.slice(0,350)){
    const p=e.ptr,op=e.op;
    if(op==='malloc'||op==='calloc'||op==='realloc'){
      if(op==='realloc'&&e.old&&e.old!==p&&live.has(e.old)){
        const old=live.get(e.old);old.freed=true;freed.set(e.old,old);live.delete(e.old);
      }
      if(p&&p!=='(nil)'){
        freed.delete(p);
        const existing=live.get(p);
        if(existing)live.delete(p);
        const found=(e.allocations||[]).find(x=>x.ptr===p)||{ptr:p,requested:(e.op==='calloc'?Number(e.count)*Number(e.size):Number(e.size))};
        const c=nativeChunk(found,++nextId);
        if(c)live.set(p,c);
      }
    }
    /* Every intercept emits snapshots for tracked live allocations. */
    for(const a of (e.allocations||[])){
      let c=live.get(a.ptr);
      if(c){const recent=nativeChunk(a,c.id);if(recent)live.set(a.ptr,recent);}
    }
    if(op==='free'&&live.has(p)){
      const c=live.get(p);c.freed=true;freed.set(p,c);live.delete(p);
    }
    makeFrame(nativeDescription(e));
  }
  return frames;
}
function showConsole(text){
  $('nativeResult').style.display='block';
  $('nativeConsole').textContent=text;
}
function loadNative(result,label='ELF'){
  const events=result.events||[];
  if(!events.length){
    showConsole(`Aucun malloc/free intercepté.\nSortie code : ${result.exit_code}\n`+
      `STDOUT:\n${result.stdout||''}\nSTDERR:\n${result.stderr||''}\n`+
      (result.build_error||'Le programme peut être statique, ne pas allouer, ou avoir quitté trop tôt.'));
    return;
  }
  state.mode='reel';state.events=[];state.realRecords=events;state.lastReal=result;
  state.frames=nativeFrames(events);state.step=state.frames.length-1;state.hypotheses=[];
  state.parserWarnings=[`Capture ${label} : ${events.length} événements bruts. Snapshots effectués uniquement aux appels interceptés ; pas de preuve automatique d’overflow.`,
    result.invalid_events?`${result.invalid_events} lignes de trace invalides.`:''].filter(Boolean);
  render();
  $('hypotheses').innerHTML='<div class="info">Observation réelle des allocations, tailles et octets aux points d’interception. Pour confirmer un débordement, recompile avec ASan depuis « Code C » ou utilise GDB/Pwndbg. L’absence d’alerte ici ne garantit pas la sûreté du binaire.</div>';
  showConsole(`MODE : ${label} / observation glibc réelle\nCode de sortie : ${result.exit_code}`+
    (result.timed_out?' (temps limite dépassé)':'')+
    `\nÉvénements capturés : ${events.length}\n\nSTDOUT\n${result.stdout||'(vide)'}\n\nSTDERR\n${result.stderr||'(vide)'}`+
    (result.compiler_warnings?`\n\nCompilateur\n${result.compiler_warnings}`:''));
}
function showAsan(result){
  const diagnostic=result.build_error||result.stderr||'(aucun diagnostic stderr)';
  const match=/ERROR: AddressSanitizer:\s*([^\s]+)/.exec(diagnostic)||/runtime error: ([^\n]+)/.exec(diagnostic);
  const headline=match?`ALERTE CONFIRMÉE PAR INSTRUMENTATION : ${match[1]}`:
    result.exit_code===0?'Aucun incident détecté sur cette exécution (pas une preuve d’absence de vulnérabilité).':
      'Exécution non concluante / arrêt anormal ; examine le diagnostic ci-dessous.';
  showConsole(`VALIDATION ASan/UBSan · layout mémoire différent du traceur\n${headline}`+
    `\nCode de sortie : ${result.exit_code}\n`+
    (result.timed_out?'Temps limite dépassé\n':'')+
    `\nDIAGNOSTIC\n${diagnostic}\n\nSTDOUT\n${result.stdout||'(vide)'}`);
}
async function health(){
  try{
    const response=await fetch('/api/health',{signal:AbortSignal.timeout(1700)});
    if(!response.ok)throw Error('API indisponible');
    const d=await response.json();
    $('serverState').innerHTML=d.ready&&d.gcc?`<div class="ok">Moteur local connecté · ${esc(d.libc)} · ${esc(d.arch)} · gcc détecté</div>`:
      '<div class="warn">Moteur natif indisponible (Linux glibc x86-64 + gcc requis).</div>';
  }catch{
    $('serverState').innerHTML='<div class="info">Mode hors ligne : simulation disponible. Pour tracer un ELF, démarrer <code>python3 server.py</code> sous Linux puis ouvrir <code>http://127.0.0.1:8765</code>.</div>';
  }
}
async function callNative(endpoint,data,button){
  const old=button.textContent;button.disabled=true;button.textContent='Analyse en cours…';
  try{
    const res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-HeapLab-Run':'local-execution'},body:JSON.stringify({...data,consent:true})});
    const result=await res.json();
    if(!res.ok)throw Error(result.error||'Erreur du moteur natif');
    return result;
  }catch(err){showConsole('Erreur : '+err.message+'\nLa simulation hors ligne reste disponible.');return null;}
  finally{button.disabled=false;button.textContent=old;}
}
$('nativeSource').onclick=async()=>{
  if(!$('sourceConsent').checked){alert('Coche d’abord l’autorisation explicite : le code C sera réellement exécuté.');return;}
  const args=[$('arg1').value,$('arg2').value];
  const result=await callNative('/api/run-source',{source:$('sourcecode').value,args,language:$('sourceLang').value,stdin:$('sourceStdin').value},$('nativeSource'));
  if(result)loadNative(result,'Source C/C++ compilé');
};
$('asanSource').onclick=async()=>{
  if(!$('sourceConsent').checked){alert('Autorise d’abord l’exécution locale du code.');return;}
  const result=await callNative('/api/run-asan',{source:$('sourcecode').value,args:[$('arg1').value,$('arg2').value],language:$('sourceLang').value,stdin:$('sourceStdin').value},$('asanSource'));
  if(result)showAsan(result);
};
$('elfRun').onclick=async()=>{
  if(!$('elfConsent').checked){alert('Coche l’autorisation d’exécution locale dans une VM de labo.');return;}
  const file=$('elfFile').files?.[0];
  if(!file){alert('Sélectionne un fichier ELF.');return;}
  if(file.size>8*1024*1024){alert('Limite 8 Mio pour un fichier ELF.');return;}
  const base64=await new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(fr.result.split(',')[1]);fr.onerror=()=>rej(Error('Fichier illisible'));fr.readAsDataURL(file);});
  const r=await callNative('/api/run-elf',{content:base64,args:shellTokens($('elfArgs').value)},$('elfRun'));
  if(r)loadNative(r,'ELF '+file.name);
};
$('elfDemo').onclick=async()=>{
  if(!$('elfConsent').checked){alert('Autorise d’abord l’exécution locale.');return;}
  const r=await callNative('/api/run-demo',{args:shellTokens($('elfArgs').value)},$('elfDemo'));
  if(r)loadNative(r,'Démo native');
};

/* Import JSON array from the simulator OR JSON Lines emitted by the tracer. */
$('traceRun').onclick=()=>{
  try{
    const s=$('tracecode').value.trim();
    let values;
    if(s.startsWith('['))values=JSON.parse(s);
    else values=s.split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));
    if(!Array.isArray(values)||!values.length)throw Error('Trace vide.');
    if('ptr' in values[0]&&'allocations' in values[0]){
      loadNative({events:values,exit_code:'trace importée',stdout:'',stderr:''},'JSONL importé');
    }else load(fromTrace(JSON.stringify(values)));
  }catch(e){alert('Trace invalide : '+e.message);}
};
$('traceFile').onchange=async(e)=>{
  const f=e.target.files?.[0];if(!f)return;
  $('tracecode').value=await f.text();
  $('traceRun').click();
};
$('exportBtn').onclick=()=>{
  const array=state.mode==='reel'?state.realRecords:state.events;
  const blob=new Blob([JSON.stringify(array,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='heaplab-'+(state.mode==='reel'?'native-':'sim-')+'trace.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
};
health();
render();

// Exercice pas à pas : trois débordements successifs de l'en-tête suivant.
$('loadOverflowExercise').onclick=()=>{
  $('scenario').value='a = malloc(32)\nb = malloc(32)\nc = malloc(32)\nfill(a, 0x41, 50)\nfill(b, 0x42, 50)\nfill(c, 0x43, 50)\nfree(c)\nfree(b)\nfree(a)';
  $('scriptRun').click();
  state.step=3;render();
};
