import {liquidAST,visitAST} from './advanced-strategies.mjs';
import {literalAttribute,lookupPath} from './performance-syntax.mjs';
import {digest} from './evidence-contract.mjs';

const fail=message=>{throw Object.assign(new Error(message),{code:'UNSUPPORTED_CODE_PATTERN'});};
const significant=nodes=>(nodes??[]).filter(n=>n.type!=='TextNode'||n.value.trim());
export const themeContracts={
  'stylesheet-once':{review:['cascadeAndOrderReviewed','cssomIndependent','sharedCallersReviewed','allStatesReviewed']},
  'liquid-collapse-forwarder':{review:['profileHotspotConfirmed','renderScopeReviewed','sharedCallersReviewed','allStatesReviewed']},
};
function renders(text) {
  const out=[];visitAST(liquidAST(text),(node,parents)=>{
    if(node.type==='LiquidTag'&&node.name==='render'&&node.markup?.snippet?.type==='String'&&!node.markup.variable&&!node.markup.alias)
      out.push({node,parents,name:node.markup.snippet.value});
  });return out;
}
const snippetFile=name=>/^[\w-]+$/.test(name)?`snippets/${name}.liquid`:null;
function bodyFile(files,name) {return files.find(f=>f.file===snippetFile(name));}
export function forwarderTargets(file,files) {
  const out=[];
  for(const call of renders(file.text)) {
    const wrapper=bodyFile(files,call.name);if(!wrapper)continue;
    const children=liquidAST(wrapper.text).children;
    if(children.length!==1)continue;
    const only=renders(wrapper.text);
    if(only.length!==1||children[0].type!=='LiquidTag'||children[0].name!=='render'||only[0].node.position.start!==0||only[0].node.position.end!==wrapper.text.length||only[0].name===call.name)continue;
    const inner=only[0],leaf=bodyFile(files,inner.name);if(!leaf||leaf.file===file.file)continue;
    const args=inner.node.markup.args,outerArgs=call.node.markup.args;
    if(!args.length||args.some(a=>a.type!=='NamedArgument'||lookupPath(a.value)!==a.name)||new Set(args.map(a=>a.name)).size!==args.length
      ||outerArgs.length!==args.length||new Set(outerArgs.map(a=>a.name)).size!==args.length||outerArgs.some(a=>a.type!=='NamedArgument'||!args.some(x=>x.name===a.name)))continue;
    // Reserved ambient state cannot be forwarded by a proof about named values alone.
    if(/\b(?:forloop|tablerowloop|include|increment|decrement)\b/.test(leaf.text))continue;
    out.push({offset:call.node.position.start,line:file.text.slice(0,call.node.position.start).split('\n').length,
      methods:['liquid-collapse-forwarder'],wrapper:wrapper.file,leaf:leaf.file,innerName:inner.name,
      costFiles:[file.file,wrapper.file,leaf.file],dependencies:[wrapper,leaf].map(f=>({file:f.file,text:f.text,sourceHash:digest(f.text)}))});
  }
  return out;
}
export function collapseForwarder(source,offset,files) {
  const target=forwarderTargets({file:'caller.liquid',text:source},files).find(x=>x.offset===offset);if(!target)fail('Select one pure named-argument forwarding render.');
  const call=renders(source).find(x=>x.node.position.start===offset),pos=call.node.markup.snippet.position;
  return source.slice(0,pos.start)+JSON.stringify(target.innerName)+source.slice(pos.end);
}

