import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {normalizeThemeCheck,themeCheckEnvironment} from '../lib/theme-check-transport.mjs';
import {runProcess} from '../lib/core/bounded-process.mjs';
import {importCheck} from '../lib/check-import.mjs';
import {checkOfficialPerformance,performanceChecks} from '../lib/official-performance.mjs';
import {precheckTheme} from '../lib/precheck.mjs';
import {sha256} from '../lib/source-utils.mjs';
import {auditQuality} from '../lib/quality-audit.mjs';
import {extractJsonCode,auditJsonCode} from '../lib/json-embedded.mjs';
import {compareThemes} from '../lib/theme-diff.mjs';
import {renderReport} from '../lib/report.mjs';
async function theme(t,files){const root=await realpath(await mkdtemp(path.join(tmpdir(),'theme-evidence-')));t.after(()=>rm(root,{recursive:true,force:true}));for(const [f,s]of Object.entries(files)){await mkdir(path.dirname(path.join(root,f)),{recursive:true});await writeFile(path.join(root,f),s);}return root;}
const issue=(extra={})=>({filePath:'sections/a.liquid',check:'ImgWidthAndHeight',severity:'error',startRow:2,startColumn:3,endRow:2,endColumn:14,message:'Missing width and height',...extra});
const flat=(issues=[],valid=issues.length===0)=>({valid,issues,errorCount:issues.filter(i=>i.severity==='error').length,warningCount:issues.filter(i=>i.severity==='warning').length,infoCount:issues.filter(i=>i.severity==='info').length});
test('CLI 5 coordinates normalize exactly once and preserve raw diagnostic and report hash',async t=>{
 const source='first\n  <img src="x">',project=await theme(t,{'sections/a.liquid':source}),input=flat([issue()]);
 const r=await importCheck({project,input,metadata:{tool:'Theme Check',toolVersion:'3.26.1',scope:'test',positionBase:0,severityMap:{},rulesConfig:{},scannedFiles:['sections/a.liquid'],sourceHashes:{'sections/a.liquid':sha256(source)},complete:true}});
 assert.equal(r.complete,true);assert.equal(r.findings[0].line,2);assert.equal(r.findings[0].evidence.original.column,2);assert.deepEqual(r.findings[0].evidence.original.nativeIssue,input.issues[0]);assert.equal(r.rawReportHash,sha256(JSON.stringify(input)));
 assert.equal(r.metadata.transport.inputPositionBase,1);assert.equal(r.metadata.positionBase,0);
 await assert.rejects(importCheck({project,input,metadata:{positionBase:1}}),/zero-based/);
 assert.equal((await importCheck({project,input})).complete,false);
});
test('malformed or inconsistent new envelopes cannot become clean checks',()=>{
 for(const value of [{error:{message:'failure'}},flat([],false),{...flat([issue()]),errorCount:0},flat([issue({startRow:0})]),flat([issue({severity:7})]),flat([issue({endRow:1})])])assert.throws(()=>normalizeThemeCheck(value));
 assert.deepEqual(normalizeThemeCheck([]).groups,[]);assert.equal(normalizeThemeCheck(flat()).groups.length,0);
});
test('child flags are removed, not changed to false or inherited accidentally',async()=>{
 const prior=process.env.SHOPIFY_FLAG_INIT;process.env.SHOPIFY_FLAG_INIT='true';
 try{
  const overrides=themeCheckEnvironment();assert.equal(overrides.SHOPIFY_FLAG_INIT,undefined);assert.ok(Object.hasOwn(overrides,'SHOPIFY_FLAG_INIT'));
  const r=await runProcess(process.execPath,['-e','process.stdout.write(String(process.env.SHOPIFY_FLAG_INIT))'],{env:overrides});assert.equal(r.stdout,'undefined');
 }finally{if(prior===undefined)delete process.env.SHOPIFY_FLAG_INIT;else process.env.SHOPIFY_FLAG_INIT=prior;}
});
function runner({rules,raw,onRun}){return async(_,args,options)=>{
 assert.notEqual(options.env.SHOPIFY_FLAG_INIT,'false');
 if(args[0]==='version')return {code:0,stdout:'5.0.1',stderr:''};if(args.includes('--version'))return {code:0,stdout:'3.26.1',stderr:''};
 if(args.includes('--print'))return {code:0,stdout:rules,stderr:''};onRun?.(args);
 return {code:raw.issues.length?1:0,stdout:JSON.stringify(raw),stderr:''};
};}
test('official and precheck runners consume CLI 5 while keeping independent scope and drift gates',async t=>{
 const project=await theme(t,{'sections/a.liquid':'first\n  <img src="x">'});
 const r=await checkOfficialPerformance({project,dependencies:{runProcess:runner({raw:flat([issue()]),rules:performanceChecks.map(x=>`${x}:\n  enabled: true\n`).join('')})}});
 assert.equal(r.complete,true);assert.equal(r.reviewRequired,true);assert.equal(r.findings[0].line,2);
 const clean=await theme(t,{'sections/a.liquid':'<div>plain</div>'});
 const p=await precheckTheme({project:clean,dependencies:{runProcess:runner({raw:flat(),rules:'LiquidComplexity:\n  enabled: true\n  maxComplexity: 120\nLiquidNestingDepth:\n  enabled: true\n  maxDepth: 10\n'})}});assert.equal(p.complete,true);
});
test('decoded JSON preserves pointers, escaped multiline strings and disabled ancestors',async t=>{
 const code='{% assign selected = all_products[handle] %}\n<img src="x">\n<script>fetch("/cart/add.js", {method:"POST"});</script>';
 const source='/* Shopify header */\n'+JSON.stringify({sections:{'a/b~c':{type:'custom-liquid',disabled:true,settings:{liquid:code}},visible:{type:'custom-liquid',settings:{liquid:'<script src="x.js"></script>'}}}});
 const decoded=auditJsonCode({file:'templates/product.json',source});
 assert.equal(decoded.regions.length,2);assert.equal(decoded.regions[0].jsonPointer,'/sections/a~1b~0c/settings/liquid');assert.equal(decoded.regions[0].configurationState,'disabled-ancestor');assert.equal(decoded.regions[0].businessLogicCandidate,true);
 const image=decoded.findings.find(f=>f.ruleId==='Q-JSON-IMAGE-LOADING');assert.equal(image.line,null);assert.equal(image.embeddedLine,2);assert.equal(image.sourceHash,sha256(source));assert.equal(image.runtime,'unverified');
 const project=await theme(t,{'templates/product.json':source});const q=await auditQuality({project});assert.equal(q.summary.embeddedRegions,2);assert.ok(q.findings.some(f=>f.jsonPointer));assert.match(renderReport(q),/字段内行 2/);assert.match(renderReport(q),/disabled-ancestor/);
});
test('HTML-like strings and JSON data scripts are not executed as child code; dynamic JS remains incomplete',()=>{
 const source=JSON.stringify({sections:{s:{type:'custom-liquid',settings:{liquid:'<script>const s="<img src=x>";</script><script type="application/ld+json">{"a":1}</script><template><script src="lazy.js"></script><img src="lazy"></template>'}}}});
 const a=auditJsonCode({file:'templates/product.json',source});assert.equal(a.findings.length,0);assert.equal(a.regions[0].metrics.scripts,1);
 const b=auditJsonCode({file:'templates/product.json',source:JSON.stringify({sections:{s:{type:'custom-liquid',settings:{liquid:'<script>const id={{ product.id }};</script>'}}}})});
 assert.ok(b.issues.some(i=>i.reason==='embedded-liquid-requires-render'&&i.line===null&&i.jsonPointer));
 assert.equal(extractJsonCode({file:'locales/en.json',source}).regions.length,0);
 assert.equal(extractJsonCode({file:'templates/a.json',source:'{bad'}).issues.length,1);
 assert.equal(extractJsonCode({file:'templates/a.json',source,limit:0}).issues[0].reason,'region-limit');
});
test('CSS setting arrays and nested disabled blocks retain their independent pointers',()=>{
 const source=JSON.stringify({sections:{s:{type:'custom',settings:{},custom_css:['.a { color: red }','.b {color:{{ settings.color }}}'],blocks:{b:{type:'liquid',disabled:true,settings:{liquid:'<script src="a.js" defer></script>'}}}}}});
 const a=auditJsonCode({file:'templates/a.json',source});assert.equal(a.regions.length,3);assert.equal(a.findings.length,0);assert.equal(a.regions[0].jsonPointer,'/sections/s/custom_css/0');assert.ok(a.issues.some(i=>i.jsonPointer==='/sections/s/custom_css/1'));assert.equal(a.regions[2].configurationState,'disabled-ancestor');
});
test('Liquid inside valid JavaScript strings still requires rendered evidence',()=>{
 const source=JSON.stringify({sections:{s:{type:'custom-liquid',settings:{liquid:'<script>const id = "{{ product.id }}";</script>'}}}});
 const result=auditJsonCode({file:'templates/product.json',source});
 assert.ok(result.issues.some(i=>i.reason==='embedded-liquid-requires-render'&&i.stage==='javascript'));
});
test('theme diff includes unchanged code affected by an ancestor disabled toggle',async t=>{
 const obj={sections:{s:{type:'custom',settings:{},blocks:{b:{type:'liquid',settings:{liquid:'<script src="bundle.js"></script>'}}}}}};
 const before=await theme(t,{'templates/product.json':JSON.stringify(obj)});
 obj.sections.s.disabled=true;
 const after=await theme(t,{'templates/product.json':JSON.stringify(obj)});
 const result=await compareThemes({before,after});
 assert.equal(result.summary.embeddedChangedFiles,1);
 assert.equal(result.changes[0].embedded.before[0].configurationState,'enabled-in-config');
 assert.equal(result.changes[0].embedded.after[0].configurationState,'disabled-ancestor');
});
test('theme diff distinguishes formatting, business code, new/deleted assets and large values without claiming gain',async t=>{
 const obj={sections:{s:{type:'custom-liquid',settings:{liquid:'{% assign variant_id = 123 %}'}}},order:['s']};
 const before=await theme(t,{'templates/product.json':JSON.stringify(obj),'assets/old.js':'old','config/settings_data.json':'{"current":{}}','assets/icon.png':Buffer.from([0,1,255])});
 const next=structuredClone(obj);next.sections.s.settings.liquid='{% assign variant_id = 456 %}';next.sections.s.disabled=true;next.long='x'.repeat(2500);
 const after=await theme(t,{'templates/product.json':JSON.stringify(next),'assets/new.js':'new','config/settings_data.json':'{ "current": {} }','assets/icon.png':Buffer.from([0,1,255])});
 const d=await compareThemes({before,after});assert.equal(d.complete,true);assert.equal(d.summary.unchanged,1);assert.equal(d.summary.added,1);assert.equal(d.summary.deleted,1);assert.equal(d.summary.modified,2);assert.equal(d.performance,'not-measured');assert.equal(d.deployment,'unverified');
 const product=d.changes.find(x=>x.file==='templates/product.json');assert.equal(product.embedded.after[0].configurationState,'disabled-ancestor');assert.equal(product.fields.find(x=>x.jsonPointer==='/long').after.truncated,true);
 assert.equal(d.changes.find(x=>x.file==='config/settings_data.json').jsonOnlyFormatting,true);assert.match(renderReport(d),/主题文件差异/);
 const out=path.join(path.dirname(before),path.basename(before)+'-diff.json');t.after(()=>rm(out,{force:true}));
 const cli=spawnSync(process.execPath,['scripts/perfkit.mjs','theme-diff','--before',before,'--after',after,'--out',out],{cwd:new URL('..',import.meta.url),encoding:'utf8'});assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(await readFile(out,'utf8')).summary.modified,2);
});
test('theme diff reports bad JSON and refuses output inside input snapshots',async t=>{
 const before=await theme(t,{'templates/a.json':'{}'}),after=await theme(t,{'templates/a.json':'{bad'});const d=await compareThemes({before,after});assert.equal(d.complete,false);assert.ok(d.issues.length);
 const r=spawnSync(process.execPath,['scripts/perfkit.mjs','theme-diff','--before',before,'--after',after,'--out',path.join(after,'diff.json')],{cwd:new URL('..',import.meta.url),encoding:'utf8'});assert.equal(r.status,2);assert.match(r.stderr,/outside/);
 await symlink(path.join(before,'templates/a.json'),path.join(after,'templates/link.json'));assert.equal((await compareThemes({before,after})).complete,false);
});

