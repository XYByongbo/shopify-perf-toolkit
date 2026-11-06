import {scanInventory} from './core/source-scan.mjs';
import {readThemeSource} from './core/source-reader.mjs';
import {parseSchema} from './schema-json.mjs';
import {extractJsonCode,pointerPart} from './json-embedded.mjs';
import {sha256} from './source-utils.mjs';

function valueEvidence(value){const text=JSON.stringify(value);return {sha256:sha256(text),type:Array.isArray(value)?'array':value===null?'null':typeof value,characters:text.length,value:text.length<=2000?value:undefined,preview:text.length>2000?text.slice(0,2000):undefined,truncated:text.length>2000};}
function jsonChanges(before,after){
  const changes=[];let nodes=0;
  const visit=(a,b,pointer='',depth=0)=>{
    if(++nodes>100000||depth>80)throw new Error('JSON diff traversal limit.');
    if(a===b)return;
    const dict=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
    if(dict(a)&&dict(b)){
      for(const k of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()){
        const p=`${pointer}/${pointerPart(k)}`;
        if(!Object.hasOwn(a,k))changes.push({jsonPointer:p,change:'added',after:valueEvidence(b[k])});
        else if(!Object.hasOwn(b,k))changes.push({jsonPointer:p,change:'removed',before:valueEvidence(a[k])});
        else visit(a[k],b[k],p,depth+1);
      }
    }else if(JSON.stringify(a)!==JSON.stringify(b))changes.push({jsonPointer:pointer,change:'modified',before:valueEvidence(a),after:valueEvidence(b)});
    if(changes.length>10000)throw new Error('JSON diff exceeds 10000 field changes.');
  };
  visit(before,after);return changes;
}
const manifest=scan=>scan.inventory.files.map(f=>({file:f.path,sha256:f.sha256,bytes:f.rawBytes}));
const signature=scan=>JSON.stringify({files:manifest(scan),complete:scan.complete,errors:scan.errors,skipped:scan.skipped});
/** Compare local evidence snapshots only. No historical causality, deployment identity or performance acceptance is inferred. */
export async function compareThemes({before,after}={}) {
  const a=await scanInventory({project:before}),b=await scanInventory({project:after});
  if(!a.inventory.files.length||!b.inventory.files.length)throw new Error('Both inputs must contain theme files; empty directories are not verified snapshots.');
  const left=new Map(a.inventory.files.map(f=>[f.path,f])),right=new Map(b.inventory.files.map(f=>[f.path,f]));
  const changes=[],issues=[...a.errors,...a.skipped].map(x=>({side:'before',...x})).concat([...b.errors,...b.skipped].map(x=>({side:'after',...x})));
  let unchanged=0;
  for(const file of [...new Set([...left.keys(),...right.keys()])].sort()){
    const old=left.get(file),next=right.get(file);
    if(old&&next&&old.sha256&&old.sha256===next.sha256){unchanged++;continue;}
    const status=(old&&!old.sha256)||(next&&!next.sha256)?'unverified':!old?'added':!next?'deleted':'modified';
    const row={file,status,kind:(next??old).kind,beforeHash:old?.sha256??null,afterHash:next?.sha256??null,beforeBytes:old?.rawBytes??0,afterBytes:next?.rawBytes??0};
    if(row.kind==='json'&&status!=='unverified')try{
      const texts={};for(const [side,scan,entry]of [['before',a,old],['after',b,next]])if(entry)texts[side]=(await readThemeSource(scan.project,file,entry.sha256)).source;
      row.fields=jsonChanges(old?parseSchema(texts.before):{},next?parseSchema(texts.after):{});
      row.jsonOnlyFormatting=status==='modified'&&row.fields.length===0;
      row.embedded={};
      for(const side of ['before','after']){
        const decoded=texts[side]===undefined?{regions:[],issues:[]}:extractJsonCode({file,source:texts[side],sourceHash:row[`${side}Hash`]});
        issues.push(...decoded.issues.map(issue=>({side,...issue})));
        row.embedded[side]=decoded.regions.map(({code,...r})=>r);
      }
      const affected=new Set();
      const previous=new Map(row.embedded.before.map(r=>[r.jsonPointer,r]));
      const current=new Map(row.embedded.after.map(r=>[r.jsonPointer,r]));
      for(const [pointer,region]of [...previous,...current]){
        const oldRegion=previous.get(pointer),newRegion=current.get(pointer);
        if(!oldRegion||!newRegion||oldRegion.configurationState!==newRegion.configurationState
          ||row.fields.some(f=>pointer===f.jsonPointer||pointer.startsWith(f.jsonPointer+'/')||f.jsonPointer.startsWith(pointer+'/')))affected.add(region.jsonPointer);
      }
      for(const side of ['before','after'])row.embedded[side]=row.embedded[side].filter(r=>affected.has(r.jsonPointer));
    }catch(error){issues.push({file,stage:'json-diff',reason:error.message});row.jsonStatus='unparsed';}
    changes.push(row);
  }
  for(const [side,original]of [['before',a],['after',b]])if(signature(await scanInventory({project:original.project}))!==signature(original))throw new Error(`Theme source changed during comparison: ${side}.`);
  const evidence={before:{project:a.project,files:manifest(a)},after:{project:b.project,files:manifest(b)}};
  for(const side of ['before','after'])evidence[side].hash=sha256(JSON.stringify(evidence[side].files));
  return {schemaVersion:1,kind:'theme-diff',scope:'local-theme-inventory',complete:a.complete&&b.complete&&issues.length===0,changes,issues,evidence,
    summary:{beforeFiles:left.size,afterFiles:right.size,unchanged,added:changes.filter(x=>x.status==='added').length,modified:changes.filter(x=>x.status==='modified').length,deleted:changes.filter(x=>x.status==='deleted').length,unverified:changes.filter(x=>x.status==='unverified').length,
      byteDelta:b.inventory.rawBytes-a.inventory.rawBytes,jsonFields:changes.reduce((n,x)=>n+(x.fields?.length??0),0),embeddedChangedFiles:changes.filter(x=>x.embedded?.before.length||x.embedded?.after.length).length},
    deployment:'unverified',performance:'not-measured',
    limitations:['输入为本地快照，须另行绑定店铺、主题、抓取时间与上传记录；文件一致不能证明历史上从未整改。',
      'JSON 数组作为整体比较；大值保留哈希与明确截断的预览，原始值在输入快照中。字段顺序/格式不计语义变化。',
      '配置中的启用/禁用不等于实际页面执行；模板绑定、App、菜单实体和本地 CI 配置不在主题快照范围。',
      '字节变化、告警消失、隐藏内容和规则豁免均不证明性能收益。需原正式采样与功能/视觉验收。']};
}
