import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {officialMethodCatalog,officialOptions} from '../lib/official-methods.mjs';
import {readShopifySources,syncShopifyDocs,performanceRoot,referenceSources,officialUrl,describeDocument} from '../lib/shopify-docs.mjs';
import {createOfficialPlan} from '../lib/official-plan.mjs';
import {sourceSnapshot,sha256} from '../lib/runtime-profile.mjs';
import {applySitePlan,rollbackSitePlan} from '../lib/site-changes.mjs';
import {transformCode} from '../lib/code-strategies.mjs';
import {diagnoseBottlenecks} from '../lib/bottlenecks.mjs';
const root=async t=>{const p=await mkdtemp('/private/tmp/perfkit-official-');t.after(()=>rm(p,{recursive:true,force:true}));return p;};
const md=links=>'---\ntitle: Fixture\n---\n# Fixture\n## Guidance\n'+links;
const response=text=>new Response(text,{headers:{'content-type':'text/markdown'}});

test('all discovered performance articles have reviewed cards and real executor contracts',async()=>{
  const sources=await readShopifySources(),catalog=officialMethodCatalog();
  assert.equal(catalog.status,'current');assert.equal(catalog.coverage.performanceArticles,70);
  assert.equal(catalog.methods.length,70);assert.deepEqual(catalog.coverage.uncovered,[]);
  const discovered=sources.documents.find(d=>d.url===performanceRoot).links.filter(x=>x.startsWith(performanceRoot+'/'));
  assert.deepEqual(new Set(discovered),new Set(catalog.methods.map(m=>m.source.url)));
  for(const m of catalog.methods)for(const e of m.executors){assert.ok(e.boundary);assert.ok(e.parameters);assert.ok(e.evidenceRequired.includes('sourceHash'));}
  for(const id of ['self-host-web-fonts','stylesheet-subsetting'])assert.equal(catalog.methods.find(m=>m.id===id).executors.length,0);
  assert.ok(catalog.methods.find(m=>m.id==='reduce-stylesheet-count').executors.some(e=>e.id==='domain:stylesheet-once'));
  assert.equal(catalog.methods.find(m=>m.id==='finding-worst-offenders').status,'measurement-workflow');
  assert.equal(catalog.methods.find(m=>m.id==='avoid-request-proxies').status,'platform-workflow');
  const ssr=catalog.methods.find(m=>m.id==='render-essential-content-server-side');
  assert.equal(ssr.executors[0].id,'domain:section-liquid-initial');
  assert.deepEqual(ssr.executors[0].parameters,['sectionSelector','initialLiquid']);
});

test('changed, missing and newly discovered official pages remain review-required',async()=>{
  const s=await readShopifySources();s.documents.find(d=>d.url.endsWith('/never-lazy-load-lcp-image')).contentHash='changed';
  s.documents=s.documents.filter(d=>!d.url.endsWith('/use-responsive-images'));
  s.documents.push({url:performanceRoot+'/new-method',contentHash:'new'});
  const c=officialMethodCatalog({sources:s});assert.equal(c.status,'review-required');assert.equal(c.coverage.sourceReviewRequired,2);
  assert.deepEqual(c.coverage.uncovered,[performanceRoot+'/new-method']);
});

test('foundational render/paginate reference drift blocks affected generators even when the performance article is unchanged',async()=>{
  const sources=await readShopifySources();sources.documents.find(d=>d.url==='https://shopify.dev/docs/api/liquid/tags/render').contentHash='changed';
  const catalog=officialMethodCatalog({sources});
  for(const id of ['avoid-nested-renders','reduce-stylesheet-count','limit-product-queries-with-pagination']){
    const method=catalog.methods.find(m=>m.id===id);assert.equal(method.status,'source-review-required');assert.ok(method.referenceDependencies.some(d=>d.status==='changed-needs-review'));
  }
  assert.equal(catalog.methods.find(m=>m.id==='never-lazy-load-lcp-image').source.status,'reviewed');
});

test('bounded refresh discovers topics, deduplicates links and saves metadata without full text',async t=>{
  const out=path.join(await root(t),'docs'),calls=[];
  const result=await syncShopifyDocs({output:out,dependencies:{fetch:async url=>{calls.push(url);return response(md(url===performanceRoot+'.md'?`[one](${performanceRoot}/one) [same](${performanceRoot}/one#more) [foreign](https://evil.test/docs/x)`:''));}}});
  assert.equal(result.status,'complete');assert.equal(result.documents.length,referenceSources.length+2);
  assert.equal(calls.filter(x=>x===performanceRoot+'/one.md').length,1);assert.ok(calls.every(x=>x.startsWith('https://shopify.dev/docs/')));
  assert.ok(result.documents.every(d=>/^[a-f0-9]{64}$/.test(d.contentHash)&&!d.text));
  assert.deepEqual(JSON.parse(await readFile(path.join(out,'sources.json'),'utf8')),result);
});