test('empty directories are not accepted as deletion snapshots',async t=>{
 const before=await theme(t,{}),after=await theme(t,{'templates/a.json':'{}'});
 await assert.rejects(compareThemes({before,after}),/empty directories/);
});
test('standalone official checker retains failed command evidence with nonzero exit',async t=>{
 const project=await theme(t,{'sections/a.liquid':'<img src="x">'});
 const root=await theme(t,{}),cli=path.join(root,'fake-checker');
 const config=performanceChecks.map(rule=>`${rule}:\n  enabled: true\n`).join('');
 await writeFile(cli,`#!${process.execPath}\nconst args=process.argv.slice(2);if(args[0]==='version'||args.includes('--version'))console.log('5.0.1');else if(args.includes('--print'))console.log(${JSON.stringify(config)});else {console.log(JSON.stringify({error:{message:"fixture failure"}}));process.exitCode=2;}`);
 await chmod(cli,0o755);const out=path.join(root,'failed.json');
 const r=spawnSync(process.execPath,['scripts/perfkit.mjs','check-performance','--project',project,'--out',out],{cwd:new URL('..',import.meta.url),env:{...process.env,PERF_KIT_SHOPIFY_CLI:cli},encoding:'utf8'});
 assert.equal(r.status,2);const evidence=JSON.parse(await readFile(out,'utf8'));assert.equal(evidence.status,'failed');assert.equal(evidence.kind,'official-performance-failure');assert.equal(evidence.commands.at(-1).exitCode,2);assert.match(evidence.commands.at(-1).stdout,/fixture failure/);
});
