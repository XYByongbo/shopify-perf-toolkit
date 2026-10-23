import postcss from 'postcss';
import { liquidAST, visitAST } from './advanced-strategies.mjs';
import { indexThemeSources } from './source-attribution.mjs';
import { evidenceEnvelope } from './evidence-contract.mjs';

const name = n => typeof n.name==='string'?n.name:n.name?.map(x=>x.value??'').join('');
const line = (text,offset) => text.slice(0,offset).split('\n').length;
function classes(css, file, unresolved) {
  const found=new Set();
  try { postcss.parse(css).walkRules(rule=>{
    // Escaped/generated selectors are explicitly outside this small static checker.
    if(/\\|\{[{%]/.test(rule.selector)){unresolved.push({file,reason:'dynamic-or-escaped-selector'});return;}
    const selector=rule.selector.replace(/\[[^\]]*\]/g,'');
    for(const match of selector.matchAll(/\.([_a-zA-Z][\w-]*)/g))found.add(match[1]);
  }); } catch { unresolved.push({file,reason:'css-parse-error'}); }
  return found;
}

/** Advisory static compatibility analysis. It never relocates CSS or claims exact runtime reachability. */
export async function auditStylesheets({project,index}={}) {
  index??=await indexThemeSources(project);
  const definitions=new Map(),global=new Set(),uses=[],unresolved=[...index.unresolved],findings=[],files=[];
  for(const file of index.files){
    if(/^assets\/.*\.css$/.test(file.file)){for(const c of classes(file.text,file.file,unresolved))global.add(c);continue;}
    if(!file.file.endsWith('.liquid'))continue;
    const defined=new Set();let stylesheetCount=0;
    try {visitAST(liquidAST(file.text),node=>{
      if(node.type==='LiquidTag'&&node.name==='content_for')unresolved.push({file:file.file,line:line(file.text,node.position.start),reason:'theme-block-reachability-needs-official-theme-check'});
      if(node.type==='LiquidRawTag'&&node.name==='stylesheet'){
        stylesheetCount++;for(const c of classes(node.body.value,file.file,unresolved))defined.add(c);
      }
      for(const attr of node.attributes??[])if(name(attr)==='class'){
        if(attr.value?.some(n=>n.type!=='TextNode')){unresolved.push({file:file.file,line:line(file.text,attr.position.start),reason:'dynamic-class'});continue;}
        const value=attr.value?.map(n=>n.value??'').join('')??'';
        uses.push(...value.split(/\s+/).filter(Boolean).map(c=>({file:file.file,line:line(file.text,attr.position.start),className:c,sourceHash:file.sourceHash})));
      }
    });} catch {unresolved.push({file:file.file,reason:'liquid-parse-error'});}
    definitions.set(file.file,defined);files.push({file:file.file,sourceHash:file.sourceHash,stylesheetCount,classes:[...defined]});
  }
  const parents=new Map();
  for(const e of index.edges)if(['render','include'].includes(e.kind)){const a=parents.get(e.to)??[];a.push(e.from);parents.set(e.to,a);}
  // A definition in one possible caller is insufficient when another caller lacks it.
  const inherited=(file,c,visited=new Set())=>{
    if(definitions.get(file)?.has(c))return true;
    if(visited.has(file))return false;
    const next=new Set([...visited,file]),callers=parents.get(file)??[];
    return callers.length>0&&callers.every(p=>inherited(p,c,next));
  };
  for(const use of uses){
    const providers=[...definitions].filter(([,set])=>set.has(use.className)).map(([f])=>f);
    if(!providers.length||definitions.get(use.file)?.has(use.className)||inherited(use.file,use.className))continue;
    if(global.has(use.className)){unresolved.push({...use,reason:'asset-class-allowlisted-loading-still-needs-runtime-proof'});continue;}
    findings.push({...use,ruleId:'CSS_SCOPE_DEPENDENCY',status:'candidate',providers,summary:'Scoped CSS is defined outside this file or its guaranteed static render ancestors.',
      recommendation:'Co-locate the style, put it in a common explicit render ancestor, or review migration to a shared asset.'});
  }
  return {schemaVersion:1,kind:'stylesheet-audit',sourceHash:index.snapshot.hash,complete:unresolved.length===0,status:findings.length?'review-required':unresolved.length?'partial':'compatible-static-patterns',files,findings,unresolved,
    strategy:findings.length?'repair-scoped-dependencies':files.some(f=>f.stylesheetCount)?'native-subsetting-first':'review-resource-scoping-before-critical-css',
    dynamicSections:{styleSelector:'style[data-section-stylesheet]',requirement:'Partial Section Rendering API insertion must preserve the returned section stylesheet.'},
    evidence:evidenceEnvelope({type:'source',input:files,scope:'static-stylesheet-compatibility',sourceHash:index.snapshot.hash}),
    limitations:['This is a conservative supplementary checker, not the official ValidScopedCSSClass implementation.', 'Static ancestry is not actual rendered reachability. Dynamic classes, blocks, escaped selectors and unresolved graph edges require review.', 'Asset CSS is allowlisted, but its presence does not prove that it is loaded. Critical CSS and native subsetting address different scopes.']};
}
