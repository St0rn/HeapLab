const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const base=path.join(__dirname,'..');const ctx={TextEncoder,console};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(base,'source_sim.js'),'utf8')+'\nthis.SourceSim=SourceSim;',ctx);
const check=(label,fn)=>{try{fn();console.log('OK ',label);}catch(e){console.error('FAIL',label,e);process.exitCode=1;}};
check('appel dans main + argv + allocation/free',()=>{
 const src='int main(int argc,char **argv){ char *a=malloc(24); strcpy(a,argv[1]); free(a); return 0; }';
 let s=ctx.SourceSim.simulate(src,{args:['A'.repeat(24)]});assert.equal(s.events.filter(x=>x.op==='malloc').length,1);assert.equal(s.events.filter(x=>x.op==='strcpy').length,1);assert.equal(s.events.find(x=>x.op==='strcpy').value.length,24);assert.equal(s.events.filter(x=>x.op==='free').length,1);
});
check('if élimine une branche non prise',()=>{
 let s=ctx.SourceSim.simulate('int main(){int x=0; if(x) malloc(17); else malloc(40);}',{});
 assert.equal(s.events.filter(x=>x.op==='malloc')[0].args[0],40);assert.equal(s.events.filter(x=>x.op==='malloc').length,1);
});
check('zombie menu: human puis suicide puis zombie',()=>{
 const source=fs.readFileSync(path.join(base,'examples/zombie_lab.c'),'utf8');
 const s=ctx.SourceSim.simulate(source,{stdin:'1\n3\n5\n1\n0\n'});
 console.log('Zombie debug:',JSON.stringify({mallocs:s.events.filter(x=>x.op==='malloc').map(x=>[x.type,x.args]),frees:s.events.filter(x=>x.op==='free'),warnings:s.warnings.slice(0,10), coverage:s.coverage},null,2));
 assert.equal(s.types.Zombie.size,40);assert.equal(s.types.Human.size,40);
 assert.equal(s.events.filter(x=>x.op==='malloc').length,2);assert.equal(s.events.filter(x=>x.op==='free').length,1);
});
check('C++ new/delete détectés',()=>{
 const src=fs.readFileSync(path.join(base,'examples/cpp_lab.cpp'),'utf8');let s=ctx.SourceSim.simulate(src,{args:['A'.repeat(24)]});
 console.log('Cpp debug:',JSON.stringify({events:s.events.map(x=>[x.op,x.var,x.args]),warnings:s.warnings},null,2));
 assert.equal(s.events.filter(x=>x.op==='malloc').length,3);assert.equal(s.events.filter(x=>x.op==='free').length,3);
});
check('boucle for avec allocation',()=>{
 let s=ctx.SourceSim.simulate('int main(){ for(int i=0;i<3;i++){ char *p = malloc(16); free(p); }}');assert.equal(s.events.filter(x=>x.op==='malloc').length,3);
});
