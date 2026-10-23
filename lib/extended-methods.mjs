import {parse} from 'acorn';
import {liquidAST,visitAST} from './advanced-strategies.mjs';
import {htmlName,literalAttribute,lookupPath} from './performance-syntax.mjs';
import {initialSectionStartup} from './section-liquid.mjs';

const fail=message=>{throw Object.assign(new Error(message),{code:'UNSUPPORTED_CODE_PATTERN'});};
export const extendedContracts={
  'query-limit':{parameters:[],review:['profileHotspotConfirmed','loopScopeReviewed','paginationIsolationReviewed']},
  'query-paginate':{parameters:[],review:['profileHotspotConfirmed','loopScopeReviewed','paginationIsolationReviewed','paginationPagesReviewed']},
  'hidden-detach':{parameters:[],review:['initiallyHiddenReviewed','dependencyLifecycleReviewed','noJsFallbackReviewed','allStatesReviewed','inlineScriptAllowed']},
  'hidden-template':{recovery:'comparison-only',parameters:['newAsset'],review:['initiallyHiddenReviewed','dependencyLifecycleReviewed','noJsFallbackReviewed','allStatesReviewed']},
  'hidden-template-chunked':{recovery:'comparison-only',parameters:['newAsset'],review:['initiallyHiddenReviewed','dependencyLifecycleReviewed','noJsFallbackReviewed','allStatesReviewed']},
  'section-fetch-single':{parameters:['sectionSelector'],review:['responseScopeReviewed','sectionSettingsReviewed','fallbackReviewed','allStatesReviewed']},
  'section-fetch-json':{parameters:['sectionSelector'],review:['responseScopeReviewed','sectionSettingsReviewed','fallbackReviewed','allStatesReviewed']},
  'section-liquid-initial':{parameters:['sectionSelector','initialLiquid'],review:['responseScopeReviewed','sectionSettingsReviewed','fallbackReviewed','allStatesReviewed','initialContentReviewed','startupSideEffectsReviewed','globalRenderInputsReviewed','dynamicUpdatesReviewed','controllerIsolationReviewed']},
  'section-liquid-inline':{parameters:['sectionSelector','initialLiquid'],review:['responseScopeReviewed','sectionSettingsReviewed','fallbackReviewed','allStatesReviewed','initialContentReviewed','startupSideEffectsReviewed','globalRenderInputsReviewed','dynamicUpdatesReviewed','inlineScriptAllowed','controllerIsolationReviewed']},
};
const native=/^(collection\.products|collections(?:\.[A-Za-z_]\w*\.products)?)$/;
const pageable=/^(blog\.articles|search\.results|pages|product\.variants|customer\.orders|customer\.addresses|article\.comments)$/;
const lineAt=(s,o)=>s.slice(0,o).split('\n').length;
function loops(source) {
  const out=[];visitAST(liquidAST(source),(node,parents)=>{if(node.type==='LiquidTag'&&node.name==='for')out.push({node,parents});});return out;
}
export function queryPatch(source,offset,method) {
  const entry=loops(source).find(x=>x.node.position.start===offset);if(!entry)fail('Measured query loop not found.');
  const {node,parents}=entry,m=node.markup,array=lookupPath(m.collection);
  if(parents.some(p=>p.type==='LiquidTag'&&['paginate','for','capture','tablerow'].includes(p.name))||m.reversed)fail('Nested/paginated/reversed queries need a different implementation.');
  const original=source.slice(node.position.start,node.position.end);
  let replacement;
  if(method==='query-limit') {
    if(!native.test(array??'')||m.args.length)fail('Only an unpaginated products/collections query with a literal output cap can use limit.');
    // This exact subset has identical whitespace and visible items; it cannot silently truncate content.
    const match=original.match(/^\{%-\s*for\s+(\w+)\s+in\s+([\w.]+)\s*-\%\}\s*\{%-\s*if\s+forloop\.index\s*<=\s*(\d+)\s*-\%\}([\s\S]*)\{%-\s*endif\s*-\%\}\s*\{%-\s*endfor\s*-\%\}$/);
    if(!match||Number(match[3])<1||Number(match[3])>50||/\{%/.test(match[4]))fail('Query limit requires a sole trimmed index guard and pure output body.');
    if(/\bforloop\b/.test(match[4].replace(/\bforloop\.(?:index|index0|first)\b/g,'')))fail('Loop metadata depends on the full query.');
    replacement=`{%- for ${match[1]} in ${array} limit: ${Number(match[3])} -%}${match[4]}{%- endfor -%}`;
  }else if(method==='query-paginate') {
    if(!pageable.test(array??''))fail('Select a supported non-products array that needs paginate for fetch control.');
    const limit=m.args.find(a=>a.name==='limit'),off=m.args.find(a=>a.name==='offset');
    const size=Number(limit?.value?.value),name=lookupPath(off?.value);
    if(limit?.value.type!=='Number'||!Number.isInteger(size)||size<1||size>50||m.args.length!==2||!name||name.includes('.'))fail('Paginate conversion requires an existing literal page size and explicit manual page offset.');
    // Convert an existing paging algorithm, never paginate a fixed carousel. Keep its existing navigation and assignment.
    const before=source.slice(0,node.position.start),assignment=new RegExp(`\\{%[-]?\\s*assign\\s+${name}\\s*=\\s*current_page\\s*\\|\\s*minus:\\s*1\\s*\\|\\s*times:\\s*${size}\\s*[-]?%\\}\\s*$`);
    if(!assignment.test(before)||/\{%[-]?\s*paginate\b/.test(source))fail('Manual offset must be assigned immediately from (current_page - 1) * page size; existing pagination cannot be nested.');
    const body=source.slice(node.blockStartPosition.end,node.blockEndPosition.start);
    if(/\b(?:paginate|current_page|forloop)\b/.test(body)||/\{%[-]?\s*(?:assign|capture|increment|decrement|include|liquid|break|continue)\b/.test(body))fail('Paging body has metadata/shared-scope dependencies.');
    const open=source.slice(node.blockStartPosition.start,node.blockStartPosition.end);
    const relative=off.position.start-node.position.start;
    const newOpen=open.slice(0,relative)+open.slice(off.position.end-node.position.start);
    replacement=`{% paginate ${array} by ${size} %}`+newOpen+body+source.slice(node.blockEndPosition.start,node.blockEndPosition.end)+'{% endpaginate %}';
  }else fail('Unknown query implementation.');
  const after=source.slice(0,node.position.start)+replacement+source.slice(node.position.end);liquidAST(after);return after;
}
export function queryTargets(source) {
  const found=[];for(const {node} of loops(source)){
    const methods=['query-limit','query-paginate'].filter(method=>{try{queryPatch(source,node.position.start,method);return true;}catch{return false;}});
    if(methods.length)found.push({offset:node.position.start,line:lineAt(source,node.position.start),endLine:lineAt(source,node.position.end),node,methods});
  }return found;
}
export function hiddenTargets(source) {
  const result=[];visitAST(liquidAST(source),(node,parents)=>{
    if(node.type!=='HtmlElement'||htmlName(node)!=='details'||!literalAttribute(node,'id')||node.attributes.some(a=>htmlName(a)==='open'||htmlName(a)?.startsWith('on'))
      ||parents.some(p=>p.type==='LiquidTag'||['HtmlRawNode','HtmlComment'].includes(p.type)||htmlName(p)==='template'))return;
    const children=node.children.filter(n=>n.type!=='TextNode'||n.value.trim());
    if(children.length!==2||htmlName(children[0])!=='summary'||htmlName(children[1])!=='div'||children[1].type!=='HtmlElement')return;
    const body=children[1],id=literalAttribute(node,'id'),bodyId=literalAttribute(body,'id');
    if(!/^[A-Za-z_][\w-]*$/.test(id)||!bodyId||!/^[A-Za-z_][\w-]*$/.test(bodyId))return;
    let unsafe=/<\/(?:template|noscript)\b/i.test(source.slice(body.blockStartPosition.end,body.blockEndPosition.start));visitAST(body,n=>{
      if(['script','style','template','noscript','iframe','object','embed'].includes(htmlName(n))||htmlName(n)?.includes('-')
        ||n.attributes?.some(a=>htmlName(a)?.startsWith('on'))
        ||n.type==='LiquidRawTag'&&n.name!=='comment'
        ||n.type==='LiquidTag'&&!['for','if','unless','case','break','continue'].includes(n.name)
        ||n.type==='LiquidVariableOutput'&&!['escape','escape_once'].includes(n.markup?.filters?.at(-1)?.name))unsafe=true;
    });
    if(!unsafe)result.push({offset:node.position.start,line:lineAt(source,node.position.start),node,body,id,bodyId,methods:['hidden-detach','hidden-template','hidden-template-chunked']});
  });return result;
}
export function fetchTargets(source) {
  const tree=parse(source,{ecmaVersion:'latest',sourceType:'module'}),out=[];
  // Preserve the native fetch contract; shadowed bindings and request options need separate handling.
  let shadow=false;visitAST(tree,(n,parents)=>{
    const reserved=/"(?:fetch|globalThis|document|window|location)"/;
    if(n.type==='VariableDeclarator'&&reserved.test(JSON.stringify(n.id))
      ||/Function/.test(n.type)&&reserved.test(JSON.stringify([n.id,...(n.params??[])]))
      ||n.type==='CatchClause'&&reserved.test(JSON.stringify(n.param))||/^Import/.test(n.type))shadow=true;
    if(n.type==='Identifier'&&n.name==='fetch'&&!(parents.at(-1)?.type==='CallExpression'&&parents.at(-1).callee===n))shadow=true;
  });
  if(shadow)return [];
  visitAST(tree,n=>{if(n.type==='CallExpression'&&!n.optional&&n.callee.type==='Identifier'&&n.callee.name==='fetch'&&n.arguments.length===1
    &&n.arguments[0].type!=='SpreadElement'&&!(n.arguments[0].type==='Literal'&&typeof n.arguments[0].value!=='string'))
    out.push({offset:n.start,end:n.end,line:lineAt(source,n.start),node:n,argument:source.slice(n.arguments[0].start,n.arguments[0].end),methods:['section-fetch-single','section-fetch-json',...(initialSectionStartup(source,n.start)?['section-liquid-initial','section-liquid-inline']:[])]});});return out;
}

/** Parse captured bytes off-page, without executing HTML or issuing resource requests. */
export function sectionResponseEvidence(url,body) {
  const u=new URL(url),id=u.searchParams.get('section_id')??u.searchParams.get('sections');
  if(!id||! /^[\w-]+$/.test(id))return undefined;
  try {
    const html=u.searchParams.has('sections')?JSON.parse(body)[id]:body;
    if(typeof html!=='string'||!html.trim())return {id,valid:false};
    let count=0;visitAST(liquidAST(html),(node,parents)=>{
      if(node.type==='HtmlElement'&&literalAttribute(node,'id')==='shopify-section-'+id
        &&!parents.some(p=>['template','noscript'].includes(htmlName(p))))count++;
    });
    return {id,valid:count===1};
  }catch{return {id,valid:false};}
}
