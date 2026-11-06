import {toLiquidHtmlAST} from '@shopify/liquid-html-parser';
import {canonical} from '../core/plan-utils.mjs';

const literal=value=>typeof value==='string'?value:Array.isArray(value)&&value.every(n=>n.type==='TextNode')?value.map(n=>n.value).join(''):null;
const name=node=>literal(node.name)?.toLowerCase();
const attribute=(node,key)=>literal(node.attributes?.find(a=>name(a)===key)?.value);
const isHTML=node=>/^Html(?:Element|VoidElement|SelfClosingElement|RawNode)$/.test(node.type??'');
const control=node=>node&&typeof node==='object'&&(node.type==='LiquidTag'||node.type==='LiquidRawTag'||Object.entries(node).some(([k,v])=>!['source','_source'].includes(k)&&(Array.isArray(v)?v.some(control):control(v))));

// Compare the parsed source after removing only supported SEO mutation surfaces.
// Liquid control flow, executable raw tags, non-SEO attributes and body content remain.
function projection(node,parents=[],rules=new Set()) {
  if(!node||typeof node!=='object')return node;
  if(Array.isArray(node))return node.map(n=>projection(n,parents,rules)).filter(n=>n!==null);
  const tag=isHTML(node)?name(node):null;
  const title=tag==='title'&&(rules.has('Q-SEO-TITLE')||rules.has('Q-SEO-EMPTY-TITLE'));
  const metadata=title||tag==='meta'&&(attribute(node,'name')?.toLowerCase()==='description'&&(rules.has('Q-SEO-DESCRIPTION')||rules.has('Q-SEO-EMPTY-DESCRIPTION'))
    ||/^(og:|twitter:)/.test(attribute(node,'property')??attribute(node,'name')??'')&&rules.has('Q-SEO-SOCIAL'))
    ||tag==='link'&&attribute(node,'rel')?.toLowerCase().split(/\s+/).includes('canonical')&&(rules.has('Q-SEO-CANONICAL')||rules.has('Q-SEO-CANONICAL-VALUE'));
  const head=parents.findLastIndex(p=>isHTML(p)&&name(p)==='head');
  const unconditionalHead=head>=0&&parents.every(p=>p.type==='Document'||isHTML(p))&&parents.slice(head+1).length===0;
  const metadataOnly=(node.attributes??[]).every(a=>({title:[],meta:['name','property','content'],link:['rel','href']}[tag]??[]).includes(name(a)));
  if(metadata&&metadataOnly&&unconditionalHead&&!control(node))return null;
  const attributes=(node.attributes??[]).filter(a=>control(a)||!({img:rules.has('Q-ALT')?['alt']:[],a:rules.has('Q-CRAWL-LINK')?['href']:[],html:rules.has('Q-SEO-LANG')?['lang']:[],meta:metadata?['content']:[],link:metadata?['href']:[]}[tag]??[]).includes(name(a)));
  const copy={...node,...(node.attributes?{attributes}:{} )};
  // Existing conditional metadata may have its value repaired, but cannot be
  // inserted/moved across a branch or used to establish missing layout metadata.
  if(title&&!control(node))copy.children=[];
  if(tag==='script'&&attribute(node,'type')==='application/ld+json'&&!/\{[{%]/.test(node.body?.value??'')&&(rules.has('Q-JSONLD-JSON')||rules.has('Q-JSONLD-TYPE')))copy.body={type:'SEOJsonLD'};
  const out={};
  for(const [key,value]of Object.entries(copy)) {
    if(['source','_source','position'].includes(key)||key.endsWith('Position'))continue;
    if(key==='children')out[key]=value.filter(n=>!(n.type==='TextNode'&&!n.value.trim())).map(n=>projection(n,[...parents,node],rules)).filter(n=>n!==null);
    else if(key==='attributes')out[key]=value.map(a=>projection(a,[...parents,node],rules));
    else out[key]=projection(value,[...parents,node],rules);
  }
  return out;
}

export function protectSEOChange(before,after,rules) {
  const a=toLiquidHtmlAST(before,{mode:'strict'}),b=toLiquidHtmlAST(after,{mode:'strict'});
  if(canonical(projection(a,[],new Set(rules)))!==canonical(projection(b,[],new Set(rules))))throw new Error('SEO repair cannot change schema, executable code, storefront placeholder context, control flow, or non-SEO content/attributes.');
}
