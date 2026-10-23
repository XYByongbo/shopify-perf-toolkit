import {parse} from 'acorn';
import {visitAST} from './advanced-strategies.mjs';
import {sha256} from './runtime-profile.mjs';

const fail=message=>{throw Object.assign(new Error(message),{code:'UNSUPPORTED_CODE_PATTERN'});};

function checkFreeGlobals(tree) {
  const scopes=new Map(),binding=(scope,name)=>{if(!scopes.has(scope))scopes.set(scope,new Set());scopes.get(scope).add(name);};
  const isScope=n=>/Function/.test(n.type)||['Program','BlockStatement','CatchClause'].includes(n.type);
  const declare=(pattern,scope)=>{if(pattern?.type!=='Identifier')fail('Destructured controller bindings require a custom implementation.');binding(scope,pattern.name);};
  visitAST(tree,(n,parents)=>{
    if(/Function/.test(n.type)) {for(const p of n.params)declare(p,n);if(n.id)binding(n,n.id.name);}
    if(n.type==='FunctionDeclaration')declare(n.id,[...parents].reverse().find(isScope));
    if(n.type==='VariableDeclarator')declare(n.id,[...parents].reverse().find(p=>parents.at(-1).kind==='var'?/Function/.test(p.type)||p.type==='Program':isScope(p)));
    if(n.type==='CatchClause'&&n.param)declare(n.param,n);
  });
  const globals=new Set(['fetch','URL','location','document','DOMParser','Error','undefined','NaN','Infinity','Boolean','String','Number','Math','JSON','Object','Array','Promise','console']);
  visitAST(tree,(n,parents)=>{
    if(n.type==='ThisExpression')fail('Controller depends on a shared execution context.');
    if(n.type!=='Identifier')return;
    const p=parents.at(-1);
    if(p?.type==='MemberExpression'&&p.property===n&&!p.computed||p?.type==='Property'&&p.key===n&&!p.computed&&!p.shorthand
      ||p?.type==='VariableDeclarator'&&p.id===n||/Function/.test(p?.type??'')&&(p.id===n||p.params.includes(n))||p?.type==='CatchClause'&&p.param===n)return;
    if(!globals.has(n.name)&&!parents.some(a=>scopes.get(a)?.has(n.name)))fail('Controller consumes an unproven shared global: '+n.name);
  });
}

// One mount per live section. Editor unload invalidates pending work before replacement.
export function sectionControllerRuntime(key,signature,selector,install) {
  const marker=Symbol.for(key),previous=document[marker];
  if(previous?.signature===signature){previous.refresh();return;}
  previous?.dispose();
  let root=null,abort=null,sequence=0,listeners=[];
  const unmount=()=>{
    sequence++;abort?.abort();abort=null;
    for(const [type,listener] of listeners)document.removeEventListener(type,listener);
    listeners=[];root=null;
  };
  const refresh=()=>{
    const targets=document.querySelectorAll(selector),next=targets.length===1?targets[0].closest('[id^="shopify-section-"]'):null;
    if(root===next)return;
    unmount();if(!next)return;
    root=next;abort=new AbortController();
    const mounted=root,signal=abort.signal;
    install({signal,
      begin:()=>++sequence,
      current:token=>!signal.aborted&&token===sequence&&mounted.isConnected&&document.querySelector(selector)?.closest('[id^="shopify-section-"]')===mounted,
      listen(type,handler){
        const listener=event=>{if(!signal.aborted&&event.target instanceof Node&&mounted.contains(event.target))handler(event);};
        document.addEventListener(type,listener);listeners.push([type,listener]);
      }
    });
  };
  const unload=event=>{if(root&&(event.target===root||event.target?.contains?.(root)))unmount();};
  const dispose=()=>{unmount();document.removeEventListener('shopify:section:load',refresh);document.removeEventListener('shopify:section:unload',unload);delete document[marker];};
  document[marker]={signature,refresh,dispose};
  document.addEventListener('shopify:section:load',refresh);
  document.addEventListener('shopify:section:unload',unload);refresh();
}

