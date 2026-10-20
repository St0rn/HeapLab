/* HeapLab - structures glibc x86-64 (modèle pédagogique) */
'use strict';
let inspectedChunkId=null;
function u64(data,start){
  if(!data||data.length<start+8||data.slice(start,start+8).some(x=>!Number.isInteger(x)))return null;
  let n=0n;for(let i=0;i<8;i++)n|=BigInt(data[start+i])<<BigInt(8*i);return n;
}
function hex64(n){return n===null?'inconnu / non capturé':'0x'+n.toString(16).padStart(16,'0');}
function formatBytes(bytes,offset,c){
  const bad=new Set(c.corruptedOffsets||[]);
  return bytes.map((v,i)=>{let val=v===null?'??':v.toString(16).padStart(2,'0');return bad.has(offset+i)?'<mark title="Octet modifié par un débordement">'+val+'</mark>':val;}).join(' ');
}
function renderChunkInspector(heap){
  let view=document.getElementById('chunkStructure');if(!view)return;
  const native=state.mode==='reel';
  document.getElementById('inspectorMode').textContent=native?'Trace native (snapshot partiel)':'Modèle pédagogique';
  const chunks=heap.chunks||[];
  if(!chunks.length){view.innerHTML='<div class="info">Aucune allocation.</div>';document.getElementById('chunkDetail').innerHTML='';document.getElementById('tcacheBins').innerHTML='';return;}
  if(!chunks.some(c=>c.id===inspectedChunkId))inspectedChunkId=chunks[0].id;
  view.innerHTML=chunks.map(c=>{
    const sz=u64(c.data,8);const damaged=(c.corruptedOffsets||[]).some(o=>o>=8&&o<16);
    const hdr=damaged?'EN-TÊTE ALTÉRÉ':(c.freed?'LIBÉRÉ':'ALLOUÉ');
    return `<button type="button" class="structtile ${c.id===inspectedChunkId?'active':''}" data-inspect="${c.id}" aria-pressed="${c.id===inspectedChunkId}">
    <strong>#${c.id} · ${esc(c.var)}</strong><small>${fmt(c.start)} → ${fmt(c.start+c.size)}</small><small>${hdr} · size ${sz===null?'?':hex64(sz)}</small>
    <div class="cells"><span class="c-prev"></span><span class="${(c.corruptedOffsets||[]).some(i=>i>=8&&i<16)?'c-damaged':'c-size'}"></span><span class="${c.freed?'c-free':'c-data'}"></span><span class="${c.freed?'c-free':'c-data'}"></span></div>
    <small>prev_size | size | data (${c.requested} B)</small></button>`;
  }).join('');
  view.querySelectorAll('[data-inspect]').forEach(el=>el.onclick=()=>{inspectedChunkId=Number(el.dataset.inspect);renderChunkInspector(heap);});
  const c=chunks.find(x=>x.id===inspectedChunkId);
  const prev=u64(c.data,0),size=u64(c.data,8);
  const flags=size===null?null:Number(size&7n);
  const pureSize=size===null?null:(size&~7n);
  const bad=new Set(c.corruptedOffsets||[]);
  const badPrev=[...bad].some(x=>x<8),badSize=[...bad].some(x=>x>=8&&x<16);
  const flagText=flags===null?'Non disponible':`P=${flags&1?1:0} · M=${flags&2?1:0} · A=${flags&4?1:0}`;
  const suspicious=(pureSize!==null&&(pureSize<32n||(pureSize%16n)!==0n||pureSize>BigInt(65536)))||((flags||0)&2&& !native);
  let fd=u64(c.data,16);
  const headLabel=c.tcacheModel?'Tcache simulée (LIFO, Safe-Linking illustratif)':'Octets utilisateur ou données libérées';
  let out=`<div class="structstep"><b>Chunk #${c.id}</b> · adresse de base <b>${fmt(c.start)}</b> · pointeur utilisateur <b>${fmt(c.start+16)}</b> · taille demandée <b>${c.requested} octets</b>. Les champs sont lus en little-endian.</div>
  <div class="structdetails"><div class="${badPrev?'structcorrupt':''}"><strong>+0x00 → prev_size · 8 octets</strong><code>${hex64(prev)}</code><small>À interpréter seulement si le bit P du chunk courant est à 0. Sinon, valeur souvent non pertinente.</small></div>
  <div class="${badSize?'structcorrupt':''}"><strong>+0x08 → size | flags · 8 octets</strong><code>${hex64(size)}</code><small>Taille masquée : ${hex64(pureSize)} · ${flagText}</small></div>
  <div><strong>+0x10 → données / next (si tcache)</strong><code>${hex64(fd)}</code><small>${esc(headLabel)}${c.tcacheModel?' · next logique : '+(c.tcacheNext===null?'NULL':'chunk #'+c.tcacheNext):''}</small></div>
  <div><strong>+0x18 → données / key (si tcache)</strong><code>${hex64(u64(c.data,24))}</code><small>${c.tcacheModel?'key réelle volontairement non simulée.':'Interprétation en tant que key impossible hors trace tcache fiable.'}</small></div></div>
  <p class="help" style="margin-top:12px">P = PREV_INUSE (chunk précédent), M = IS_MMAPPED, A = NON_MAIN_ARENA. Un bit P=1 ne signifie pas que le chunk courant est alloué. Le champ size n'est pas modifié par le fait qu'un chunk entre dans la tcache.</p>
  <div class="structhex"><b>En-tête brut [base +0x00 ... +0x0f]</b>\n${formatBytes(c.data.slice(0,16),0,c)}\n\n<b>Données [+0x10 ...]</b>\n${formatBytes(c.data.slice(16,Math.min(c.data.length,80)),16,c)}</div>`;
  if(badSize)out+='<div class="warn"><b>Corruption de size</b> : les octets en rouge ne correspondent plus au champ d’origine. Un free/malloc réel peut refuser ce chunk et arrêter le programme.</div>';
  if(suspicious)out+='<div class="warn">Valeur size suspecte ou flags incompatibles avec le modèle de chunks contigus. La simulation ne prétend pas poursuivre fidèlement glibc après corruption.</div>';
  if(native)out+='<div class="info">Trace native : capture partielle avant/après certains appels ; ne pas attribuer avec certitude un fd/key de tcache aux octets capturés.</div>';
  document.getElementById('chunkDetail').innerHTML=out;
  const bins=document.getElementById('tcacheBins');
  if(native){bins.innerHTML='<div class="mini">Tcache non reconstituée en mode natif : snapshots insuffisants.</div>';return;}
  const bySize=new Map();for(const c of chunks.filter(c=>c.freed)){
    if(!bySize.has(c.size))bySize.set(c.size,[]);bySize.get(c.size).push(c);
  }
  bins.innerHTML='<h3>Chaînes tcache modélisées</h3>'+(bySize.size?[...bySize.entries()].sort((a,b)=>a[0]-b[0]).map(([size,entry])=>`<div class="binrow">size ${fmt(size)} · ${entry.slice().sort((a,b)=>(b.freeSeq||0)-(a.freeSeq||0)).map(c=>'#'+c.id).join(' → ')} → NULL</div>`).join(''):'<div class="info">Aucune entrée libérée, tcache vide dans le modèle.</div>')+'<p class="mini">Tcache ici : une liste LIFO simplifiée, sans limite par bin, validation de pointeurs, consolidation, arènes ni politique de glibc complète.</p>';
}