for(const mode of ['truncated','root-failed'])test(`incomplete refresh never invents source deletions: ${mode}`,async t=>{
  const result=await syncShopifyDocs({output:path.join(await root(t),'docs'),config:mode==='truncated'?{maxPages:1}:{},dependencies:{fetch:async url=>url===performanceRoot+'.md'&&mode==='root-failed'?new Response('bad',{status:503}):response(md(''))}});
  assert.equal(result.status,'incomplete');assert.deepEqual(result.removedSincePrevious,[]);assert.ok(result.notRediscovered.length>0);
});
for(const mode of ['html','foreign-redirect','oversized','no-document'])test(`refresh rejects invalid response: ${mode}`,async t=>{
  const result=await syncShopifyDocs({output:path.join(await root(t),'docs'),config:{maxPages:1},dependencies:{fetch:async()=>mode==='html'?new Response('<html>login</html>',{headers:{'content-type':'text/html'}}):mode==='foreign-redirect'?new Response(null,{status:302,headers:{location:'https://evil.test/docs/page'}}):response(mode==='oversized'?md('x'.repeat(512*1024)):'# incomplete')}});
  assert.equal(result.failures.length,1);assert.equal(result.documents.length,0);assert.equal(result.status,'incomplete');
});
test('canonical docs URL and Markdown with literal HTML examples',()=>{
  assert.equal(officialUrl(performanceRoot+'.md#example'),performanceRoot);
  for(const url of ['http://shopify.dev/docs/a','https://shopify.dev.evil.test/docs/a','https://shopify.dev/docs/a?token=1','https://shopify.dev/products'])assert.throws(()=>officialUrl(url));
  assert.ok(describeDocument(md('```html\n<html>\n```'),performanceRoot).contentHash);
});

async function theme(t,files,target='assets/main.js',kind='cpu') {
  const p=await root(t);for(const [file,text] of Object.entries(files)){await mkdir(path.dirname(path.join(p,file)),{recursive:true});await writeFile(path.join(p,file),text);}
  const snapshot=await sourceSnapshot(p),c={candidateId:'synthetic',kind,metric:kind==='cpu'?'tbt':'lcp',eligible:true,file:target,page:'https://shop.example.test/',device:'mobile',source:{status:'verified-bytes',...snapshot.files.find(f=>f.file===target)}};
  return {project:p,snapshot,c,diagnosis:{kind:'bottleneck-diagnosis',sourceHash:snapshot.hash,candidates:[c]}};
}
const cfg=(f,methodId,executor,parameters,review={})=>({schemaVersion:1,candidateId:f.c.candidateId,methodId,executor,parameters,review:{sourceHash:f.c.source.sourceHash,summary:'Synthetic mechanism test, not store performance',...review}});

