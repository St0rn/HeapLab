/* HeapLab: UI hook for bounded C/C++ simulation. Native tracing remains a separate, opt-in path. */
'use strict';
(function(){
 const sourceArea=$('sourcecode');
 const run=$('sourceRun');
 const info=document.createElement('div');
 info.id='sourceCoverage';info.className='panel';info.style.marginTop='18px';
 info.innerHTML='<h3>Couverture du simulateur C / C++</h3><div id="sourceCoverageBody" class="help">Simule le code pour voir les chemins parcourus et les hypothèses.</div>';
 $('hypotheses').parentNode.after(info);
 function offline(){
   try{
     const result=SourceSim.simulate(sourceArea.value,{
       args:[$('arg1').value,$('arg2').value],
       stdin:$('sourceStdin').value,
       unknownBranch:$('unknownBranch').value
     });
     const coverage=result.coverage.length?result.coverage.join(' → '):'(aucune fonction)';
     const structures=Object.entries(result.types).filter(([,v])=>v&&Number.isFinite(v.size))
       .map(([k,v])=>`${k}: ${v.size} octets (${v.fields.map(x=>x.name+' +'+x.offset).join(', ')})`);
     $('sourceCoverageBody').innerHTML=`<p><b>Mode :</b> hypothèses hors ligne · <b>Chemin :</b> ${esc(coverage)}</p>`+
       `<p><b>Opérations heap :</b> ${result.events.length} · <b>Branches indécidables :</b> ${result.unknowns.length} · <b>Avertissements :</b> ${result.warnings.length}</p>`+
       (structures.length?`<div class="lines">Structures (ABI x86-64 simplifiée) :\n${esc(structures.join('\n'))}</div>`:'')+
       (result.warnings.length?`<details open style="margin-top:9px"><summary>Limites et avertissements</summary><div class="lines">${esc(result.warnings.slice(0,30).map(x=>'• '+x).join('\n'))}</div></details>`:
       '<div class="ok">Aucun chemin indécidable signalé par l’interpréteur borné. Cela ne constitue pas une preuve de correction.</div>');
     if(result.events.length){
       load(result.events,result.warnings.slice(0,10));
       state.sourceSummary=result;
     }else{
       load([],result.warnings.slice(0,10));
       $('diagnostics').innerHTML='<div class="info">Aucun appel d’allocation identifié sur le chemin simulé. Vérifie les options, l’entrée standard ou la couverture du parseur.</div>';
     }
     $('modeLabel').textContent='SIMULATION SYMBOLIQUE BORNÉE · C/C++ (non exécuté)';
   }catch(e){$('sourceCoverageBody').textContent='Analyse interrompue : '+e.message;alert('Le simulateur n’a pas pu interpréter le code : '+e.message);}
 }
 run.onclick=offline;
 $('demoBtn').onclick=()=>{$('arg1').value='A'.repeat(24);offline();};
 $('sourceFile').onchange=async e=>{
   const f=e.target.files?.[0];if(!f)return;if(f.size>150000){alert('Fichier source limité à 150 Ko.');return;}
   sourceArea.value=await f.text();if(/\.(cpp|cc|cxx|hpp)$/i.test(f.name))$('sourceLang').value='cpp';
   else if(/\.c$/i.test(f.name))$('sourceLang').value='c';
   offline();
 };
 offline();
})();