/** Only literal stylesheet output at the start of a snippet; no global URL deduplication. */
function leadingStylesheet(text) {
  const tree=liquidAST(text),first=significant(tree.children)[0];
  if(first?.type!=='LiquidVariableOutput')return null;
  const m=first.markup;
  if(m?.expression?.type!=='String'||!m.expression.value.endsWith('.css')||m.filters?.length!==2
    ||m.filters[0].name!=='asset_url'||m.filters[0].args.length||m.filters[1].name!=='stylesheet_tag'||m.filters[1].args.length)return null;
  return {node:first,asset:m.expression.value};
}
export function stylesheetOnceTargets(file,files) {
  const out=[];
  for(const call of renders(file.text)) {
    const loops=call.parents.filter(n=>n.type==='LiquidTag'&&n.name==='for');
    if(loops.length!==1||call.parents.some(n=>n.type==='LiquidTag'&&['capture','tablerow','paginate'].includes(n.name)))continue;
    const snippet=bodyFile(files,call.name);if(!snippet)continue;
    const style=leadingStylesheet(snippet.text);if(!style)continue;
    const root=[...call.parents].reverse().find(n=>n.type==='HtmlElement'&&literalAttribute(n,'id'));
    const id=root&&literalAttribute(root,'id');if(!id||!/^[A-Za-z_][\w-]*$/.test(id))continue;
    if(renders(file.text).filter(x=>x.name===call.name&&x.parents.some(p=>p.type==='LiquidTag'&&p.name==='for'&&p.position.start===loops[0].position.start)).length!==1)continue;
    const asset=files.find(f=>f.file===`assets/${style.asset}`);if(!asset)continue;
    out.push({offset:call.node.position.start,line:file.text.slice(0,call.node.position.start).split('\n').length,methods:['stylesheet-once'],
      snippet:snippet.file,asset:asset.file,rootSelector:'#'+id,loopOffset:loops[0].position.start,
      dependencies:[snippet,asset].map(f=>({file:f.file,text:f.text,sourceHash:digest(f.text)}))});
  }return out;
}
export function stylesheetOncePatch(callerFile,source,offset,files) {
  const t=stylesheetOnceTargets({file:callerFile,text:source},files).find(t=>t.offset===offset);if(!t)fail('Repeated stylesheet call is outside the supported loop/snippet subset.');
  const snippet=files.find(f=>f.file===t.snippet),style=leadingStylesheet(snippet.text),call=renders(source).find(c=>c.node.position.start===offset);
  const key='perfkit_styles_'+digest([callerFile,source,offset]).slice(0,12),param='skip_'+key;
  if(source.includes(key)||snippet.text.includes(key)||call.node.markup.args.some(a=>a.name===param))fail('Generated stylesheet state collides with source.');
  const tag=source.slice(call.node.position.start,call.node.position.end),close=tag.lastIndexOf('%}'),insert=close-(tag[close-1]==='-'?1:0);
  const render=tag.slice(0,insert)+`, ${param}: ${key} `+tag.slice(insert);
  const loop=call.parents.find(p=>p.type==='LiquidTag'&&p.name==='for'),left=loop.whitespaceStart==='-'?'{%-':'{%';
  const right=call.node.whitespaceEnd==='-'?'-%}':'%}';
  const edits=[{start:t.loopOffset,end:t.loopOffset,text:`${left} assign ${key} = false %}`},
    {start:call.node.position.start,end:call.node.position.end,text:render+`{% assign ${key} = true ${right}`}];
  let caller=source;for(const e of edits.sort((a,b)=>b.start-a.start))caller=caller.slice(0,e.start)+e.text+caller.slice(e.end);
  const styleLeft=style.node.whitespaceStart==='-'?'{%-':'{%',styleRight=style.node.whitespaceEnd==='-'?'-%}':'%}';
  const child=snippet.text.slice(0,style.node.position.start)+`${styleLeft} unless ${param} %}`+snippet.text.slice(style.node.position.start,style.node.position.end)+`{% endunless ${styleRight}`+snippet.text.slice(style.node.position.end);
  liquidAST(caller);liquidAST(child);
  return {caller,snippet:child,target:t,key,param};
}

/** Runtime style ordering is necessary: an interleaved style can change the cascade. */
export function repeatedStylesheetEvidence(profile,target,{interaction=false}={}) {
  const sheets=profile.initial?.delivery?.stylesheets;
  if(!Array.isArray(sheets)||profile.initial.delivery.truncated)return null;
  const matches=sheets.map((s,i)=>({s,i})).filter(({s})=>s.tag==='LINK'&&s.assetName===target.asset.slice(7)&&s.rootSelectors?.includes(target.rootSelector));
  if(matches.length<2||matches.some(({s})=>s.onLoad||s.disabled||s.media&&!s.mediaMatches))return null;
  const first=matches[0].s;
  if(matches.some(({s})=>['href','media','crossOrigin','integrity'].some(k=>s[k]!==first[k])))return null;
  if(matches.at(-1).i-matches[0].i+1!==matches.length)return null;
  const costs=interaction?profile.interactionStyleCosts:profile.styleCosts,work=costs?.styleRecalcMs;
  if(costs?.complete!==true||!Number.isFinite(work)||work<10)return null;
  return {href:first.href,count:matches.length,rootSelector:target.rootSelector,styleRecalcMs:work,costWindow:interaction?'single-interaction':'initial-navigation'};
}

/** Rebuild paired source edits before permitting their narrowly scoped DOM delta. */
export function themePlanDeltas(plan) {
  const entries=plan?.changes?.filter(c=>themeContracts[c.evidence?.domainMethod])??[];
  if(!entries.length)return [];
  if(entries.length!==plan.changes.length)throw new Error('Mixed theme-optimization contract.');
  const contract=entries[0].evidence.themeOptimization;
  if(!contract||entries.some(c=>digest(c.evidence.themeOptimization)!==digest(contract)||c.evidence.domainMethod!==contract.method
    ||themeContracts[contract.method].review.some(k=>c.evidence[k]!==true)))throw new Error('Inconsistent theme source proof.');
  const caller=entries.find(c=>c.target===contract.file),files=contract.inputs;
  if(!caller||!Array.isArray(files)||files.some(f=>digest(f.text)!==f.sourceHash))throw new Error('Missing original theme dependency proof.');
  if(contract.method==='liquid-collapse-forwarder') {
    if(entries.length!==1||collapseForwarder(caller.before,contract.offset,files)!==caller.after)throw new Error('Forwarding patch differs from its transform.');
    return [];
  }
  const patch=stylesheetOncePatch(caller.target,caller.before,contract.offset,files),child=entries.find(c=>c.target===patch.target.snippet),delta=contract.resourceDelta;
  if(entries.length!==2||caller.after!==patch.caller||child?.after!==patch.snippet||child.before!==files.find(f=>f.file===child.target)?.text
    ||delta?.kind!=='stylesheet-once'||delta.selector!==patch.target.rootSelector||delta.asset!==patch.target.asset
    ||!Number.isInteger(delta.beforeCount)||delta.beforeCount<2||delta.afterCount!==1
    ||decodeURIComponent(new URL(delta.href).pathname.split('/').at(-1))!==patch.target.asset.slice(7))throw new Error('Stylesheet patch or resource delta differs from its source transform.');
  return [delta];
}
