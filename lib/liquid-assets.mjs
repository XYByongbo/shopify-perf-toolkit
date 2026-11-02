import { sha256 as hash } from './source-utils.mjs';
import {toLiquidAST} from '@shopify/liquid-html-parser';
import {parse} from 'acorn';

const fail=message=>{throw Object.assign(new Error(message),{code:'UNSUPPORTED_LIQUID_ASSET'});};
const shape=x=>JSON.stringify(x,(k,v)=>['start','end','loc','raw'].includes(k)?undefined:v);
const scalar=x=>x===null||['string','boolean'].includes(typeof x)||typeof x==='number'&&Number.isFinite(x);
const at=(node,path)=>path.reduce((n,k)=>n?.[k],node);
function walk(node,fn,path=[],parent=null,key=null) {
  if(!node||typeof node!=='object')return;
  if(node.type)fn(node,path,parent,key);
  for(const [k,v] of Object.entries(node)) {
    if(['start','end','loc'].includes(k))continue;
    if(Array.isArray(v))v.forEach((n,i)=>walk(n,fn,[...path,k,i],node,k));
    else if(v?.type)walk(v,fn,[...path,k],node,k);
  }
}
export function effectiveAssetSettings(files) {
  const read=name=>{const f=files.find(f=>f.file===name);return f?JSON.parse(f.text.replace(/^\s*\/\*[\s\S]*?\*\//,'')):null;};
  try {
    const schema=read('config/settings_schema.json'),data=read('config/settings_data.json'),values=Object.create(null);
    if(Array.isArray(schema))for(const section of schema)for(const s of section.settings??[])if(s.id&&Object.hasOwn(s,'default'))values[s.id]=s.default;
    const current=typeof data?.current==='string'?data.presets?.[data.current]:data?.current;
    if(current&&typeof current==='object'&&!Array.isArray(current))Object.assign(values,current);
    return {available:Boolean(schema||current),values,hash:hash(JSON.stringify(values)),files:files.filter(f=>['config/settings_schema.json','config/settings_data.json'].includes(f.file)).map(f=>({file:f.file,sourceHash:f.sourceHash??hash(f.text)}))};
  }catch{return {available:false,values:{},hash:null,files:[]};}
}

/** Scalar settings outputs in standalone assignment positions only. No arbitrary template execution. */
export function parseLiquidAsset(source) {
  if(typeof source!=='string'||Buffer.byteLength(source)>2*1024*1024)fail('Liquid JS asset exceeds the supported 2 MiB subset.');
  const liquid=toLiquidAST(source,{mode:'strict'}),slots=[];
  for(const n of liquid.children) {
    if(n.type==='TextNode')continue;
    const e=n.markup?.expression,f=n.markup?.filters;
    if(n.type!=='LiquidVariableOutput'||n.whitespaceStart||n.whitespaceEnd||e?.type!=='VariableLookup'||e.name!=='settings'||e.lookups?.length!==1
      ||e.lookupModes?.[0]!=='bareword'||e.lookups[0].type!=='String'||f?.length!==1||f[0].name!=='json'||f[0].args.length)fail('Only settings.key | json value slots without whitespace control are supported.');
    const id=`__perfkit_liquid_slot_${slots.length}__`;if(source.includes(id)||slots.length>=32)fail('Ambiguous or excessive Liquid value slots.');
    slots.push({id,key:e.lookups[0].value,start:n.position.start,end:n.position.end});
  }
  let javascript='',previous=0;
  for(const s of slots){javascript+=source.slice(previous,s.start);s.jsStart=javascript.length;javascript+=s.id;s.jsEnd=javascript.length;previous=s.end;}
  javascript+=source.slice(previous);
  const tokens=[],tree=parse(javascript,{ecmaVersion:'latest',sourceType:'module',onToken:tokens});
  for(const s of slots) {
    const matches=[];
    walk(tree,(n,path,parent,key)=>{if(n.type==='Identifier'&&n.name===s.id){
      if(!((parent?.type==='AssignmentExpression'&&parent.operator==='='&&key==='right')||(parent?.type==='VariableDeclarator'&&key==='init')))fail('Liquid output must be a standalone assignment value.');
      matches.push(path);
    }});
    if(matches.length!==1)fail('Liquid output is quoted, commented or is not an expression.');s.path=matches[0];
  }
  const sourceOffset=offset=>{
    let delta=0;for(const s of slots){if(offset>s.jsStart&&offset<s.jsEnd)return null;if(offset>=s.jsEnd)delta+=(s.end-s.start)-(s.jsEnd-s.jsStart);else if(offset===s.jsStart)return s.start;}
    return offset+delta;
  };
  const javascriptOffset=offset=>{
    let delta=0;for(const s of slots){if(offset>=s.start&&offset<s.end)return null;if(offset>=s.end)delta+=(s.jsEnd-s.jsStart)-(s.end-s.start);}
    return offset+delta;
  };
  return {source,javascript,tree,tokens:tokens.filter(t=>t.type.label!=='eof'),slots,sourceOffset,javascriptOffset};
}

export function associateLiquidAsset(response,unit,settings,{line=1,column=1}={}) {
  const responseHash=hash(response),key=(settings?.hash??'none')+':'+responseHash;
  unit.renderedCache??=new Map();
  const reject=()=>{if(unit.renderedCache.size>=256)unit.renderedCache.delete(unit.renderedCache.keys().next().value);unit.renderedCache.set(key,false);return null;};
  try {
    const model=unit.model;
    if(unit.sourceHash!==hash(unit.text)||model.source!==unit.text||model.slots.length&&(!settings?.available||settings.hash!==hash(JSON.stringify(settings.values))))return null;
    let prepared=unit.renderedCache.get(key);if(prepared===false)return null;
    if(!prepared) {
      const tokens=[],tree=parse(response,{ecmaVersion:'latest',sourceType:'module',onToken:tokens}),masked=structuredClone(tree),ranges=[];
      for(const slot of model.slots) {
        const n=at(tree,slot.path);if(!n||!Object.hasOwn(settings.values,slot.key))return reject();
        const value=JSON.parse(response.slice(n.start,n.end));
        if(!scalar(value)||!Object.is(value,settings.values[slot.key]))return reject();
        at(masked,slot.path.slice(0,-1))[slot.path.at(-1)]={type:'Identifier',name:slot.id};ranges.push({start:n.start,end:n.end,slot});
      }
      if(shape(masked)!==shape(model.tree))return reject();
      const staticRuntime=tokens.filter(t=>t.type.label!=='eof'&&!ranges.some(r=>t.start>=r.start&&t.end<=r.end));
      const staticSource=model.tokens.filter(t=>!model.slots.some(s=>t.start>=s.jsStart&&t.end<=s.jsEnd));
      if(staticSource.length!==staticRuntime.length)return reject();
      prepared={ranges,staticRuntime,staticSource};
      if([...unit.renderedCache.values()].filter(Boolean).length>=4)for(const [old,value] of unit.renderedCache)if(value){unit.renderedCache.delete(old);break;}
      unit.renderedCache.set(key,prepared);
    }
    const {ranges,staticRuntime,staticSource}=prepared;
    const lines=response.split('\n');if(!Number.isInteger(line)||line<1||line>lines.length||!Number.isInteger(column)||column<1||column>lines[line-1].length+1)return null;
    const offset=lines.slice(0,line-1).reduce((n,s)=>n+s.length+1,0)+column-1;
    const valueRange=ranges.find(r=>offset>=r.start&&offset<r.end);
    const index=staticRuntime.findIndex(t=>t.end>offset),token=staticSource[index];
    const sourceOffset=valueRange?valueRange.slot.start:token?model.sourceOffset(token.start):unit.text.length;
    if(sourceOffset===null)return null;
    return {status:'verified-ast',file:unit.file,sourceHash:unit.sourceHash,bodyHash:responseHash,offset:sourceOffset,
      line:unit.text.slice(0,sourceOffset).split('\n').length,column:sourceOffset-unit.text.lastIndexOf('\n',sourceOffset-1),
      scriptKind:'liquid-asset',runtimeLine:line,runtimeColumn:column,
      liquidProof:{kind:'scalar-settings-assignment-slots',settingsHash:settings?.hash??null,configFiles:settings?.files??[],templateHash:unit.sourceHash,responseHash,slots:ranges.map(r=>({key:r.slot.key,source:[r.slot.start,r.slot.end],response:[r.start,r.end]}))},
      reason:'Complete static JavaScript AST and bound scalar effective settings match; source tokens mapped across Liquid slots.'};
  }catch{return reject();}
}

export function restoreLiquidEdits(model,edits) {
  const translated=edits.map(e=>{
    if(model.slots.some(s=>e.start<s.jsEnd&&e.end>s.jsStart))fail('Generated edit overlaps a dynamic value slot.');
    const start=model.sourceOffset(e.start),end=model.sourceOffset(e.end);
    if(start===null||end===null||model.slots.some(s=>e.after.includes(s.id)))fail('Generated code cannot move or duplicate Liquid value slots.');
    return {start,end,before:model.source.slice(start,end),after:e.after};
  });
  let after=model.source;for(const e of [...translated].sort((a,b)=>b.start-a.start))after=after.slice(0,e.start)+e.after+after.slice(e.end);
  parseLiquidAsset(after);return {after,edits:translated};
}
