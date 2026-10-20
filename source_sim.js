/* HeapLab C/C++ bounded source interpreter — offline, no eval(), no arbitrary code execution.
   The model is intentionally partial; undecidable or unsupported constructs are surfaced. */
'use strict';
const SourceSim = (() => {
  const UNKNOWN = Object.freeze({unknown:true});
  const isUnknown=x=>x===UNKNOWN || !!(x&&x.unknown);
  const isPtr=x=>x&&typeof x==='object'&&typeof x.heapRef==='string';
  const val=x=>x&&x.value!==undefined&&x.ref?x.value:x;
  const utf8=x=>Array.from(new TextEncoder().encode(String(x))).length;
  function lex(src){
    let out=[],i=0,line=1;
    const put=(v,k='sym')=>out.push({v,k,line});
    while(i<src.length){let c=src[i];
      if(/\s/.test(c)){if(c==='\n')line++;i++;continue;}
      if(c==='/'&&src[i+1]==='/'){while(i<src.length&&src[i]!=='\n')i++;continue;}
      if(c==='/'&&src[i+1]==='*'){i+=2;while(i<src.length-1&&src.slice(i,i+2)!=='*/'){if(src[i]==='\n')line++;i++;}i+=2;continue;}
      if(c==='"'||c==="'"){const start=i++,q=c;while(i<src.length){if(src[i]==='\\'){i+=2;continue;}if(src[i++]===q)break;}
        put(src.slice(start,i),q==='"'?'string':'char');continue;}
      let m=/^(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?)(?:[uUlL]*)/.exec(src.slice(i));if(m){put(m[0],'num');i+=m[0].length;continue;}
      m=/^[\p{L}_][\p{L}\p{N}_]*/u.exec(src.slice(i));if(m){put(m[0],'id');i+=m[0].length;continue;}
      const op=['<<=','>>=','...','->*','::','->','++','--','<=','>=','==','!=','&&','||','+=','-=','*=','/=','%=','<<','>>','&=','|=','^=','.*'].find(x=>src.startsWith(x,i));
      put(op||c);i+=(op||c).length;
    }
    return out;
  }
  function str(t){return t.map(x=>x.v).join(' ');}
  function splitTokens(ts,delim){let out=[],last=0,depth=0;for(let i=0;i<ts.length;i++){
    if(['(','[','{'].includes(ts[i].v))depth++;
    if([')',']','}'].includes(ts[i].v))depth--;
    if(ts[i].v===delim&&depth===0){out.push(ts.slice(last,i));last=i+1;}
  }out.push(ts.slice(last));return out;}
  function matchClose(ts,start,open='(',close=')'){
    let d=0;for(let i=start;i<ts.length;i++){if(ts[i].v===open)d++;if(ts[i].v===close&&!--d)return i;}return -1;
  }
  function stripPreprocessor(source,macros,warnings){
    return source.replace(/^\s*#\s*(define|include|if|ifdef|ifndef|else|endif|pragma).*$/gm,(line,kind)=>{
      if(kind==='define'){const m=/^\s*#\s*define\s+(\w+)\s+(.+)$/.exec(line);if(m&&!m[1].includes('(')&&!m[2].includes('##'))macros.set(m[1],m[2].trim());}
      if(['if','ifdef','ifndef','else','endif'].includes(kind))warnings.add('Préprocesseur conditionnel non évalué : préciser la configuration / utiliser le mode natif.');
      return '\n';
    });
  }
  class Parser {
    constructor(ts){this.ts=ts;this.i=0;}
    peek(n=0){return this.ts[this.i+n]?.v;}
    take(){return this.ts[this.i++];}
    balanced(open='(',close=')'){
      if(this.peek()!==open)return [];
      const st=this.i,end=matchClose(this.ts,st,open,close);
      if(end<0){this.i=this.ts.length;return [];}
      this.i=end+1;return this.ts.slice(st+1,end);
    }
    untilSemicolon(){let st=this.i,d=0;while(this.i<this.ts.length){let c=this.peek();if(c===';'&&d===0)break;if(['(','[','{'].includes(c))d++;if([')',']','}'].includes(c))d--;this.i++;}const tokens=this.ts.slice(st,this.i);if(this.peek()===';')this.i++;return tokens;}
    one(){let c=this.peek();if(c===undefined)return null;
      if(c===';'){this.i++;return {kind:'empty'};}
      if(c==='{'){const inner=this.balanced('{','}');return {kind:'block',body:new Parser(inner).all()};}
      if(c==='if'){this.i++;let cond=this.balanced(),yes=this.one(),no=null;
        if(this.peek()==='else'){this.i++;no=this.one();}return {kind:'if',cond,yes,no};}
      if(c==='while'||c==='switch'){this.i++;const cond=this.balanced();if(c==='switch'){
        let body=this.peek()==='{'?this.balanced('{','}'):[];
        const segments=[];let cases=[],current=null,depth=0;
        for(let j=0;j<body.length;j++){
          let v=body[j].v;if(['(','[','{'].includes(v))depth++;if([')',']','}'].includes(v))depth--;
          if(depth===0&&(v==='case'||v==='default')){
            if(current)segments.push({...current,body:new Parser(cases).all()});
            let k=j+1;while(k<body.length&&body[k].v!==':')k++;
            current={label:v==='default'?null:body.slice(j+1,k)};cases=[];j=k;
          }else cases.push(body[j]);
        }
        if(current)segments.push({...current,body:new Parser(cases).all()});
        return {kind:'switch',cond,cases:segments};
      }return {kind:'while',cond,body:this.one()};}
      if(c==='for'){this.i++;const parts=splitTokens(this.balanced(),';');return {kind:'for',init:parts[0]||[],cond:parts[1]||[],inc:parts[2]||[],body:this.one()};}
      if(c==='do'){this.i++;const body=this.one();if(this.peek()==='while'){this.i++;const cond=this.balanced();if(this.peek()===';')this.i++;return {kind:'do',cond,body};}return {kind:'block',body:[body]};}
      if(['return','break','continue','throw'].includes(c)){this.i++;const expr=this.untilSemicolon();return {kind:c,expr};}
      return {kind:'expr',tokens:this.untilSemicolon()};
    }
    all(){let out=[];while(this.i<this.ts.length){let prev=this.i,stmt=this.one();if(stmt)out.push(stmt);if(this.i===prev)this.i++;}return out;}
  }
  const aligned=(n,a)=>Math.ceil(n/a)*a;
  function structLayout(ts,known,warnings){
    const fields=[];let offset=0,maxAlign=1;
    for(const entry of splitTokens(ts,';')){
      if(!entry.length)continue;let s=str(entry),name,size=0,align=1,func=/\(\s*\*\s*(\w+)\s*\)/.exec(s);
      if(func){name=func[1];size=8;align=8;}
      else {name=entry.filter(t=>t.k==='id').at(-1)?.v;
        let ptr=entry.some(t=>t.v==='*'||t.v==='&');
        if(ptr){size=8;align=8;}
        else {let ty=entry[0]?.v,ty2=entry[1]?.v;
          if(ty==='unsigned'||ty==='signed')ty=ty2||'int';
          const scalar={char:1,bool:1,short:2,int:4,float:4,long:8,double:8,size_t:8,uint8_t:1,uint16_t:2,uint32_t:4,uint64_t:8,int64_t:8,int32_t:4};
          size=scalar[ty]||known[ty]?.size||0;align=Math.min(size,8);
          if(!size){warnings.add('Champ de structure inconnu : '+s+' (layout non fiable)');return null;}
        }
        const arr=/\[\s*(\d+)\s*\]/.exec(s);if(arr)size*=Number(arr[1]);
      }
      if(!name)return null;
      offset=aligned(offset,align);fields.push({name,offset,size,func:!!func});offset+=size;maxAlign=Math.max(maxAlign,align);
    }
    return {size:aligned(offset,maxAlign),fields};
  }
  function parseProgram(source,warnings){
    const macros=new Map(),clean=stripPreprocessor(source,macros,warnings),ts=lex(clean),funcs=new Map(),types={},globals=[];
    let i=0;
    while(i<ts.length){
      let start=i,d=0,found=-1,semi=-1;
      for(let j=i;j<ts.length;j++){
        let v=ts[j].v;if(v==='('||v==='[')d++;if(v===')'||v===']')d--;
        if(d===0&&v==='{'){found=j;break;}if(d===0&&v===';'){semi=j;break;}
      }
      if(found>=0&&(semi<0||found<semi)){
        const head=ts.slice(start,found),close=matchClose(ts,found,'{','}');if(close<0){warnings.add('Bloc non fermé, analyse interrompue.');break;}
        const body=ts.slice(found+1,close),header=str(head),structName=/\b(?:struct|class|union)\s+(\w+)/.exec(header);
        const par=head.findIndex(t=>t.v==='('),fn=par>0?head[par-1]?.v:null;
        if(structName&&par<0){if(header.includes('union'))warnings.add('union modélisée approximativement.');types[structName[1]]=structLayout(body,types,warnings)||null;}
        else if(fn&&/^[\w~]+$/.test(fn)&&!['if','while','switch','for'].includes(fn)){
          let end=matchClose(head,par),args=splitTokens(head.slice(par+1,end),' , ');
          args=splitTokens(head.slice(par+1,end),',').map(x=>{
            let names=x.filter(t=>t.k==='id');return names.at(-1)?.v;}).filter(x=>x&&x!=='void');
          funcs.set(fn,{name:fn,params:args,body:new Parser(body).all()});
        } else warnings.add('Bloc / déclaration non reconnu : '+header.slice(0,65));
        i=close+1;if(ts[i]?.v===';')i++;
      }else if(semi>=0){globals.push(ts.slice(start,semi));i=semi+1;}
      else break;
    }
    return {funcs,types,globals,macros};
  }
  function simulate(source,{args=[],stdin='',unknownBranch='skip',maxOperations=350,maxSteps=2400}={}){
    const warnings=new Set();
    if(/\b(?:std\s*::\s*(?:vector|string|map|unique_ptr|shared_ptr|thread)|template\s*<|virtual\s+|reinterpret_cast|dynamic_cast|goto\s+|asm\s*\()/m.test(source))
      warnings.add('C++/C avancé, STL, casts ou contrôle non local : les effets indirects sur le heap ne peuvent pas être reconstruits fidèlement hors ligne ; préférer le traceur natif.');
    const pg=parseProgram(source,warnings);const events=[],coverage=[],unknowns=[];
    const initialArgs=['program',...args];const input=String(stdin);let inputPos=0,steps=0,callNum=0,randSeed=0x42fe,counter=0,stopped=false;
    let frames=[],scope={vars:new Map(),name:'global'},current=scope,activeLine=0;
    function warn(x){warnings.add(x);}
    function scopeLookup(name){let s=current;while(s){if(s.vars.has(name))return s.vars.get(name);s=s.parent;}return null;}
    function local(name,initial=0,type=null){let v={value:initial,key:current===scope?name:`${name}@${current.name}`,type};current.vars.set(name,v);return v;}
    function getVar(name){const m=scopeLookup(name);if(m)return m;
      if(name==='NULL'||name==='nullptr')return {value:0};
      if(name==='stdin'||name==='stdout'||name==='stderr')return {value:name};
      if(name==='argc')return {value:initialArgs.length};
      if(name==='argv')return {value:initialArgs};
      if(pg.macros.has(name)){const raw=pg.macros.get(name);return {value:/^\d+$/.test(raw)?+raw:raw};}
      if(pg.funcs.has(name)||['malloc','calloc','realloc','free','delete','delete[]','memset','fill','strcpy','strcat','strncpy','strncat','memcpy','strlen','atoi','atol','strtol','strtoul','rand','srand','getc','getchar','puts','printf','fprintf','sleep','usleep','fflush','exit','getline'].includes(name))return {value:{function:name}};
      return local(name,0);
    }
    function emit(e){if(events.length>=maxOperations){warn('Limite d’opérations atteinte ; trace partielle.');stopped=true;return;}
      const ln=e.sourceLine??activeLine;events.push({ ...e,raw:ln?`L${ln} · ${e.raw||e.op}`:(e.raw||e.op),sourceLine:ln});}
    function typeSize(type){if(!type)return NaN;let t=String(type).replace(/\b(?:const|volatile|struct|class|signed|unsigned)\b/g,'').trim();
      if(/\*$|&$/.test(t))return 8;
      const primitives={char:1,bool:1,short:2,int:4,long:8,'long long':8,float:4,double:8,size_t:8,void:1,uint8_t:1,uint16_t:2,uint32_t:4,uint64_t:8,int32_t:4,int64_t:8};
      return primitives[t]||pg.types[t]?.size||NaN;
    }
    function readTokens(inputTokens){return Array.isArray(inputTokens)?inputTokens:lex(String(inputTokens));}
    function parseExpr(inputTokens){
      const ts=readTokens(inputTokens);let i=0;
      const peek=()=>ts[i]?.v;const take=()=>ts[i++];
      const deref=o=>o&&typeof o==='object'&&Object.prototype.hasOwnProperty.call(o,'value')?o.value:o;
      const scalar=x=>isUnknown(x)?NaN:isPtr(x)?1:typeof x==='number'?x:typeof x==='boolean'?+x:typeof x==='string'&&x.trim()!==''&&Number.isFinite(Number(x))?Number(x):NaN;
      function refVar(name){let r=getVar(name);return {value:r.value,ref:{get:()=>r.value,set:x=>assign(r,x)},type:r.type,key:r.key};}
      function setMaybe(target,x){if(target?.ref)target.ref.set(x);else warn('Affectation non modélisée à '+str(ts));return x;}
      function assign(r,x){const old=r.value;r.value=x;
        if(isPtr(x)){r.type=r.type||x.type;let src=x.heapRef;
          if(src!==r.key)emit({op:'alias',var:r.key,source:src,raw:`${r.key} ← alias ${src}`});}
        else if(isPtr(old)&&(x===0||x===null))emit({op:'null',var:r.key,raw:`${r.key} = NULL`});
      }
      function idxRef(base,index){const b=deref(base),j=scalar(deref(index));
        if(!Number.isInteger(j)||j<0||j>100000){warn('Index de tableau inconnu ou hors limite : '+str(ts));return {value:UNKNOWN};}
        if(Array.isArray(b)){return {value:b[j]===undefined?0:b[j],ref:{get:()=>b[j]??0,set:x=>{b[j]=x;if(isPtr(x))emit({op:'alias',var:`${base.key||'array'}[${j}]`,source:x.heapRef,raw:`${base.key||'array'}[${j}] ← ${x.heapRef}`});else if(x===0)emit({op:'null',var:`${base.key||'array'}[${j}]`,raw:`${base.key||'array'}[${j}] = NULL`});}}};}
        if(typeof b==='string')return {value:b.charCodeAt(j)||0};
        warn('Indexation de mémoire brute non simulée : '+str(ts));return {value:UNKNOWN};
      }
      function fieldRef(base,field){const p=deref(base);
        if(!isPtr(p)){warn('Champ '+field+' sur objet non modélisé.');return {value:UNKNOWN};}
        const block=allocState.get(p.heapRef);if(!block){emit({op:'read',var:p.heapRef,raw:`lecture ${p.heapRef}->${field}`});return {value:UNKNOWN};}
        let actual=block,layout=pg.types[p.type]||pg.types[block.type]||null;
        let accessName=field;
        if(block.freed){
          emit({op:'read',var:p.heapRef,raw:`lecture ${p.heapRef}->${field} après free`});
          const owner=[...allocState.values()].find(b=>!b.freed&&b.address===block.address&&b.key!==block.key);
          if(!owner){warn(`Use-after-free : lecture de ${p.heapRef}->${field} sans réallocation connue.`);return {value:UNKNOWN};}
          actual=owner;
          const expected=layout?.fields.find(f=>f.name===field),real=pg.types[owner.type]?.fields.find(f=>f.offset===expected?.offset&&f.size===expected?.size);
          if(!real){warn(`Pointeur périmé ${p.heapRef} : le champ ${field} ne correspond pas au nouveau type ${owner.type||'inconnu'}.`);return {value:UNKNOWN};}
          accessName=real.name;
          warn(`Hypothèse de type confusion : ${p.type}->${field} @+${expected.offset} recouvre ${owner.type}->${real.name} (chunk réutilisé).`);
        }
        let item=actual.fields[accessName]??0;
        return {value:item,key:p.heapRef+'.'+field,ref:{get:()=>actual.fields[accessName]??0,set:x=>{
          actual.fields[accessName]=x;
          let def=layout?.fields.find(f=>f.name===field);
          if(def){let n=typeof x==='number'?x:typeof x==='object'&&x?.function?0x401000+((String(x.function).length*97)%0x200):isPtr(x)?0x55555010:0;
            emit({op:'store',var:p.heapRef,offset:def.offset,width:Math.min(def.size,8),value:n,raw:`${p.heapRef}->${field} = ${typeof x==='object'&&x?.function?'&'+x.function:String(n)} (modèle)`});}
        }}};
      }
      function primitive(){let tok=take();if(!tok)return {value:UNKNOWN};
        let w=tok.v;
        if(w==='('){let save=i;
          let end=matchClose(ts,i-1);let cast=ts.slice(i,end);
          if(end>=0&&cast.length<=6&&cast.length>0&&cast.every(t=>t.k==='id'||['*','&','::'].includes(t.v)) && (cast.some(t=>['char','int','long','void','size_t','const','unsigned','struct'].includes(t.v))|| pg.types[cast[0]?.v] || cast.some(t=>t.v==='*'))){i=end+1;return primitive();}
          let e=expression(0);if(peek()===')')take();else warn('Parenthèse non fermée dans '+str(ts));return e;
        }
        if(['+','-','!','~','*','&','++','--'].includes(w)){
          let a=postfix(),v=deref(a);if(w==='*')return a;if(w==='&')return {value:v};
          if(w==='++'||w==='--'){let n=scalar(v)+(w==='++'?1:-1);setMaybe(a,n);return {value:n};}
          if(w==='!')return {value:!v?1:0};if(w==='~')return {value:~scalar(v)};
          return {value:w==='-'?-scalar(v):scalar(v)};
        }
        if(w==='sizeof'){
          let items=peek()==='('? (()=>{take();let first=i,close=matchClose(ts,i-1);i=close+1;return ts.slice(first,close);})():[take()];
          let s=str(items).replace(/\s+/g,' ').trim();const rr=/^(?:struct |class )?(\w+)$/.exec(s);
          if(rr&&pg.types[rr[1]])return {value:pg.types[rr[1]].size};
          if(/^\*\s*\w+$/.test(s)){let v=getVar(s.replace(/^\*\s*/,''));return {value:typeSize(v.type)};}
          if(/\[/.test(s)){const x=parseExpr(items);return {value:typeof x==='string'?utf8(x)+1:NaN};}
          let p=typeSize(s);if(Number.isFinite(p))return {value:p};
          let v=scopeLookup(s);if(v)return {value:isPtr(v.value)?8:typeSize(v.type)||NaN};
          warn('sizeof non résolu : '+s);return {value:UNKNOWN};
        }
        if(w==='new'){
          if(peek()==='('){const end=matchClose(ts,i);i=end+1;warn('Placement / nothrow new simplifié.');}
          let ty=take()?.v||'unknown';if(ty==='struct'||ty==='class')ty=take()?.v;
          let count=1;if(peek()==='['){take();const n=expression(0);count=scalar(deref(n));if(peek()===']')take();}
          let sz=typeSize(ty);if(!Number.isFinite(sz)||!Number.isSafeInteger(count)){warn('new : taille inconnue pour '+ty);return {value:UNKNOWN};}
          const p=allocate(sz*count,'new',ty);if(peek()==='('){let end=matchClose(ts,i);i=end+1;}return {value:p};
        }
        if(tok.k==='string'){let value=w.slice(1,-1);try{value=JSON.parse(w);}catch{value=value.replace(/\\n/g,'\n');}return {value};}
        if(tok.k==='char'){let s=w.slice(1,-1);if(s.startsWith('\\')){try{s=JSON.parse('"'+s+'"');}catch{s='\n';}}return {value:s.charCodeAt(0)||0};}
        if(tok.k==='num')return {value:Number(w.replace(/[uUlL]+$/,''))};
        if(w==='true')return {value:1};if(w==='false'||w==='nullptr'||w==='NULL')return {value:0};
        if(tok.k==='id'){let full=w;
          while(peek()==='::'){take();full+='::'+(take()?.v||'');}
          return refVar(full);
        }
        return {value:UNKNOWN};
      }
      function postfix(){let left=primitive();
        while(i<ts.length){let w=peek();
          if(w==='['){take();const index=expression(0);if(peek()===']')take();left=idxRef(left,index);continue;}
          if(w==='.'||w==='->'){take();const f=take()?.v||'';left=fieldRef(left,f);continue;}
          if(w==='('){take();let values=[],rawArgs=[];if(peek()!==')'){while(i<ts.length){let first=i;values.push(deref(expression(1)));rawArgs.push(str(ts.slice(first,i)));if(peek()!==',')break;take();}}
            if(peek()===')')take();
            let named=deref(left),name=left.key||null;
            if(typeof named==='object'&&named?.function)name=named.function;
            let v=call(name,values,{rawArgs});left={value:v};continue;
          }
          if(w==='++'||w==='--'){take();const old=scalar(deref(left));setMaybe(left,old+(w==='++'?1:-1));left={value:old};continue;}
          break;
        }
        return left;
      }
      const precedence={'=':1,'+=':1,'-=':1,'*=':1,'/=':1,'||':2,'&&':3,'|':4,'^':5,'&':6,'==':7,'!=':7,'<':8,'>':8,'<=':8,'>=':8,'<<':9,'>>':9,'+':10,'-':10,'*':11,'/':11,'%':11};
      function expression(min=1){let left=postfix();while(i<ts.length){const op=peek(),p=precedence[op];if(!p||p<min)break;take();let right=expression(p+(p===1?0:1));let a=deref(left),b=deref(right),n=scalar(a),m=scalar(b),out=UNKNOWN;
        if(p===1){out=op==='='?b:op==='+='?n+m:op==='-='?n-m:op==='*='?n*m:op==='/='?n/m:UNKNOWN;setMaybe(left,out);}
        else if(isUnknown(a)||isUnknown(b)){out=UNKNOWN;}
        else {switch(op){case '||':out=+(!!a||!!b);break;case '&&':out=+(!!a&&!!b);break;case '==':out=+(a===b);break;case '!=':out=+(a!==b);break;
          case '<':out=+(n<m);break;case '>':out=+(n>m);break;case '<=':out=+(n<=m);break;case '>=':out=+(n>=m);break;
          case '+':out=n+m;break;case '-':out=n-m;break;case '*':out=n*m;break;case '/':out=m?Math.trunc(n/m):UNKNOWN;break;case '%':out=m?n%m:UNKNOWN;break;
          case '<<':out=n<<m;break;case '>>':out=n>>m;break;case '&':out=n&m;break;case '|':out=n|m;break;case '^':out=n^m;break;}}
        left={value:out};}
        return deref(left);
      }
      let result=expression(1);
      if(i<ts.length&&ts[i]?.v==='?' )warn('Opérateur ternaire non pris en charge : '+str(ts));
      if(i<ts.length&&ts[i]?.v!==',')warn('Expression partiellement analysée : '+str(ts.slice(i)).slice(0,65));
      return result;
    }
    const allocState=new Map(),freeBins=new Map();let heapNext=0x55555000;
    function allocate(size,method='malloc',type=null,callocArgs=null){
      if(!Number.isSafeInteger(size)||size<0||size>65536){warn(`Allocation ${method} de taille inconnue / hors borne : ${String(size)}`);return UNKNOWN;}
      const key=`alloc#${++counter}`;const physical=Math.max(32,Math.ceil((size+8)/16)*16);
      const recycled=(freeBins.get(physical)||[]).pop();const address=recycled?.address??heapNext;if(!recycled)heapNext+=physical;
      let block={key,type,address,size,physical,fields:{},freed:false};allocState.set(key,block);
      emit({op:method==='new'||method==='new[]'?'malloc':method,var:key,args:method==='calloc'?(callocArgs||[1,size]):[size],type,layout:pg.types[type]||null,
        raw:`${method}(${type?type+', ':''}${size}) → ${key}${recycled?' [réutilisation possible]':''}`});
      return {heapRef:key,type};
    }
    function detectPointer(expr){return isPtr(expr)?expr:null;}
    function call(name,params,meta={}){if(!name){warn('Appel indirect non résolu (pointeur de fonction).');return UNKNOWN;}
      name=name.replace(/^std::/,'');let [p,q,r]=params;
      switch(name){
        case 'malloc':return allocate(Number(p),'malloc');
        case 'calloc':return allocate(Number(p)*Number(q),'calloc',null,[Number(p),Number(q)]);
        case 'realloc':{
          warn('realloc simulé comme libération puis allocation : déplacement et conservation réelle des octets non garantis.');
          const old=detectPointer(p),n=Number(q);if(old){const b=allocState.get(old.heapRef);if(b&&!b.freed){b.freed=true;(freeBins.get(b.physical)||freeBins.set(b.physical,[]).get(b.physical)).push(b);}emit({op:'free',var:old.heapRef,raw:`realloc: libération de ${old.heapRef} (approximation)`});}
          return allocate(n,'malloc',old?.type||null);
        }
        case 'free':case 'delete':case 'delete[]':{
          if(p===0||p===null)return 0;const x=detectPointer(p);if(!x){warn(name+' : pointeur inconnu.');return UNKNOWN;}
          const block=allocState.get(x.heapRef);
          emit({op:'free',var:x.heapRef,raw:`${name}(${x.heapRef})`});
          if(block&&!block.freed){block.freed=true;(freeBins.get(block.physical)||freeBins.set(block.physical,[]).get(block.physical)).push(block);}
          return 0;
        }
        case 'memset':case 'fill':{
          if(isPtr(p)){
            const block=allocState.get(p.heapRef),n=Number(r);
            if(block&&Number(q)===0&&Number.isFinite(n)){
              const layout=pg.types[block.type];
              if(layout)for(const f of layout.fields)if(f.offset+f.size<=n)block.fields[f.name]=0;
            }
            emit({op:'fill',var:p.heapRef,byte:Number(q),count:n,raw:`${name}(${p.heapRef}, ${q}, ${r})`});
          }
          else warn(name+' : destination non suivie.');return p;
        }
        case 'strcpy':case 'strcat':case 'strncpy':case 'strncat':case 'memcpy':{
          if(isPtr(p))emit({op:name,var:p.heapRef,value:String(q??''),limit:typeof r==='number'?r:NaN,
             argvSource:/argv\s*\[\s*(\d+)\s*\]/.exec(meta.rawArgs?.[1]||'')?.[1],
             lengthArg:/argv\s*\[\s*(\d+)\s*\]/.exec(meta.rawArgs?.[2]||'')?.[1],
             raw:`${name}(${p.heapRef}, ${String(q).slice(0,35)}${r!==undefined?', '+r:''})`});
          else warn(name+' : destination non allouée par malloc/new dans le modèle.');return p;
        }
        case 'strlen':return typeof p==='string'?utf8(p):UNKNOWN;
        case 'atoi':case 'atol':case 'strtol':case 'strtoul':return Number.parseInt(p,10)||0;
        case 'rand':randSeed=(Math.imul(randSeed,1103515245)+12345)>>>0;return randSeed%32768;
        case 'srand':randSeed=Number(p)||0;return 0;
        case 'getc':case 'getchar':return inputPos<input.length?input.charCodeAt(inputPos++):-1;
        case 'puts':case 'printf':case 'fprintf':case 'sleep':case 'usleep':case 'fflush':return 0;
        case 'exit':stopped=true;return 0;
        case 'getline':warn('getline non simulé dans ce contexte.');return UNKNOWN;
      }
      if(pg.funcs.has(name))return invoke(name,params);
      warn('Appel non instrumenté : '+name+'() ; les effets heap internes sont inconnus.');return UNKNOWN;
    }
    function statement(ts){if(!ts.length)return;activeLine=ts[0]?.line||activeLine;
      let text=str(ts).trim();if(!text)return;
      if(/^delete\b/.test(text)){
        const rest=ts.slice(1+(ts[1]?.v==='['?2:0));let p=parseExpr(rest);call('delete',[p]);return;
      }
      if(/^std :: cin >>/.test(text)){
        const name=ts.at(-1)?.v;let start=input.slice(inputPos);let m=/^\s*(\S+)/.exec(start);if(m){inputPos+=m[0].length;const r=getVar(name);r.value=/^-?\d+$/.test(m[1])?Number(m[1]):m[1];}else warn('stdin épuisée pour cin >> '+name);return;
      }
      if(/^std :: cout/.test(text)||/^std :: cerr/.test(text))return;
      // Strip common C/C++ declaration prefixes, while retaining the initializer expression.
      const eq=ts.findIndex(t=>t.v==='=');
      const prefix=eq<0?ts:ts.slice(0,eq),words=prefix.map(t=>t.v);
      let name=words.filter(x=>/^[a-zA-Z_]\w*$/.test(x)).at(-1);
      const isDecl=(words[0]==='struct'||words[0]==='class'||words[0]==='const'||words[0]==='auto'||words[0]==='std'||['void','int','char','short','long','float','double','size_t','bool','unsigned','signed'].includes(words[0])||pg.types[words[0]]||words[0]==='unique_ptr');
      if(isDecl&&name&&!['return','delete','new'].includes(name)){
        // 'int *p' => variable p; 'Type list[3]' => array
        let typ=words[0]==='struct'||words[0]==='class'?words[1]:words[0];
        const arr=eq>=0?ts.slice(0,eq):ts;let arrays=arr.findIndex(t=>t.v==='[');
        const sz=arrays>=0?Number(arr[arrays+1]?.v):NaN;
        let init=Number.isInteger(sz)&&sz>=0&&sz<=2000?Array(sz).fill(0):0;
        let r=local(name,init,typ);if(eq>=0){const right=parseExpr(ts.slice(eq+1));r.value=right;
          if(isPtr(right)&&pg.types[typ]){right.type=typ;const bl=allocState.get(right.heapRef);if(bl){bl.type=typ;const ev=events.findLast(e=>e.var===right.heapRef&&['malloc','calloc'].includes(e.op));if(ev){ev.type=typ;ev.layout=pg.types[typ];}}}
          if(isPtr(right))emit({op:'alias',var:r.key,source:right.heapRef,raw:`${r.key} = ${right.heapRef}`});
        }
        return;
      }
      parseExpr(ts);
    }
    function condition(t,label){if(!t.length)return true;activeLine=t[0]?.line||activeLine;let v=parseExpr(t);
      if(isUnknown(v)||typeof v==='number'&&Number.isNaN(v)){
        unknowns.push(label+' : '+str(t).slice(0,80));
        warn('Branche indécidable : '+str(t).slice(0,75)+' (politique '+unknownBranch+').');return unknownBranch==='take';
      }return !!v;
    }
    function exec(ast){if(stopped||!ast)return null;
      if(++steps>maxSteps){warn('Borne atteinte : '+maxSteps+' instructions interprétées.');stopped=true;return {kind:'halt'};}
      switch(ast.kind){
        case 'empty':return null;
        case 'expr':statement(ast.tokens);return null;
        case 'block':return executeBlock(ast.body);
        case 'if':return exec(condition(ast.cond,'if')?ast.yes:ast.no);
        case 'return':return {kind:'return',value:ast.expr.length?parseExpr(ast.expr):0};
        case 'throw':warn('Exception C++ non simulée : '+str(ast.expr));return {kind:'return',value:UNKNOWN};
        case 'break':case 'continue':return {kind:ast.kind};
        case 'while':case 'for':case 'do':{
          if(ast.kind==='for'&&ast.init.length)statement(ast.init);
          for(let loop=0;loop<64&&!stopped;loop++){
            if(ast.kind!=='do'||loop>0){let c=ast.kind==='for'?ast.cond:ast.cond;if(!condition(c,ast.kind))break;}
            let flow=exec(ast.body);if(flow&&['return','halt'].includes(flow.kind))return flow;
            if(flow?.kind==='break')break;
            if(ast.kind==='for'&&ast.inc.length)statement(ast.inc);
            if(loop===63)warn('Boucle interrompue après 64 itérations : trace partielle.');
          }return null;
        }
        case 'switch':{
          const v=parseExpr(ast.cond);let active=false,found=false;
          for(const c of ast.cases){
            if(!active&&(c.label===null||v===parseExpr(c.label))){if(c.label===null&&found)continue;active=true;found=true;}
            if(active){let f=executeBlock(c.body);if(f?.kind==='break')return null;if(f)return f;}
          }return null;
        }
      }
    }
    function executeBlock(body){for(const n of body){const f=exec(n);if(f)return f;if(stopped)break;}return null;}
    function invoke(name,args){const fn=pg.funcs.get(name);if(!fn)return UNKNOWN;
      if(frames.length>=16){warn('Profondeur de récursion limitée à 16 appels.');return UNKNOWN;}
      const previous=current;current={vars:new Map(),parent:scope,name:name+'#'+(++callNum)};frames.push(name);
      for(let j=0;j<fn.params.length;j++)local(fn.params[j],args[j]??0);
      coverage.push(name+'()');let out=executeBlock(fn.body);
      frames.pop();current=previous;
      return out?.kind==='return'?out.value:0;
    }
    // Recognize global declarations, for example struct Human *human = NULL, Zombie *zombies[3].
    for(const g of pg.globals)statement(g);
    let entry=pg.funcs.has('main')?'main':pg.funcs.has('wmain')?'wmain':null;
    if(!entry){warn('Fonction main introuvable. Impossible de choisir un chemin exécutable dans ce code.');return {events,ignored:[],warnings:[...warnings],coverage:[],unknowns,types:pg.types};}
    invoke(entry,[initialArgs.length,initialArgs]);
    if(stopped)warn('Exécution symbolique interrompue : sortie du programme ou borne atteinte.');
    return {events,ignored:[],warnings:[...warnings],coverage:[...new Set(coverage)],unknowns,types:pg.types};
  }
  return {simulate,parseProgram,lex};
})();
