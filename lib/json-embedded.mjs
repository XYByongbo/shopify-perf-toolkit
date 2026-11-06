import {parseSchema} from './schema-json.mjs';
import {sha256,lineAt} from './source-utils.mjs';
import {maskNonRendering,tags,liquidTokens} from './core/html-source.mjs';
import {parse} from 'acorn';
import postcss from 'postcss';

export const pointerPart = key => String(key).replace(/~/g,'~0').replace(/\//g,'~1');
const settingsCode=/^(?:liquid|custom_liquid|html|custom_html|javascript|custom_javascript|css|custom_css)$/i;
const markup=/<(?:script|style|img|iframe|link|div|button|form)\b|\{[{%]/i;
/** Bounded, read-only extraction. Pointer and decoded line are not physical JSON source coordinates. */
export function extractJsonCode({file,source,sourceHash=sha256(source),limit=2000}) {
  const regions=[],issues=[];
  if (!/^(?:templates|sections)\/.*\.json$|^config\/settings_data\.json$/.test(file)) return {regions,issues};
  let data;try{data=parseSchema(source);}catch(error){return {regions,issues:[{file,line:null,stage:'json',reason:'parse-unavailable',detail:error.message}]};}
  let visited=0,stopped=false;
  const stop=reason=>{if(!stopped)issues.push({file,line:null,stage:'json-embedded',reason});stopped=true;};
  const visit=(value,pointer='',context={disabled:false,container:false},depth=0,inSettings=false,key='')=>{
    if(stopped)return;
    if(depth>80||++visited>100000){stop('traversal-limit');return;}
    if(typeof value==='string'){
      if(!(inSettings&&(settingsCode.test(key)||markup.test(value))||key==='custom_css'))return;
      if(regions.length>=limit){stop('region-limit');return;}
      const language=/^(?:custom_)?css$/i.test(key)?'css':/^(?:custom_)?javascript$/i.test(key)?'javascript':'liquid-html';
      regions.push({file,sourceHash,jsonPointer:pointer,language,code:value,decodedHash:sha256(value),
        configurationState:context.disabled?'disabled-ancestor':context.container?'enabled-in-config':'unknown',
        runtime:'unverified',mapping:'json-pointer',line:null});return;
    }
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){for(let i=0;i<value.length;i++)visit(value[i],`${pointer}/${i}`,context,depth+1,inSettings,key);return;}
    const container=typeof value.type==='string'&&value.settings&&typeof value.settings==='object';
    const next={disabled:context.disabled||!!container&&value.disabled===true,container:context.container||!!container};
    for(const [k,v]of Object.entries(value))visit(v,`${pointer}/${pointerPart(k)}`,next,depth+1,k==='settings'||inSettings,k);
  };
  visit(data);return {regions,issues};
}
function walk(node,visit){if(!node||typeof node!=='object')return;if(node.type)visit(node);for(const [key,value]of Object.entries(node)){if(key==='loc')continue;if(Array.isArray(value))for(const n of value)walk(n,visit);else if(value&&typeof value==='object')walk(value,visit);}}
/** Explicit subset of quality checks for decoded settings; unsupported dynamic regions remain visible. */
export function auditJsonCode(input) {
  const extracted=extractJsonCode(input),findings=[],observations=[],issues=[...extracted.issues],regions=[];
  for(const region of extracted.regions){
    const {code,...identity}=region,masked=region.language==='liquid-html'?maskNonRendering(code):code;
    const location=index=>({...identity,embeddedLine:lineAt(code,index)});
    const add=(index,ruleId,summary)=>findings.push({...location(index),ruleId,dimension:'performance',severity:'warning',status:'candidate',summary,
      evidence:{configurationState:region.configurationState,runtime:'unverified'},action:'先核对模板绑定、配置启用状态和实际页面，再决定是否修改。',
      verification:['JSON Pointer 定位到解码字段；不能将字段内行号用作 JSON 文件行号。','验证首屏位置、依赖顺序、业务行为与真实收益。']});
    const tokens=region.language==='liquid-html'?liquidTokens(masked):[];
    const business=tokens.filter(t=>/\ball_products\b|\bvariants\b|\bvariant\.id\b|\bbundle_variant\w*\b/.test(t.text));
    const scripts=region.language==='javascript'?[{body:code,bodyStart:0}]:region.language==='liquid-html'?tags(masked).filter(t=>!t.inert&&!t.svg&&t.name==='script'&&!t.attributes.src&&(!t.attributes.type||/^(?:module|text\/javascript|application\/javascript)$/i.test(t.attributes.type))):[];
    const styles=region.language==='css'?[{body:code,bodyStart:0}]:region.language==='liquid-html'?tags(masked).filter(t=>!t.inert&&!t.svg&&t.name==='style'):[];
    if(region.language==='liquid-html')for(const t of tags(masked)){
      if(t.dynamic||t.duplicate||t.inert||t.svg)continue;
      if(t.name==='img'&&!Object.hasOwn(t.attributes,'loading'))add(t.start,'Q-JSON-IMAGE-LOADING','JSON 内嵌 img 未声明 loading；需先确认首屏与屏外位置。');
      if(t.name==='script'&&t.attributes.src&&!Object.hasOwn(t.attributes,'async')&&!Object.hasOwn(t.attributes,'defer')&&(!t.attributes.type||/^(?:text\/javascript|application\/javascript)$/i.test(t.attributes.type)))add(t.start,'Q-JSON-BLOCKING-SCRIPT','JSON 内嵌外部脚本可能阻塞解析；需核对同步消费者与初始化顺序。');
    }
    const metrics={scripts:scripts.length,styles:styles.length,listeners:0,timers:0,dynamicImports:0,cartWriteCandidates:0};
    for(const part of scripts)try{
      if(/\{[{%]/.test(part.body)){issues.push({...location(part.bodyStart),stage:'javascript',reason:'embedded-liquid-requires-render'});continue;}
      const ast=parse(part.body,{ecmaVersion:'latest',sourceType:'module',allowReturnOutsideFunction:true});
      walk(ast,n=>{if(n.type==='ImportExpression')metrics.dynamicImports++;if(n.type==='CallExpression'){
        const name=n.callee?.property?.name??n.callee?.name;
        if(name==='addEventListener')metrics.listeners++;if(['setTimeout','setInterval'].includes(name))metrics.timers++;
        if(name==='fetch'&&n.arguments[0]?.type==='Literal'&&/\/cart\/(?:add|change|update|clear)(?:\.js)?(?:[?#]|$)/.test(String(n.arguments[0].value)))metrics.cartWriteCandidates++;
      }});
    }catch(error){issues.push({...location(part.bodyStart),stage:'javascript',reason:/\{[{%]/.test(part.body)?'embedded-liquid-requires-render':'parse-unavailable',detail:error.message});}
    for(const part of styles)try{
      if(/\{[{%]/.test(part.body)){issues.push({...location(part.bodyStart),stage:'css',reason:'embedded-liquid-requires-render'});continue;}
      postcss.parse(part.body);
    }catch(error){issues.push({...location(part.bodyStart),stage:'css',reason:'parse-unavailable',detail:error.reason??error.message});}
    regions.push({...identity,bytes:Buffer.byteLength(code),metrics,businessLogicCandidate:business.length>0||metrics.cartWriteCandidates>0});
    observations.push({...location(business[0]?.start??0),check:'json-embedded-code',status:'runtime-unverified',detail:business.length||metrics.cartWriteCandidates?'含商品/变体/购物车逻辑候选，需业务场景回归。':'配置代码已展开；存在不代表实际页面执行。'});
  }
  return {regions,findings,observations,issues};
}
