
'use strict';
const $ = id => document.getElementById(id), tabs=document.querySelectorAll('.tab');
const state={events:[],frames:[],step:0,issues:[],hypotheses:[]};
function esc(s){return String(s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
function fmt(n){return '0x'+Math.trunc(n).toString(16).padStart(8,'0');}
function nparse(x){const v=String(x).trim();return /^0x[\da-f]+$/i.test(v)?parseInt(v,16):/^\d+$/.test(v)?Number(v):NaN;}
function cap(x){return Math.max(32,Math.ceil((x+8)/16)*16);}
function textBytes(s){return Array.from(new TextEncoder().encode(s));}
function getArg(i){return $('arg'+i)?.value??'';}
function stripComments(s){return s.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');}
function parseValue(expr){expr=expr.trim();if(/^"(?:\\.|[^"\\])*"$/.test(expr)){try{return JSON.parse(expr);}catch{return expr.slice(1,-1);}}let m=expr.match(/^argv\s*\[\s*(\d+)\s*\]$/);if(m)return getArg(Number(m[1]));return expr;}
function evalNum(expr,env={}){expr=expr.trim().replace(/\(\s*(?:size_t|int|unsigned|long)\s*\)/g,'');let m=expr.match(/^(?:atoi|atol|strtoul)\s*\(\s*argv\s*\[\s*(\d+)\s*\](?:\s*,[^)]*)?\)$/);if(m)return Number.parseInt(getArg(+m[1]),10);m=expr.match(/^strlen\s*\(\s*(.+?)\s*\)$/);if(m)return textBytes(parseValue(m[1])).length;let safe=expr.replace(/\b([A-Za-z_]\w*)\b/g,(name)=>Object.prototype.hasOwnProperty.call(env,name)?String(env[name]):name);if(!/^[0-9xXa-fA-F+*\/()\s-]+$/.test(safe))return NaN;try{let tokens=safe.match(/0[xX][0-9a-fA-F]+|\d+|[()+*\/-]/g)||[];if(tokens.join('').replace(/\s/g,'')!==safe.replace(/\s/g,''))return NaN;let idx=0;function factor(){let t=tokens[idx++];if(t==='('){let n=add();if(tokens[idx++]!==')')throw Error();return n;}if(t==='-')return -factor();let v=nparse(t);if(!Number.isFinite(v))throw Error();return v;}function mul(){let a=factor();while(tokens[idx]==='*'||tokens[idx]==='/'){let op=tokens[idx++],b=factor();a=op==='*'?a*b:a/b;}return a;}function add(){let a=mul();while(tokens[idx]==='+'||tokens[idx]==='-'){let op=tokens[idx++],b=mul();a=op==='+'?a+b:a-b;}return a;}let ret=add();return idx===tokens.length&&Number.isSafeInteger(ret)&&ret>=0?ret:NaN;}catch{return NaN;}}
function argSplit(s){const r=[];let cur='',dep=0,quoted=false,escape=false;for(const c of s){if(escape){cur+=c;escape=false;continue;}if(c==='\\'&&quoted){cur+=c;escape=true;continue;}if(c==='"'){quoted=!quoted;cur+=c;continue;}if(!quoted&&c==='(')dep++;if(!quoted&&c===')')dep--;if(c===','&&dep===0&&!quoted){r.push(cur.trim());cur='';continue;}cur+=c;}r.push(cur.trim());return r;}
function splitStmt(source){let ss=stripComments(source),out=[],t='',quoted=false,escape=false;for(const c of ss){if(escape){t+=c;escape=false;continue;}if(c==='\\'&&quoted){t+=c;escape=true;continue;}if(c==='"'){t+=c;quoted=!quoted;continue;}if(c===';'&&!quoted){out.push(t.trim());t='';}else t+=c;}return out;}
function lineOp(s,env){let m;const original=s.trim(),line=original.replace(/^[\s{}]+/,'').trim();if(!line||line.startsWith('#'))return null;
if((m=line.match(/(?:^|\s)(?:size_t|int|unsigned\s+int|long)\s+(\w+)\s*=\s*(.+)$/))){let n=evalNum(m[2],env);if(Number.isFinite(n))env[m[1]]=n;}
if((m=line.match(/(?:^|\s)(?:\w+[\s*]+)?(\w+)\s*=\s*(malloc|calloc|realloc)\s*\((.+)\)\s*$/))){let a=argSplit(m[3]),nums=a.map(v=>evalNum(v,env));return {op:m[2],var:m[1],args:nums,raw:original};}
if((m=line.match(/\bfree\s*\(\s*(\w+)\s*\)/)))return {op:'free',var:m[1],raw:original};
if((m=line.match(/\b(strcpy|strncpy|strcat|strncat|memcpy|memset|write|fill)\s*\((.+)\)/))){let args=argSplit(m[2]);let op=m[1];if(['strcpy','strncpy','strcat','strncat','memcpy','write'].includes(op))return {op:op==='write'?'write':op,var:args[0],value:parseValue(args[1]||''),limit:args[2]===undefined?NaN:evalNum(args[2],env),raw:original,argvSource:/^argv\s*\[\s*(\d+)\s*\]$/.exec(args[1]||'')?.[1],lengthArg:/argv\s*\[\s*(\d+)\s*\]/.exec(args[2]||'')?.[1]};if(op==='fill'||op==='memset')return {op:'fill',var:args[0],byte:evalNum(args[1],env),count:evalNum(args[2],env),raw:original};}
return null;}
function parseScript(s){let env={},events=[],ignored=[];for(let [i,l] of s.split('\n').entries()){let line=l.replace(/\/\/.*$/,'').trim();if(!line||line[0]==='#')continue;let op=lineOp(line,env);if(op)events.push(op);else ignored.push(i+1);}return {events,ignored};}
function parseSource(s){s=s.replace(/^\s*#.*$/gm,'');let env={},events=[],ignored=0;for(let fragment of splitStmt(s)){let op=lineOp(fragment,env);if(op)events.push(op);else if(/\b(malloc|calloc|realloc|free|strcpy|strcat|strncat|memcpy|strncpy|memset)\s*\(/.test(fragment))ignored++;}return {events,ignored};}
function fromTrace(s){let raw=JSON.parse(s);if(!Array.isArray(raw))throw new Error('La trace doit être un tableau JSON.');return raw.map((e,i)=>{if(!e||!e.op)throw Error('Événement '+i+' invalide');return {...e,args:e.args??(e.op==='calloc'?[e.count,e.size]:[e.size]),raw:e.raw??`${e.op}(${e.var??''})`};});}
function clone(v){return JSON.parse(JSON.stringify(v));}
function bytesToString(b){return b.slice(0,32).map(x=>x===null?'·':x===0?'\\0':x>=32&&x<=126?String.fromCharCode(x):'.').join('')+(b.length>32?'…':'');}
function writeToHeap(heap,chunk,bytes,start=0){
  let unmapped=0,damage=[];
  for(let i=0;i<bytes.length;i++){
    const addr=chunk.start+16+start+i;
    const into=heap.chunks.find(c=>addr>=c.start&&addr<c.start+c.size);
    if(!into){unmapped++;continue;}
    const at=addr-into.start;
    into.data[at]=bytes[i];
    if(into!==chunk){
      into.damaged=true;
      if(!into.corruptedOffsets)into.corruptedOffsets=[];
      if(!into.corruptedOffsets.includes(at))into.corruptedOffsets.push(at);
      if(at<16&&!damage.includes(into.id))damage.push(into.id);
    }
  }
  return {unmapped,damage};
}
function put64(buf,off,val){
  let n=BigInt(val);
  for(let i=0;i<8;i++)buf[off+i]=Number((n>>BigInt(8*i))&255n);
}
function freedList(heap,size){
  return heap.chunks.filter(c=>c.freed&&c.size===size).sort((a,b)=>(b.freeSeq||0)-(a.freeSeq||0));
}
function runEvents(events){const heap={chunks:[],pointers:{},next:0x55555000,issues:[],history:[],freeCounter:0},frames=[];let lastByVar={};
function frame(msg,kind='event'){frames.push({desc:msg,kind,heap:clone(heap)});}
frame('État initial : aucune allocation.','init');
function issue(i,type,message,details={}){heap.issues.push({i,type,message,...details});}
for(let i=0;i<events.length&&i<400;i++){const e=events[i],op=String(e.op),name=e.var,old=heap.pointers[name],valid=old!==undefined?heap.chunks.find(c=>c.id===old):null;let msg=e.raw||op;
if(op==='alias'){const source=heap.pointers[e.source];if(source!==undefined){heap.pointers[name]=source;msg=e.raw||`${name} ← ${e.source}`;}else issue(i,'alias',`Alias ${name} vers ${e.source} : allocation non suivie.`);}
else if(op==='null'){delete heap.pointers[name];msg=e.raw||`${name} = NULL`;}
else if(op==='read'){if(valid?.freed)issue(i,'use-after-free',`Lecture de ${name} après free.`);else if(valid&&valid.var!==name)issue(i,'stale-pointer',`Lecture via ${name} d’un chunk réattribué à ${valid.var}.`);else if(!valid)issue(i,'pointeur',`Lecture de ${name} : pointeur inconnu.`);}
else if(op==='store'){if(!valid){issue(i,'pointeur',`Écriture de champ via ${name} : pointeur inconnu.`);}else{let bytes=[],n=BigInt(Math.trunc(Number(e.value)||0));for(let k=0;k<Math.max(1,Math.min(8,Number(e.width)||4));k++)bytes.push(Number((n>>BigInt(k*8))&255n));if(valid.freed)issue(i,'use-after-free',`Écriture dans ${name} après free.`);if(valid.var!==name&&!valid.freed)issue(i,'stale-pointer',`Pointeur périmé ${name} : ce chunk appartient maintenant à ${valid.var}.`);if(Number(e.offset)+bytes.length>valid.requested)issue(i,'overflow',`Champ écrit hors objet ${name}.`);writeToHeap(heap,valid,bytes,Number(e.offset)||0);}}
else if(['malloc','calloc','realloc'].includes(op)){
let requested=op==='calloc'?Number(e.args?.[0])*Number(e.args?.[1]):Number(e.args?.[op==='realloc'?1:0]);if(op==='realloc'&&e.args?.length===1)requested=Number(e.args[0]);
if(!Number.isSafeInteger(requested)||requested<0||requested>65536){issue(i,'limite',`Taille ${op} inconnue ou hors plage (0–65536 octets).`);frame(msg);continue;}
let payload=[];
if(op==='realloc'&&valid){payload=valid.data.slice(16,16+Math.min(valid.requested,requested));valid.freed=true;}
const size=cap(requested);let c=heap.chunks.filter(c=>c.freed&&c.size===size).at(-1),reused=!!c;
if(c){c.freed=false;c.requested=requested;c.var=name;c.type=e.type||null;c.layout=e.layout||null;c.tcacheNext=null;c.freeSeq=null;/* Conserver les octets écrasés pour diagnostic. */}
else {let addr=heap.next;heap.next+=size;c={id:heap.chunks.length+1,start:addr,size,requested,var:name,freed:false,damaged:false,type:e.type||null,layout:e.layout||null,data:Array(size+8).fill(null),corruptedOffsets:[]};const sz=BigInt(size)|1n;for(let b=0;b<8;b++)c.data[8+b]=Number((sz>>BigInt(8*b))&255n);heap.chunks.push(c);}
heap.pointers[name]=c.id;lastByVar[name]=requested;
if(op==='calloc'){for(let k=16;k<c.size;k++)c.data[k]=0;}
if(payload.length)writeToHeap(heap,c,payload);
msg+=reused?' → réutilisation d’un chunk libéré':' → nouveau chunk';
} else if(op==='free'){
// Ne pas fabriquer une chaîne tcache après un en-tête invalidé :
// dans glibc réel l'opération est susceptible de s'arrêter avant l'insertion.
if(valid&&!valid.freed){
  let rawSize=0n,known=true;
  for(let k=0;k<8;k++){
    const b=valid.data[8+k];
    if(!Number.isInteger(b)){known=false;break;}
    rawSize|=BigInt(b)<<BigInt(8*k);
  }
  const expected=BigInt(valid.size)|1n;
  const flags=Number(rawSize&7n);
  if(!known||rawSize!==expected){
    issue(i,'invalid-free',`free(${name}) : champ size incohérent (${known?'0x'+rawSize.toString(16):'inconnu'}, attendu dans ce modèle : 0x${expected.toString(16)}). Arrêt simulé : impossible de reconstituer un état glibc fiable après cette corruption.`);
    msg+=' → ARRÊT (size incohérente)';
    frame(msg,'abort');break;
  }
}
if(!valid){issue(i,'pointeur',`free(${name}) : pointeur inconnu ou NULL dans cette simulation.`);}else if(valid.var!==name&&!valid.freed){issue(i,'stale-pointer',`free(${name}) : ancienne référence vers un chunk désormais associé à ${valid.var}.`);valid.freed=true;}else if(valid.freed){issue(i,'double-free',`Double-free potentiel sur ${name} (chunk #${valid.id}).`);}else {
  const existing=freedList(heap,valid.size);
  const previousHead=existing.length?existing[0]:null;
  valid.freed=true;valid.freeSeq=++heap.freeCounter;
  valid.tcacheNext=previousHead?previousHead.id:null;
  valid.tcacheModel=true;
  // Tcache pédagogique : l'entrée est le début de l'espace utilisateur.
  // PROTECT_PTR(&entry->next, ptr) = (adresse du champ >> 12) ^ ptr.
  // Pas de key réelle ni de vérification glibc complète.
  const nextPtr=previousHead?previousHead.start+16:0;
  const masked=BigInt(nextPtr)^BigInt(Math.floor((valid.start+16)/4096));
  put64(valid.data,16,masked);
  let globals=Object.entries(heap.pointers).filter(([alias,id])=>id===valid.id&&!alias.includes('@')&&!/^alloc#/.test(alias)).map(([alias])=>alias);if(globals.length)issue(i,'dangling-pointer',`Après free(${name}), pointeur(s) globaux non remis à NULL : ${globals.join(', ')}.`);}
} else if(['strcpy','strncpy','strcat','strncat','memcpy','write','fill'].includes(op)){
if(!valid){issue(i,'pointeur',`Écriture vers ${name} : pointeur introuvable.`);frame(msg);continue;}
let bytes=[],content=String(e.value??''),writeOffset=0;
if(op==='strcat'||op==='strncat'){
let found=false;for(let k=0;k<Math.min(valid.requested,valid.data.length-16);k++){if(valid.data[16+k]===0){writeOffset=k;found=true;break;}}
if(!found){issue(i,'non-termine',`Destination ${name} sans NUL identifié dans l’espace demandé : la position d’ajout est incertaine.`);writeOffset=valid.requested;}
}
if(op==='fill'){let count=Number(e.count),b=Number(e.byte);if(!Number.isInteger(count)||count<0||count>131072||!Number.isInteger(b)){issue(i,'limite','Paramètres de fill/memset invalides.');frame(msg);continue;}bytes=Array(Math.min(count,131072)).fill(b&255);}
else if(op==='strcpy'||op==='strcat'){bytes=[...textBytes(content),0];}
else if(op==='strncat'){let n=Number(e.limit);if(!Number.isInteger(n)||n<0||n>131072){issue(i,'limite','Longueur strncat inconnue.');frame(msg);continue;}bytes=[...textBytes(content).slice(0,n),0];}
else if(op==='strncpy'){let n=Number(e.limit);if(!Number.isInteger(n)||n<0||n>131072){issue(i,'limite','Longueur strncpy inconnue.');frame(msg);continue;}bytes=textBytes(content).slice(0,n);while(bytes.length<n)bytes.push(0);}
else if(op==='memcpy'){let n=Number(e.limit);if(!Number.isInteger(n)||n<0||n>131072){issue(i,'limite','Longueur memcpy inconnue.');frame(msg);continue;}bytes=textBytes(content).slice(0,n);while(bytes.length<n)bytes.push(null);}
else bytes=textBytes(content);
if(valid.freed)issue(i,'use-after-free',`Écriture dans ${name}, chunk #${valid.id} déjà libéré.`);
if(valid.var!==name&&!valid.freed)issue(i,'stale-pointer',`Écriture avec l’ancien pointeur ${name} sur un chunk réattribué à ${valid.var}.`);
let overflow=bytes.length+writeOffset>valid.requested;
if(overflow)issue(i,'overflow',`Écriture de ${bytes.length} octets depuis l’offset ${writeOffset} dans ${name} (${valid.requested} octets demandés) : débordement de ${bytes.length+writeOffset-valid.requested} octet(s).`,{var:name,written:bytes.length,requested:valid.requested,argvSource:e.argvSource});
const ret=writeToHeap(heap,valid,bytes,writeOffset);if(ret.damage.length)issue(i,'header',`Octets écrits dans un autre chunk : ${ret.damage.map(id=>'#'+id).join(', ')} (métadonnées potentiellement touchées).`);if(ret.unmapped)issue(i,'unmapped',`${ret.unmapped} octet(s) sortent du heap simulé (aucune adresse de destination modélisée).`);
msg+=` → ${bytes.length} octets écrits`;
}
else issue(i,'non-supporté',`Opération ${op} non prise en charge.`);
frame(msg);
}
return frames;}
function deriveHypotheses(events){let hints=[];for(let i=0;i<events.length;i++){let e=events[i];if(e.op!=='strcpy'||!e.argvSource)continue;let nearest=null;for(let j=i-1;j>=0;j--){let m=events[j];if(m.var!==e.var)continue;if(['malloc','calloc','realloc'].includes(m.op)){const n=m.op==='calloc'?Number(m.args?.[0])*Number(m.args?.[1]):Number(m.args?.[m.op==='realloc'?1:0]);if(Number.isSafeInteger(n)&&n>=0)nearest=n;break;}}
if(nearest!==null){let val='A'.repeat(Math.min(nearest,256));hints.push({text:`Un strcpy vers ${e.var} copie argv[${e.argvSource}] sans connaître sa longueur. Avec un tampon demandé de ${nearest} octets, ${nearest} caractères ASCII + l’octet NUL dépassent cette taille. Il faut confirmer sur le programme réel.`,payload:val,argv:e.argvSource,needed:nearest});}}
return hints;}
function load(events,warnings=[]){state.events=events;state.frames=runEvents(events);state.step=state.frames.length-1;state.hypotheses=deriveHypotheses(events);state.parserWarnings=warnings;render();}
function render(){let frames=state.frames,fr=frames[state.step];$('slider').max=Math.max(0,frames.length-1);$('slider').value=state.step;$('position').textContent=`${state.step} / ${Math.max(0,frames.length-1)}`;$('prev').disabled=state.step<=0;$('next').disabled=state.step>=frames.length-1;
if(!fr)return;
$('stepdesc').textContent=fr.desc;let heap=fr.heap,active=heap.chunks.filter(x=>!x.freed);$('nAllocated').textContent=active.length;$('nFreed').textContent=heap.chunks.length-active.length;$('nBytes').textContent=active.reduce((a,c)=>a+c.requested,0).toLocaleString('fr-FR')+' B';$('nAlerts').textContent=heap.issues.length;
$('chunks').innerHTML=heap.chunks.length?heap.chunks.map(c=>{let data=c.data.slice(16,16+Math.min(64,Math.max(c.requested,c.size-16)));let hex=data.slice(0,24).map(x=>x===null?'??':x.toString(16).padStart(2,'0')).join(' ');return `<article class="chunk ${c.damaged?'bad':c.freed?'freed':''}"><div class="top"><b>#${c.id} · ${esc(c.var)}</b><span class="tag">${c.damaged?'ALTÉRÉ':c.freed?'FREE':'ALLOC'}</span></div><div class="inner"><div class="mono mini">${fmt(c.start)} → ${fmt(c.start+c.size)}</div><div class="sizes">chunk <b>${fmt(c.size)}</b> · requête <b>${c.requested} B</b>${c.type?` · <b>${esc(c.type)}</b>`:''}</div>${c.layout?.fields?`<div class="mini mono">${c.layout.fields.map(f=>`${esc(f.name)} @+${f.offset} (${f.size}B)`).join(' · ')}</div>`:''}<div class="payload">${esc(bytesToString(data))}</div><div class="hex mono">${esc(hex)}</div><div class="foot">mchunk_size @ ${fmt(c.start+8)} · données @ ${fmt(c.start+16)}</div></div></article>`;}).join(''):`<div class="info">Aucun chunk à cette étape.</div>`;
if(typeof renderChunkInspector==='function')renderChunkInspector(heap);
$('diagnostics').innerHTML=(heap.issues.length?heap.issues.map(a=>`<div class="${['overflow','double-free','use-after-free','stale-pointer','dangling-pointer','header','invalid-free'].includes(a.type)?'warn':'info'}"><b>${esc(a.type.toUpperCase())}</b> · Étape ${a.i+1}<div>${esc(a.message)}</div></div>`).join(''):`<div class="ok">${state.mode==='reel'?'Trace native : allocations observées, mais aucune surveillance exhaustive des écritures. Une absence d’alerte ne prouve pas l’absence de corruption.':'Aucune anomalie détectée par le simulateur jusqu’à cette étape. Cela ne prouve pas l’absence de vulnérabilité.'}</div>`)+(state.parserWarnings?.length?`<p class="mini">${esc(state.parserWarnings.join(' · '))}</p>`:'');
$('events').innerHTML=state.frames.slice(1).map((f,i)=>`<div class="event ${state.step===i+1?'active':''}" role="button" tabindex="0" data-step="${i+1}"><span class="idx">${i+1}</span><span>${esc(f.desc)}</span></div>`).join('')||'<span class="help">Aucune opération.</span>';
document.querySelectorAll('.event').forEach(el=>{el.addEventListener('click',()=>{state.step=Number(el.dataset.step);render();});el.addEventListener('keydown',e=>{if(e.key==='Enter'){state.step=Number(el.dataset.step);render();}});});
let h=state.hypotheses;$('hypotheses').innerHTML=h.length?h.map((x,i)=>`<div class="hypo">${esc(x.text)}${x.payload?`<div class="mini" style="margin-top:8px">Hypothèse : argv[${x.argv}] = ${x.needed} × « A »</div><button class="copy" data-hint="${i}">Copier l’entrée de test</button><button class="copy" data-use="${i}">Tester avec argv[${x.argv}]</button>`:""}</div>`).join(''):'<span class="help">Aucune hypothèse automatique sur les arguments dans cette trace. Tu peux expérimenter librement dans l’onglet « Scénario ».</span>';
document.querySelectorAll('[data-hint]').forEach(el=>el.onclick=()=>{let t=h[Number(el.dataset.hint)].payload;navigator.clipboard?.writeText(t).then(()=>el.textContent='Copié').catch(()=>window.prompt('Copie cette valeur',t))??window.prompt('Copie cette valeur',t);});
document.querySelectorAll('[data-use]').forEach(el=>el.onclick=()=>{let x=h[Number(el.dataset.use)];if($('arg'+x.argv)){$('arg'+x.argv).value=x.payload;tabs[0].click();$('sourceRun').click();}});
}
for(let tab of tabs)tab.addEventListener('click',()=>{tabs.forEach(t=>t.classList.toggle('active',t===tab));document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===tab.dataset.tab));});
$('slider').oninput=e=>{state.step=Number(e.target.value);render();};$('prev').onclick=()=>{state.step=Math.max(0,state.step-1);render();};$('next').onclick=()=>{state.step=Math.min(state.frames.length-1,state.step+1);render();};
function parseWith(fn){try{let {events,ignored}=fn();if(!events.length)throw Error('Aucune opération reconnue. Vérifie la syntaxe et les expressions.');let warn=typeof ignored==='number'?(ignored?[`${ignored} appel(s) non interprétés.`]:[]):ignored.length?[`Lignes ignorées : ${ignored.join(', ')}`]:[];load(events,warn);}catch(e){alert(e.message);}}
$('sourceRun').onclick=()=>parseWith(()=>parseSource($('sourcecode').value));$('scriptRun').onclick=()=>parseWith(()=>parseScript($('scenario').value));$('traceRun').onclick=()=>{try{load(fromTrace($('tracecode').value));}catch(e){alert(e.message);}};
$('exportBtn').onclick=()=>{let b=new Blob([JSON.stringify(state.events,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='heaplab-trace.json';a.click();URL.revokeObjectURL(a.href);};
$('demoBtn').onclick=()=>{$('arg1').value='A'.repeat(24);$('sourceRun').click();};$('resetScript').onclick=()=>{$('scenario').value='A = malloc(24)\nB = malloc(32)\nfree(A)\nC = malloc(16)\nfill(C, 0x41, 40)';$('scriptRun').click();};
$('sourceRun').click();