/** Conservative controller shape permits guarding all asynchronous DOM writes. */
export function managedSectionController({source,controller,startup,selector,file}) {
  checkFreeGlobals(parse(source,{ecmaVersion:'latest',sourceType:'script'}));
  const key='perfkit:initial-liquid:'+sha256(file+selector).slice(0,16),suffix=sha256(source).slice(0,12);
  const api='__perfkitLife_'+suffix,token='__perfkitRequest_'+suffix,error='__perfkitError_'+suffix;
  if([api,token,error].some(n=>source.includes(n)))fail('Controller lifecycle binding collides with source.');
  const tree=parse(controller,{ecmaVersion:'latest',sourceType:'script'}),fn=tree.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===startup.name);
  if(!fn||fn.params.some(p=>p.type!=='Identifier'))fail('Controller requires a plain async loader and explicit parameters.');
  const edits=[];
  for(const n of tree.body) {
    if(n===fn)continue;
    const c=n.type==='ExpressionStatement'&&n.expression;
    if(c?.type!=='CallExpression'||c.callee.type!=='MemberExpression'||c.callee.computed||c.callee.object.name!=='document'||c.callee.property.name!=='addEventListener'
      ||c.arguments.length!==2||c.arguments[0].type!=='Literal'||!['click','keydown','change','input','pointerup'].includes(c.arguments[0].value)
      ||!['FunctionExpression','ArrowFunctionExpression'].includes(c.arguments[1].type)||c.arguments[1].async)fail('Managed controller supports only the loader and synchronous delegated document listeners.');
    edits.push({start:c.callee.start,end:c.callee.end,text:api+'.listen'});
  }
  let invalid=false;
  visitAST(fn,(n,parents)=>{
    if(n.type==='CallExpression'&&n.callee.type==='FunctionExpression'&&n.callee.id?.name==='scopedSectionFetch')
      edits.push({start:n.end-1,end:n.end-1,text:','+api+'.signal'});
    if(n.type==='AwaitExpression'&&parents.filter(p=>/Function/.test(p.type)).at(-1)===fn) {
      const statement=parents.find(p=>p.type==='VariableDeclaration'&&fn.body.body.includes(p));
      if(!statement||statement.declarations.length!==1||statement.declarations[0].init!==n)invalid=true;
      else edits.push({start:statement.end,end:statement.end,text:`\n  if (!${api}.current(${token})) return;`});
    }
  });
  // Install closures must not depend on other top-level initializers or delayed callbacks.
  visitAST(parse(source,{ecmaVersion:'latest',sourceType:'script'}),(n,parents)=>{
    if(n.type==='FunctionDeclaration'&&n.id.name!==startup.name||n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&['then','finally','setTimeout','setInterval'].includes(n.callee.property?.name)
      ||n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&n.callee.property?.name==='catch'&&!(n.callee.object.type==='CallExpression'&&n.callee.object.callee.type==='Identifier'&&n.callee.object.callee.name===startup.name)
      ||n.type==='CallExpression'&&n.callee.type==='Identifier'&&['setTimeout','setInterval','requestAnimationFrame','queueMicrotask','eval'].includes(n.callee.name))invalid=true;
  });
  if(invalid)fail('All loader awaits must be standalone variable initializers; delayed or nested controller logic requires a custom lifecycle implementation.');
  edits.push({start:fn.body.start+1,end:fn.body.start+1,text:`\n  const ${token} = ${api}.begin();\n  try {`},
    {start:fn.body.end-1,end:fn.body.end-1,text:`\n  } catch (${error}) { if (${api}.current(${token})) throw ${error}; }\n`});
  let body=controller;for(const e of edits.sort((a,b)=>b.start-a.start))body=body.slice(0,e.start)+e.text+body.slice(e.end);
  parse(`function install(${api}){${body}}`,{ecmaVersion:'latest'});
  const signature=sha256(body),script=`(${sectionControllerRuntime.toString()})(${JSON.stringify(key)},${JSON.stringify(signature)},${JSON.stringify(selector)},function(${api}) {\n${body}\n});\n`;
  parse(script,{ecmaVersion:'latest'});
  return {script,api,key,signature,bodyBytes:Buffer.byteLength(body)};
}
