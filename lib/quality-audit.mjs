import {auditJsonCode} from './json-embedded.mjs';
import {inspectSEOFile,inspectSEOLayouts} from './seo/source-rules.mjs';
import {parseSchema} from './schema-json.mjs';
import {sourceOwnership,structureDependencies,waiverCoverage} from './theme-governance.mjs';
import { sha256 as sha, lineAt } from './source-utils.mjs';
import {scanTheme} from './scan.mjs';
import {createSourceAnalysis, readAnalyzedThemeSource} from './core/source-analysis.mjs';
import {fingerprintThemeInventory} from './core/source-scan.mjs';
import {createSourceSyntaxCache} from './source-syntax-cache.mjs';
import {sourceSnapshot} from './theme-source.mjs';
import {isCurrentProjectThemeCheck} from './theme-check-project.mjs';
import {maskNonRendering,inspectImages,tags,liquidTokens} from './core/html-source.mjs';
import {referenceRules,dimensions,dimensionFor,officialSources} from './quality-catalog.mjs';

const blank=s=>s.replace(/[^\r\n]/g,' ');
function walk(node,visit){if(!node||typeof node!=='object')return; if(node.type)visit(node);for(const [k,v]of Object.entries(node)){if(k==='loc')continue;if(Array.isArray(v))for(const x of v)walk(x,visit);else if(v&&typeof v==='object')walk(v,visit);}}
function staticName(n){return n?.type==='Identifier'?n.name:n?.type==='Literal'?n.value:null;}
export async function auditQuality({project,scan:provided,checks=null,analysis=createSourceAnalysis(),syntax=createSourceSyntaxCache()}={}){
 const scan=provided??await scanTheme({project,analysis,syntax});
 if(checks&&(checks.kind!=='check-import'||checks.project!==scan.project))throw new Error('quality checks must match the scanned project');
 const files=new Map(scan.inventory.files.map(f=>[f.path,f]));const sources=new Map(),findings=[],observations=[],issues=[],schemas=[],metrics={css:[],javascript:[],templates:[],schema:[],largeAssets:[]},embedded=[];
 const add=(file,index,ruleId,dimension,summary,evidence={},action=null,verification=null)=>{const s=sources.get(file);findings.push({ruleId,dimension,file,line:lineAt(s,index),sourceHash:files.get(file).sha256,severity:dimension==='style'?'style':'warning',status:'candidate',summary,evidence,action:action??dimensions.find(d=>d.id===dimension).action,verification:[verification??dimensions.find(d=>d.id===dimension).verification]});};
 const observe=(file,index,check,status,detail)=>observations.push({file,line:lineAt(sources.get(file),index),sourceHash:files.get(file).sha256,check,status,detail});
 for(const f of files.values()){
  if(!['liquid','javascript','css','json'].includes(f.kind)||f.rawBytes>5*1024*1024)continue;
  sources.set(f.path,await readAnalyzedThemeSource(scan.project,f.path,f.sha256,analysis));
 }
 for(const [file,source]of sources){
  const kind=files.get(file).kind;const masked=kind==='liquid'?maskNonRendering(source):source;
  if(kind==='json'){const decoded=auditJsonCode({file,source,sourceHash:files.get(file).sha256});embedded.push(...decoded.regions);findings.push(...decoded.findings);observations.push(...decoded.observations);issues.push(...decoded.issues);}
  if(['javascript','css'].includes(kind)&&files.get(file).rawBytes>=100*1024)metrics.largeAssets.push({file,bytes:files.get(file).rawBytes});
  if(kind==='liquid'){
   const tokens=liquidTokens(masked);let logic=0,braces=0,firstBrace=0;
   for(const t of tokens){
    if(/^\{%-?\s*(assign|capture|if|unless|for)\b/.test(t.text))logic++;
    if(/^\{%-?\s*include\b/.test(t.text))add(file,t.start,'Q-INCLUDE','variables','使用 include 共享上下文；迁移 render 前核对作用域和参数。');
    if(/^\{\{/.test(t.text)&&(/^(?:\{\{-?)[^\s-]/.test(t.text)||/[^\s-]-?\}\}$/.test(t.text))){if(!braces)firstBrace=t.start;braces++;}
    if(/(['"])(?:https?:)?\/\/[^'"\n]+\1\s*\|\s*asset_url\b/.test(t.text))add(file,t.start,'Q-ASSET-URL','references','asset_url 输入包含 URL，需确认是否应为主题资产文件名。');
   }
   if(braces)add(file,firstBrace,'Q-BRACES','style',`${braces} 个输出标签不符合本工具空格约定。`,{occurrences:braces,policy:'output delimiter padding only; not Ruby rule parity'});
   let run=[],longest=[];for(const t of tokens){if(/^\{%-?\s*assign\b/.test(t.text)){if(run.length&&masked.slice(run.at(-1).end,t.start).trim())run=[];run.push(t);if(run.length>longest.length)longest=[...run];}else run=[];}
   if(longest.length>=3)add(file,longest[0].start,'Q-LIQUID-TAGS','style',`存在连续 ${longest.length} 个 assign 标签，可评审合并为 liquid 块。`,{occurrences:longest.length,policy:'longest whitespace-separated assign run; no auto-merge'});
   const lines=source.split('\n').length;metrics.templates.push({file,lines,bytes:files.get(file).rawBytes});
   if(lines>600)add(file,0,'Q-LONG-TEMPLATE','architecture',`模板 ${lines} 行，超过本工具 600 行维护性阈值。`,{lines,threshold:600});
   for(const img of inspectImages(source)){
    if(!img.mappingSafe)continue;
    if(!Object.hasOwn(img.attributes,'loading'))add(file,img.start,'Q-IMAGE-LOADING','performance','原生 img 未声明 loading；首屏/LCP 与屏外图片需分别判定。');
   }
   const tt=tags(masked);
   inspectSEOFile({file,source,add,observe});
   for(const t of tt){const a=t.attributes;if(t.dynamic||t.duplicate)continue;
    if(t.name==='meta'&&a.name?.toLowerCase()==='viewport'&&/maximum-scale\s*=\s*1(?:\D|$)|user-scalable\s*=\s*no/i.test(a.content??''))add(file,t.start,'Q-ZOOM','a11y','视口限制缩放，需验证移动端可访问性。');
    if(t.name==='button'&&!a['aria-label']&&!a['aria-labelledby']){const body=masked.slice(t.end,masked.indexOf('</button',t.end)>0?masked.indexOf('</button',t.end):t.end);if(!body.trim())add(file,t.start,'Q-BUTTON-NAME','a11y','空按钮且未声明 aria-label/labelledby；检查运行时可访问名称。');}
    if(a.role==='dialog'&&!a['aria-label']&&!a['aria-labelledby'])add(file,t.start,'Q-DIALOG-NAME','a11y','dialog 未声明名称关联；需确认浏览器实际可访问名称。');
    for(const key of ['src','href','poster'])if(/^http:\/\//i.test(a[key]??'')&&!(t.name==='a'&&key==='href'))add(file,t.start,'Q-HTTP','boundaries',`资源 ${key} 使用 HTTP；HTTPS 页面需检查自动升级或拦截。`,{url:a[key]});
   }
   // Schema is excluded by maskNonRendering; locate it after removing comments/raw only.
   const schemaSource=source.replace(/\{%-?\s*(comment|raw)\b[\s\S]*?\{%-?\s*end\1\s*-?%\}/g,blank).replace(/<!--[\s\S]*?-->/g,blank);
   for(const m of schemaSource.matchAll(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/g))try{
    const schema=parseSchema(m[1]);const settings=[...(schema.settings??[]),...(schema.blocks??[]).flatMap(b=>b.settings??[])];
    metrics.schema.push({file,line:lineAt(source,m.index),settings:settings.length,blocks:(schema.blocks??[]).length});
    const shape=settings.filter(x=>x.id).map(x=>({id:x.id,type:x.type}));if(shape.length>=5)schemas.push({file,index:m.index,hash:sha(JSON.stringify(shape)),settings:shape.length});
    if(dedent(m[1])!==JSON.stringify(schema,null,2))add(file,m.index,'Q-SCHEMA-FORMAT','style','Schema JSON 与两空格格式约定不同；不属于 JSON 语法错误。',{policy:'JSON.stringify two-space formatting; no automatic rewrite'});
   }catch{add(file,m.index,'Q-SCHEMA-JSON','syntax','Schema 区块无法作为标准 JSON 解析；与 Theme Check 结果交叉复核。');}
  }
  const jsParts=kind==='javascript'?[{body:source,bodyStart:0}]:kind==='liquid'?tags(masked).filter(t=>t.name==='script'&&!t.attributes.src&&(!t.attributes.type||/^(module|text\/javascript|application\/javascript)$/.test(t.attributes.type))):[];
  for(const part of jsParts){
   try{
    const ast=syntax.javascript(part.body,{allowReturnOutsideFunction:true});
    const classNames=new Map(),classes=new Map();walk(ast,n=>{if(n.type==='VariableDeclarator'&&n.init?.type==='ClassExpression'){classNames.set(n.init,n.id.name);classes.set(n.id.name,n.init);}if(n.type==='ClassDeclaration'&&n.id)classes.set(n.id.name,n);});
    const inheritedCleanup=(n,seen=new Set())=>{const name=staticName(n.superClass);if(!name||seen.has(name)||!classes.has(name))return false;seen.add(name);const base=classes.get(name);return base.body.body.some(m=>staticName(m.key)==='disconnectedCallback')||inheritedCleanup(base,seen);};
    let listeners=0,observers=0,timers=0,dynamicImports=0;
    walk(ast,n=>{if(n.type==='ImportExpression')dynamicImports++;if(n.type==='CallExpression'){const name=staticName(n.callee?.property)??staticName(n.callee);if(name==='addEventListener')listeners++;if(['setInterval','setTimeout'].includes(name))timers++;}if(n.type==='NewExpression'&&/^(Resize|Intersection|Mutation)Observer$/.test(staticName(n.callee)))observers++;
     if(n.type==='ClassDeclaration'||n.type==='ClassExpression'){
      const methods=n.body.body,connected=methods.find(x=>staticName(x.key)==='connectedCallback'),disconnected=methods.find(x=>staticName(x.key)==='disconnectedCallback');
      if(connected&&!disconnected&&!inheritedCleanup(n)){let alloc=0;walk(connected,x=>{if(x.type==='CallExpression'&&['addEventListener','observe','setInterval','setTimeout'].includes(staticName(x.callee?.property)??staticName(x.callee)))alloc++;});if(alloc)add(file,part.bodyStart+n.start,'Q-JS-LIFECYCLE','performance',`${n.id?.name??classNames.get(n)??'匿名类'} 在 connectedCallback 注册资源，未声明本类 disconnectedCallback。`,{registrations:alloc,baseClass:part.body.slice(n.superClass?.start??0,n.superClass?.end??0),caveat:'base class, AbortSignal or helper may own cleanup; candidate only'},'追踪资源所有权、父类及 AbortSignal；确认泄漏后再补释放。','重复装载、卸载和重连；比较监听器、observer 与计时器数量。');}
     }
    });metrics.javascript.push({file,line:lineAt(source,part.bodyStart),listeners,observers,timers,dynamicImports});
   }catch(e){issues.push({file,line:lineAt(source,part.bodyStart),stage:'javascript',reason:/\{[{%]/.test(part.body)?'embedded-liquid-requires-render':'parse-unavailable',detail:e.message});}
  }
  const cssParts=kind==='css'?[{body:source,bodyStart:0}]:kind==='liquid'?tags(masked).filter(t=>t.name==='style'):[];
  for(const part of cssParts){if(/\{[{%]/.test(part.body)){issues.push({file,line:lineAt(source,part.bodyStart),stage:'css',reason:'embedded-liquid-requires-render'});continue;}
   try{const ast=syntax.css(part.body),seen=new Map();let rules=0,duplicates=0,global=0;ast.walkRules(r=>{rules++;if(r.selector.split(',').some(s=>/^(?:\*|body|html|h[1-6]|p|a|button|img)$/.test(s.trim())))global++;const parent=[];for(let p=r.parent;p?.type!=='root'&&p;p=p.parent)parent.push(p.name+':'+p.params);const key=JSON.stringify([parent,r.selector,r.nodes.filter(n=>n.type==='decl').map(n=>[n.prop,n.value,n.important])]);if(seen.has(key))duplicates++;else seen.set(key,r);});
    ast.walkAtRules('font-face',r=>{if(!r.nodes.some(d=>d.type==='decl'&&d.prop==='font-display'))add(file,part.bodyStart+(r.source.start.offset??0),'Q-FONT-DISPLAY','performance','@font-face 未显式声明 font-display；需检查文本首绘策略。');});
    metrics.css.push({file,line:lineAt(source,part.bodyStart),rules,duplicates,global});if(duplicates)add(file,part.bodyStart,'Q-CSS-DUPLICATE','architecture',`CSS 中发现 ${duplicates} 个相同父条件、选择器和声明的重复规则候选。`,{duplicates},'核对层叠顺序和中间覆盖后再合并，不直接删除重复选择器。');
    if(file.startsWith('sections/')&&global)add(file,part.bodyStart,'Q-CSS-SCOPE','boundaries',`section 样式包含 ${global} 个全局元素选择器，需核对跨组件影响。`,{global});
   }catch(e){issues.push({file,line:lineAt(source,part.bodyStart),stage:'css',reason:'parse-unavailable',detail:e.reason});}
  }
 }
 // Static graph paths, not runtime calls. One representative bounded path per source.
 const edges=scan.dependencies.filter(e=>e.status==='resolved'&&['liquid-render','liquid-include'].includes(e.type));
 for(const file of new Set(edges.map(e=>e.from))){const queue=[[file]],seen=new Set([file]);let path=null;for(let i=0;i<queue.length&&i<1000;i++){const route=queue[i];if(route.length>=4){path=route;break;}for(const e of edges.filter(e=>e.from===route.at(-1)))if(!seen.has(e.to)){seen.add(e.to);queue.push([...route,e.to]);}}if(path)add(file,0,'Q-NESTED','architecture','存在至少三级静态 snippet 调用链。',{path,scope:'literal render/include; branches not evaluated'});}
 for(const edge of scan.dependencies.filter(e=>e.status==='missing'&&['liquid-render','liquid-include','asset-url'].includes(e.type)))if(sources.has(edge.from))add(edge.from,offsetForLine(sources.get(edge.from),edge.references[0]?.line??1),'Q-MISSING-REFERENCE','references',`字面引用未找到本地文件：${edge.to}`,{edge});
 for(const group of Map.groupBy(schemas,s=>s.hash).values())if(group.length>1)for(const s of group)add(s.file,s.index,'Q-SCHEMA-DUPLICATE','architecture',`${group.length} 个文件含相同的 setting ID/type 序列，评审配置复制成本。`,{files:group.map(x=>x.file),settings:s.settings,caveat:'matching interface may be intentional; values/labels not compared'});
 // SEO presence is traced through literal snippets, not inferred from a global string search.
 inspectSEOLayouts({sources,edges,add,observe});
 const layouts=[...sources.keys()].filter(f=>/^layout\/.*\.liquid$/.test(f));
 for(const file of layouts){
  for(const e of scan.dependencies.filter(e=>e.from===file&&e.to&&/\.(js|css)$/.test(e.to)&&e.type==='asset-url'))if(files.has(e.to)){observe(file,offsetForLine(sources.get(file),e.references[0]?.line??1),'layout-resource','render-required',`${e.to}，原始 ${files.get(e.to).rawBytes} bytes；布局引用可能只是 importmap/预加载，需核对实际请求。`);}
 }
 const enabled=checks?.metadata?.rulesConfig?.effectiveConfiguration??'';
 const scanned=checks?.metadata?.scannedFiles??[];
 const checkerCurrent=!!checks?.complete&&scanned.length>0&&scanned.every(f=>files.get(f)?.sha256===checks.metadata.sourceHashes?.[f])&&[...sources.keys()].every(f=>scanned.includes(f))&&checks.findings.every(f=>f.sourceBinding==='hash-matched'&&files.get(f.file)?.sha256===f.sourceHash)
   && (checks.metadata?.scope !== 'project-theme-check-v1' || await isCurrentProjectThemeCheck(await sourceSnapshot(scan.project), checks));
 const coverage=referenceRules.map(([reference,rules,dimension])=>({reference,rules,dimension,status:rules.every(r=>r.startsWith('Q-'))?'local-static':!checkerCurrent?'checker-not-current':rules.every(r=>new RegExp('(?:^|\\n)'+r+':\\s*\\n\\s+enabled: true').test(enabled))?'checker-enabled':'checker-config-unverified',note:rules.some(r=>r.startsWith('Q-'))?'工具自有启发式，范围/阈值与旧 Ruby 规则不保证等价。':'依赖真实 Theme Check、有效规则配置与完整扫描元数据。'}));
 const checkerCorrections=(checks?.findings??[]).flatMap(f=>{if(f.ruleId!=='MissingAsset'||!checkerCurrent)return [];const e=scan.dependencies.find(e=>e.resolution==='shopify-liquid-asset'&&e.from===f.file&&e.references.some(r=>r.line===f.line)&&f.summary.includes(e.requestedTo));return e?[{file:f.file,line:f.line,ruleId:f.ruleId,summary:f.summary,status:'false-positive-candidate',reason:`字面资产地址已有 Liquid 源文件 ${e.to}；保留原告警，需验证实际 CDN 输出后确认误报。`,source:'https://shopify.dev/docs/storefronts/themes/architecture#assets',sourceFile:e.to,sourceHash:files.get(e.to).sha256,automaticSuppression:false}]:[];});
 const end=await fingerprintThemeInventory(scan.project);
 if(JSON.stringify(end)!==JSON.stringify(scan.inventory.files.map(f=>[f.path,f.sha256])))throw new Error('Source changed during quality audit');
 return {schemaVersion:1,kind:'quality-audit',project:scan.project,complete:scan.complete&&issues.length===0,sourceScanComplete:scan.complete,checkerCorrections,findings,observations,metrics,coverage,issues,officialSources,
    intelligence:{embedded,ownership:sourceOwnership([...sources].map(([file,text])=>({file,text,sourceHash:files.get(file).sha256})),scan.dependencies),
      structure:structureDependencies([...sources].map(([file,text])=>({file,text,sourceHash:files.get(file).sha256})),scan.dependencies),waivers:{...waiverCoverage(checks),sourceStatus:checkerCurrent?'current-source':checks?'stale-or-incomplete-checker-report':'not-supplied'}},
  summary:{embeddedRegions:embedded.length,files:files.size,findings:findings.length,observations:observations.length,unparsedRegions:issues.length,referenceGroups:coverage.length,checkerCurrent},
  manualChecks:[
   {area:'SEO 运行结果',status:'not-run',required:'最终 HTML 的 title/description/canonical 唯一性与值、HTTP 状态/X-Robots-Tag、robots.txt/sitemap、hreflang 互返、JSON-LD Rich Results。Shopify 默认 robots/sitemap 不要求源码存在。'},
   {area:'页面性能',status:'not-run',required:'真实部署身份、LCP/CLS/TBT、网络阻塞、CPU 开销与前后五样本验收。'},
   {area:'安全、业务与可访问性',status:'not-run',required:'第三方信任、混淆代码、空数据兜底、键盘/焦点、App 注入、错误降级、主题编辑器动态状态。'},
   {area:'工程流程',status:'not-run',required:'CI 门禁、评审、来源声明、配置备份和恢复演练属于项目流程证据，不能由主题文件缺失反推不存在。'},
  ]};
}
function dedent(s){const lines=s.split('\n');while(lines.length&&!lines[0].trim())lines.shift();while(lines.length&&!lines.at(-1).trim())lines.pop();const indent=Math.min(...lines.filter(x=>x.trim()).map(x=>x.match(/^\s*/)[0].length));return lines.map(x=>x.slice(indent)).join('\n');}

function offsetForLine(source,line){let offset=0;for(let i=1;i<line;i++){const n=source.indexOf('\n',offset);if(n<0)return 0;offset=n+1;}return offset;}
export function buildAnalysis(findings,quality){return dimensions.map(d=>{const group=findings.filter(f=>dimensionFor(f)===d.id),current=group.filter(f=>f.sourceBinding==='hash-matched');const byRule={};for(const f of group)byRule[f.ruleId]=(byRule[f.ruleId]??0)+1;return {...d,count:group.length,current:current.length,files:new Set(group.map(f=>f.file)).size,byRule,examples:current.sort((a,b)=>(a.origin==='review'?-1:0)-(b.origin==='review'?-1:0)).slice(0,3).map(f=>f.id),observationCount:quality.observations.filter(o=>d.id==='seo'&&['title','description','canonical','lang','structured-data','robots','h1','social','hreflang'].includes(o.check)).length};});}