test('official site route creates reversible code and pins source provenance',async t=>{
  const text='function init(){ window.fixture=1; }\ninit();',f=await theme(t,{'assets/main.js':text});
  const config=cfg(f,'defer-non-critical-resources','site:js-idle-init',{statementStart:text.indexOf('\ninit();')+1,timeoutMs:200},{nonCritical:true,noFirstInteractionDependency:true,timingChangeReviewed:true});
  const p=await createOfficialPlan({...f,config});
  const out=await root(t);await writeFile(path.join(out,'config.json'),JSON.stringify(config));await writeFile(path.join(out,'diagnosis.json'),JSON.stringify(f.diagnosis));
  const cli=spawnSync(process.execPath,['scripts/perfkit.mjs','plan-official','--project',f.project,'--config',path.join(out,'config.json'),'--diagnosis',path.join(out,'diagnosis.json'),'--out',path.join(out,'plan.json')],{encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(await readFile(path.join(out,'plan.json'),'utf8')).changes[0].after,p.changes[0].after);
  assert.match(p.changes[0].after,/requestIdleCallback/);assert.match(p.metadata.officialMethod.contentHash,/^[a-f0-9]{64}$/);
  await applySitePlan(p,f.project);await rollbackSitePlan(p,f.project);assert.equal(await readFile(path.join(f.project,'assets/main.js'),'utf8'),text);
  const sources=await readShopifySources();sources.documents.find(d=>d.url.endsWith('/defer-non-critical-resources')).contentHash='new';
  await assert.rejects(createOfficialPlan({...f,config,sources}),{code:'OFFICIAL_SOURCE_REVIEW_REQUIRED'});
  await assert.rejects(createOfficialPlan({...f,config:{...config,review:{...config.review,sourceHash:'bad'}}}),{code:'MISSING_CODE_EVIDENCE'});
  await assert.rejects(createOfficialPlan({...f,config:{...config,executor:'reviewed-replacement',replacementText:'// bypass',review:{...config.review,allStatesReviewed:true}}}),/escape route/);
});

test('official CSS split preserves provenance on every file and rolls back new assets',async t=>{
  const css='.hero { color: red; }\n.footer { color: blue; }',loader='<head>\n{{ content_for_header }}\n<link rel="stylesheet" href="{{ \'main.css\' | asset_url }}">\n</head>';
  const f=await theme(t,{'assets/main.css':css,'layout/theme.liquid':loader},'assets/main.css','render-resource');
  const config=cfg(f,'load-critical-css-synchronously','split:css',{source:'assets/main.css',newAsset:'assets/deferred.css',loaderTarget:'layout/theme.liquid',tagStart:loader.indexOf('<link'),criticalRuleStarts:[0]},
    {loaderHash:sha256(loader),dependencyReview:true,allStatesCovered:true,cascadeAndOrderReviewed:true,inlineLoadHandlerAllowed:true});
  const p=await createOfficialPlan({...f,config});assert.ok(p.changes.length>=3);assert.ok(p.changes.every(c=>c.evidence.officialMethod.id===config.methodId&&c.evidence.candidateId===f.c.candidateId));
  await applySitePlan(p,f.project);assert.match(await readFile(path.join(f.project,'layout/theme.liquid'),'utf8'),/<noscript>/);
  await rollbackSitePlan(p,f.project);await assert.rejects(readFile(path.join(f.project,'assets/deferred.css')),{code:'ENOENT'});
});

test('font fallback generator actually connects measured face to chosen font stack',async t=>{
  const css='.heading { font-family: "WebFont", sans-serif; color: red; }\n.body { font-family: Arial, sans-serif; }';
  const f=await theme(t,{'assets/main.css':css},'assets/main.css','render-resource');
  const parameters={selector:'.heading',family:'Measured Fallback',local:'Arial',sizeAdjust:100,ascentOverride:90,descentOverride:20,lineGapOverride:0};
  const config=cfg(f,'reduce-cls-font-swapping','site:css-font-fallback',parameters,{fontMetricsMeasured:true}),p=await createOfficialPlan({...f,config});
  assert.match(p.changes[0].after,/font-family: "WebFont", "Measured Fallback", sans-serif/);assert.match(p.changes[0].after,/size-adjust: 100%/);
  assert.match(p.changes[0].after,/\.body \{ font-family: Arial, sans-serif; \}/);
  for(const source of ['.heading{font-family:var(--font)}','.heading{font-family:serif}','.heading{font-family:WebFont;font:12px Arial}','@media(min-width:1px){.heading{font-family:WebFont}}','.heading{font-family:WebFont!important}','@font-face{font-family:measured   fallback;src:local(Arial)}.heading{font-family:WebFont}','@font-face{font-family:"measured fallback";src:local(Arial)}.heading{font-family:WebFont}']) {
    assert.throws(()=>transformCode({source,target:'assets/main.css',kind:'css-font-fallback',parameters,evidence:{summary:'Fixture',sourceHash:sha256(source),fontMetricsMeasured:true}}),{code:'UNSUPPORTED_CODE_PATTERN'});
  }
});

test('hint article cannot authorize removal of a different rel mechanism',async t=>{
  const link='<link rel="preconnect" href="https://example.test">',text='<head>'+link+link+'</head>',f=await theme(t,{'layout/theme.liquid':text},'layout/theme.liquid','render-resource');
  const config=cfg(f,'use-preconnect','site:liquid-dedupe-resource-hint',{firstStart:6,duplicateStart:6+link.length},{renderedTogether:true,responseHeadersReviewed:true,resourceTimingReviewed:true,domReferencesReviewed:true});
  assert.equal((await createOfficialPlan({...f,config})).changes[0].after,'<head>'+link+'</head>');
  await assert.rejects(createOfficialPlan({...f,config:{...config,methodId:'use-preload-resource-hints-sparingly'}}),{code:'OFFICIAL_TARGET_MISMATCH'});
});

test('catalog CLI exports full contracts and reports changed official guidance',async t=>{
  const out=path.join(await root(t),'methods.json');
  const result=spawnSync(process.execPath,['scripts/perfkit.mjs','shopify-methods','--topic','images','--out',out],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);const c=JSON.parse(await readFile(out,'utf8'));assert.ok(c.methods.every(m=>m.topic==='images'));assert.ok(c.methods[0].executors[0].evidenceRequired);
  assert.match(execFileSync(process.execPath,['scripts/perfkit.mjs','--help'],{encoding:'utf8'}),/plan-official/);
});
