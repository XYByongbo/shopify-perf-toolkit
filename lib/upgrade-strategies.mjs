import {liquidAST,visitAST} from './advanced-strategies.mjs';
const fail=m=>{throw Object.assign(new Error(m),{code:'UNSUPPORTED_CODE_PATTERN'});};
export const upgradeStrategies=[
  {kind:'liquid-font-display',targets:'Liquid font_face output',parameters:['outputStart','display'],
    evidenceRequired:['sourceHash','summary','fontUsageReviewed','fallbackMetricsReviewed'],
    effect:'Set display on one font_face output without replacing the font.',boundary:'One static font_display keyword; other filters and arguments preserved.',
    verification:['Compare actual font loading, text wrapping, geometry and CLS across affected states.','Run independent metric experiment.']},
  {kind:'liquid-rehost-resource',targets:'Literal external script/link/img',parameters:['tagStart','replacementUrl','originalBodyHash','replacementBodyHash'],
    evidenceRequired:['sourceHash','summary','identicalResponseBytesReviewed','dependenciesReviewed','contentTypeReviewed','corsAndIntegrityReviewed'],
    effect:'Replace one literal asset URL with an explicitly supplied equivalent resource URL.',boundary:'Identical nonempty SHA-256, no responsive sources, handlers or dynamic attributes; no automatic download.',
    verification:['Verify browser GET response bytes, content type, CORS, redirects and original dependency behavior.','URL replacement is not performance acceptance; use independent measurements and content review.']},
];
export function upgradeTransform(source,target,kind,p) {
  if(!/^(sections|snippets|layout|templates|blocks)\/.+\.liquid$/.test(target))fail('Expected a theme Liquid source.');
  const tree=liquidAST(source);let change;
  if(kind==='liquid-font-display') {
    if(!['swap','optional'].includes(p.display))fail('Font display must be swap or optional.');
    visitAST(tree,n=>{
      if(n.type!=='LiquidVariableOutput'||n.position.start!==p.outputStart)return;
      const filters=n.markup?.filters?.filter(f=>f.name==='font_face')??[];
      if(filters.length!==1)fail('Select exactly one font_face filter.');
      const f=filters[0],args=f.args.filter(a=>a.name==='font_display');
      if(args.length>1||f.args.some(a=>a.type!=='NamedArgument'))fail('Dynamic or positional font arguments require review.');
      if(args.length){const a=args[0].value;if(a?.type!=='String')fail('Dynamic font display is unsupported.');change={start:a.position.start,end:a.position.end,after:`'${p.display}'`};}
      else change={start:f.position.end,end:f.position.end,after:`${f.args.length?',':':'} font_display: '${p.display}'`};
    });
  }else {
    if(!/^[a-f0-9]{64}$/.test(p.originalBodyHash??'')||p.originalBodyHash!==p.replacementBodyHash)fail('Equivalent original and replacement response hashes are required.');
    const url=new URL(p.replacementUrl);if(url.protocol!=='https:'||url.username||url.password||/["'<>\r\n]/.test(url.href))fail('Expected an explicit safe HTTPS replacement.');
    visitAST(tree,(n,parents)=>{
      if(n.position?.start!==p.tagStart||!['HtmlRawNode','HtmlVoidElement'].includes(n.type))return;
      if(parents.some(p=>p.type==='LiquidRawTag'||p.type==='LiquidTag'&&['capture','for','tablerow'].includes(p.name)||p.type==='HtmlElement'&&['picture','template','noscript'].includes(typeof p.name==='string'?p.name:p.name?.map(x=>x.value).join(''))))fail('Opaque, repeated or responsive resource contexts require review.');
      const name=typeof n.name==='string'?n.name:n.name?.map(x=>x.value).join('');
      if(!['script','link','img'].includes(name))fail('Only script/link/img resources are supported.');
      if(n.attributes.some(a=>a.type!=='AttrSingleQuoted'&&a.type!=='AttrDoubleQuoted'&&a.type!=='AttrUnquoted'&&a.type!=='AttrEmpty'))fail('Dynamic attributes require review.');
      const attrs=n.attributes.map(a=>({node:a,name:a.name?.map(x=>x.value).join('').toLowerCase(),value:a.value?.every(x=>x.type==='TextNode')?a.value.map(x=>x.value).join(''):null}));
      if(new Set(attrs.map(a=>a.name)).size!==attrs.length||attrs.some(a=>/^on/i.test(a.name)||['srcset','sizes'].includes(a.name)))fail('Responsive resources, duplicate attributes and handlers require review.');
      if(name==='link'&&!attrs.some(a=>a.name==='rel'&&['stylesheet','preload','modulepreload','icon'].includes(a.value)))fail('Only asset links can be rehosted.');
      if(name==='link'&&attrs.some(a=>a.name==='rel'&&a.value==='preload')&&!attrs.some(a=>a.name==='as'&&['font','image','style','script'].includes(a.value)))fail('Preload requires an explicit asset type.');
      const identity=attrs.find(a=>a.name==='id')?.value;
      if(!/^[A-Za-z_][\w-]*$/.test(identity??''))fail('Resource replacement requires a literal unique id.');
      let instances=0;visitAST(tree,x=>{if(x.attributes?.some(a=>a.name?.map(t=>t.value).join('').toLowerCase()==='id'&&a.value?.every(t=>t.type==='TextNode')&&a.value.map(t=>t.value).join('')===identity))instances++;});
      if(instances!==1)fail('Resource id must be unique in source.');
      const selected=attrs.filter(a=>a.name===(name==='link'?'href':'src'));
      if(selected.length!==1||!/^https?:\/\//.test(selected[0].value??''))fail('Expected one literal external resource.');
      if(attrs.some(a=>a.node.value?.some(x=>x.type!=='TextNode')))fail('Dynamic attributes require review.');
      const a=selected[0].node;
      change={start:a.position.start,end:a.position.end,after:`${selected[0].name}="${url.href.replace(/&/g,'&amp;')}"`};
    });
  }
  if(!change)fail('Selected source node was not found.');
  const after=source.slice(0,change.start)+change.after+source.slice(change.end);
  if(after===source)fail('No eligible change.');liquidAST(after);
  return {after,edits:[{...change,before:source.slice(change.start,change.end)}]};
}
