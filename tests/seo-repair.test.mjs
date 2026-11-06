import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
import {createSEOPlan,applySEOPlan,verifySEOPlan,rollbackSEOPlan,repairSEO} from '../lib/seo/repair.mjs';
import {planHash} from '../lib/core/plan-utils.mjs';
const source='<html><head>\n{{ content_for_header }}\n</head><body>\n{{ content_for_layout }}\n</body></html>';
async function fixture(t,text=source){const root=await fs.mkdtemp('/private/tmp/seo-repair-');t.after(()=>fs.rm(root,{recursive:true,force:true}));const project=root+'/theme',file=project+'/layout/theme.liquid';await fs.mkdir(project+'/layout',{recursive:true});await fs.writeFile(file,text);return {root,project,file};}
test('automatic source repair writes five metadata fixes, verifies and rolls back exactly',async t=>{
 const f=await fixture(t),plan=await createSEOPlan(f);assert.equal(plan.targets.length,5);assert.equal(await fs.readFile(f.file,'utf8'),source);
 assert.equal((await applySEOPlan(plan,f.project)).completed,true);assert.equal((await applySEOPlan(plan,f.project)).status,'already-applied');
 const v=await verifySEOPlan(plan,f.project);assert.equal(v.passed,true);assert.equal(v.runtime,'not-run');assert.equal(v.onlineSEO,'not-evaluated');
 assert.equal((await rollbackSEOPlan(plan,f.project)).completed,true);assert.equal(await fs.readFile(f.file,'utf8'),source);assert.equal((await verifySEOPlan(plan,f.project)).passed,false);
});
test('fix records plan, receipt and source verification; remaining semantic repairs stay explicit',async t=>{
 const f=await fixture(t,source.replace('</body>','<img src="product.jpg"></body>'));
 const result=await repairSEO({...f,output:f.root+'/fix'});assert.equal(result.status,'partially-repaired');assert.ok(result.remaining.some(x=>x.ruleId==='Q-ALT'));
 const before=await fs.readFile(f.file,'utf8');const config={schemaVersion:1,summary:'Use the verified product image alternative text.',targets:[{file:'layout/theme.liquid',ruleId:'Q-ALT'}],changes:[{target:'layout/theme.liquid',replacementText:before.replace('<img src="product.jpg">','<img src="product.jpg" alt="{{ product.featured_image.alt | escape }}">')}]};
 const result2=await repairSEO({...f,config,output:f.root+'/custom'});assert.equal(result2.status,'source-verified');assert.equal((await createSEOPlan(f)).status,'no-findings');
});
test('empty metadata repairs are valid replacements',async t=>{
 const f=await fixture(t,source.replace('<head>','<head><title></title><meta name="description" content=""><link rel="canonical" href="#">'));
 const result=await repairSEO({...f,output:f.root+'/fix'});assert.equal(result.status,'source-verified',JSON.stringify(result));
});
test('drift blocks apply and preserves externally modified source during rollback',async t=>{
 const f=await fixture(t),plan=await createSEOPlan(f);await fs.writeFile(f.file,source+'\nexternal');await assert.rejects(applySEOPlan(plan,f.project),/drift/);
 await fs.writeFile(f.file,source);await applySEOPlan(plan,f.project);await fs.appendFile(f.file,'\nexternal');await assert.rejects(rollbackSEOPlan(plan,f.project),/neither permitted/);assert.match(await fs.readFile(f.file,'utf8'),/external$/);
});
test('tampered plans and forged findings cannot pass source replay',async t=>{
 const f=await fixture(t),plan=await createSEOPlan(f);plan.targets.push({file:'layout/theme.liquid',ruleId:'invented'});plan.planHash=planHash(plan);await assert.rejects(applySEOPlan(plan,f.project),/finding/);
 const other=await createSEOPlan(f);other.changes[0].after+='broken';await assert.rejects(applySEOPlan(other,f.project),/Invalid SEO plan/);
});
test('reviewed SEO changes reject element deletion, schema/script changes and malformed Liquid',async t=>{
 const f=await fixture(t,source.replace('</body>','<img src="product.jpg"><script>window.x=1;</script></body>'));
 const before=await fs.readFile(f.file,'utf8');
 for(const after of [before.replace('<img src="product.jpg">',''),before.replace('window.x=1','window.x=2').replace('<img ', '<img alt="Product" '),before+'{% if %}']){
  await assert.rejects(createSEOPlan({...f,config:{schemaVersion:1,summary:'Source repair',targets:[{file:'layout/theme.liquid',ruleId:'Q-ALT'}],changes:[{target:'layout/theme.liquid',replacementText:after}]}}));
 }
 assert.equal(await fs.readFile(f.file,'utf8'),before);
});
test('unresolved dependencies and inside-theme outputs never trigger writes',async t=>{
 const f=await fixture(t,source.replace('</body>',"{% render 'missing' %}</body>"));await assert.rejects(createSEOPlan(f),/complete source coverage/);
 await assert.rejects(repairSEO({...f,output:f.project+'/result'}),/outside/);
});
test('CLI fix and rollback work without browser/Python and preserve evidence',async t=>{
 const f=await fixture(t),cli=new URL('../scripts/seokit.mjs',import.meta.url).pathname;
 const r=JSON.parse(execFileSync(process.execPath,[cli,'fix','--project',f.project,'--out',f.root+'/fix'],{encoding:'utf8'}));assert.equal(r.status,'source-verified');
 execFileSync(process.execPath,[cli,'rollback','--project',f.project,'--plan',f.root+'/fix/plan.json','--out',f.root+'/rollback.json']);assert.equal(await fs.readFile(f.file,'utf8'),source);
 const retry=spawnSync(process.execPath,[cli,'fix','--project',f.project,'--out',f.root+'/fix']);assert.notEqual(retry.status,0);assert.equal(await fs.readFile(f.file,'utf8'),source);
});
test('inline placeholders stay valid while conditional relocation and schema edits are refused',async t=>{
 const f=await fixture(t,source.replaceAll('\n',''));const p=await createSEOPlan(f);await applySEOPlan(p,f.project);assert.equal((await verifySEOPlan(p,f.project)).passed,true);
 await fs.mkdir(f.project+'/sections');const section='<img src="p.jpg">{% schema %}{"name":"Product","settings":[]}{% endschema %}';await fs.writeFile(f.project+'/sections/product.liquid',section);
 const config={schemaVersion:1,summary:'Repair image alt',targets:[{file:'sections/product.liquid',ruleId:'Q-ALT'}],changes:[{target:'sections/product.liquid',replacementText:section.replace('<img ', '<img alt="Product" ').replace('"name":"Product"','"name":"Changed"')}]};
 await assert.rejects(createSEOPlan({...f,config}),/schema/);
 const current=await fs.readFile(f.file,'utf8');config.changes=[{target:'sections/product.liquid',replacementText:section.replace('<img ', '<img alt="Product" ')},{target:'layout/theme.liquid',replacementText:current.replace('{{ content_for_layout }}','{% if false %}{{ content_for_layout }}{% endif %}')}];
 await assert.rejects(createSEOPlan({...f,config}),/context/);
});
test('custom source plan repairs static JSON-LD and crawlable links across files',async t=>{
 const f=await fixture(t);await repairSEO({...f,output:f.root+'/base'});await fs.mkdir(f.project+'/snippets');await fs.writeFile(f.project+'/snippets/data.liquid','<script type="application/ld+json">{invalid}</script>');await fs.writeFile(f.project+'/snippets/link.liquid','<a href="javascript:void(0)">Products</a>');
 const config={schemaVersion:1,summary:'Restore existing product navigation and valid structured data syntax',targets:[{file:'snippets/data.liquid',ruleId:'Q-JSONLD-JSON'},{file:'snippets/link.liquid',ruleId:'Q-CRAWL-LINK'}],changes:[{target:'snippets/data.liquid',replacementText:'<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite"}</script>'},{target:'snippets/link.liquid',replacementText:'<a href="{{ routes.all_products_collection_url }}">Products</a>'}]};
 const result=await repairSEO({...f,config,output:f.root+'/custom'});assert.equal(result.status,'source-verified');assert.equal(result.resolved.length,2);
});
test('failure persisting verification triggers actual rollback, with conflicts preserved',async t=>{
 for(const conflict of [false,true]){
  const f=await fixture(t);const original=fs.writeFile;let injected=false;
  const mock=t.mock.method(fs,'writeFile',async function(file,...args){if(String(file).endsWith('/verification.json')&&!injected){injected=true;if(conflict)await original(f.file,'external edit');throw new Error('Injected evidence write failure');}return original.call(this,file,...args);});
  try{const result=await repairSEO({...f,output:f.root+'/fix'});assert.equal(result.status,conflict?'rollback-conflict':'failed-rolled-back');assert.equal(await fs.readFile(f.file,'utf8'),conflict?'external edit':source);assert.equal(result.acceptance,'not-accepted');}finally{mock.mock.restore();}
 }
});
test('rehashed forged audit targets and misleading diffs cannot produce acceptance',async t=>{
 const f=await fixture(t),plan=await createSEOPlan(f),forged=structuredClone(plan);
 forged.targets.push({file:'layout/theme.liquid',ruleId:'Q-INVENTED'});forged.beforeAudit.findings.push({...forged.beforeAudit.findings[0],ruleId:'Q-INVENTED'});forged.beforeAudit.summary.findings++;forged.beforeAudit.summary.warnings++;forged.planHash=planHash(forged);
 await assert.rejects(applySEOPlan(forged,f.project),/replay/);await applySEOPlan(plan,f.project);assert.equal((await verifySEOPlan(forged,f.project)).passed,false);
 const misleading=structuredClone(plan);misleading.changes[0].diff='No changes';misleading.planHash=planHash(misleading);await assert.rejects(verifySEOPlan(misleading,f.project),/fingerprint/);
});
test('real theme settings and binary media are read-only dependencies, not patch targets',async t=>{
 const f=await fixture(t);await fs.mkdir(f.project+'/config');await fs.mkdir(f.project+'/assets');
 const settings='{"current":{"color":"#123456"}}',image=Buffer.from([0xff,0xd8,0,0x80,0xfe]);
 await fs.writeFile(f.project+'/config/settings_data.json',settings);await fs.writeFile(f.project+'/assets/product.jpg',image);
 const result=await repairSEO({...f,output:f.root+'/fix'});assert.equal(result.status,'source-verified',JSON.stringify(result));
 assert.equal(await fs.readFile(f.project+'/config/settings_data.json','utf8'),settings);assert.deepEqual(await fs.readFile(f.project+'/assets/product.jpg'),image);
 const plan=JSON.parse(await fs.readFile(f.root+'/fix/plan.json','utf8'));await rollbackSEOPlan(plan,f.project);assert.equal(await fs.readFile(f.file,'utf8'),source);
 await fs.writeFile(f.project+'/assets/product.jpg',Buffer.from([1,2,3]));await assert.rejects(applySEOPlan(plan,f.project),/drift/);
});
test('source repairs cannot smuggle raw Liquid scripts, business content or unrelated SEO regressions',async t=>{
 const text=source.replace('</body>','<p>Keep description</p><img src="product.jpg"><a href="javascript:void(0)">Old</a><a href="/good">Good</a>{% javascript %}window.keep=1;{% endjavascript %}{% stylesheet %}.keep{color:red}{% endstylesheet %}</body>');
 const f=await fixture(t,text);const alt=text.replace('<img ', '<img alt="Product" ');
 const alternatives=[alt.replace('window.keep=1','window.keep=2'),alt.replace('color:red','color:blue'),alt.replace('Keep description',''),alt.replace('product.jpg','other.jpg'),alt.replace('javascript:void(0)','/fixed').replace('/good','javascript:void(0)')];
 for(const after of alternatives)await assert.rejects(createSEOPlan({...f,config:{schemaVersion:1,summary:'Repair alt only',targets:[{file:'layout/theme.liquid',ruleId:'Q-ALT'}],changes:[{target:'layout/theme.liquid',replacementText:after}]}}),/SEO repair cannot change/);
 assert.equal(await fs.readFile(f.file,'utf8'),text);
});
test('metadata hidden in a new Liquid branch is not a successful source fix',async t=>{
 const f=await fixture(t);const replacement=source.replace('<head>','<head>{% if false %}<title>Hidden</title>{% endif %}');
 await assert.rejects(createSEOPlan({...f,config:{schemaVersion:1,summary:'Wrongly hidden title',targets:[{file:'layout/theme.liquid',ruleId:'Q-SEO-TITLE'}],changes:[{target:'layout/theme.liquid',replacementText:replacement}]}}),/control flow/);
});
test('verification rechecks the live source after reconstructing its baseline',async t=>{
 const f=await fixture(t),plan=await createSEOPlan(f);await applySEOPlan(plan,f.project);
 const original=fs.writeFile;let injected=false;
 const mock=t.mock.method(fs,'writeFile',async function(file,...args){const value=await original.call(this,file,...args);if(!injected&&String(file).includes('seo-candidate-')){injected=true;await original(f.file,'external change');}return value;});
 try{const result=await verifySEOPlan(plan,f.project);assert.equal(result.passed,false);assert.equal(result.sourceStable,false);}finally{mock.mock.restore();}
});
test('failed evidence storage does not suppress rollback or mislabel successful restoration',async t=>{
 const f=await fixture(t),original=fs.writeFile;
 const mock=t.mock.method(fs,'writeFile',async function(file,...args){if(/\/(apply|rollback|result)\.json$/.test(String(file)))throw new Error('disk unavailable');return original.call(this,file,...args);});
 try{const result=await repairSEO({...f,output:f.root+'/fix'});assert.equal(result.status,'failed-rolled-back');assert.equal(result.rollback.completed,true);assert.ok(result.persistenceErrors.length>=2);assert.equal(await fs.readFile(f.file,'utf8'),source);}finally{mock.mock.restore();}
});
test('CLI rejects an unusable receipt parent before applying any source',async t=>{
 const f=await fixture(t),plan=await createSEOPlan(f);await fs.writeFile(f.root+'/plan.json',JSON.stringify(plan));await fs.writeFile(f.root+'/file-not-directory','occupied');
 const result=spawnSync(process.execPath,[new URL('../scripts/seokit.mjs',import.meta.url).pathname,'apply','--project',f.project,'--plan',f.root+'/plan.json','--out',f.root+'/file-not-directory/receipt.json']);
 assert.equal(result.status,2);assert.equal(await fs.readFile(f.file,'utf8'),source);
});
test('automatic repair handles empty language, mixed-case metadata and canonical without href',async t=>{
 const f=await fixture(t,source.replace('<html>','<html lang=" ">').replace('<head>','<head><meta name="Description" content="   "><link rel="CANONICAL">'));
 const r=await repairSEO({...f,output:f.root+'/fix'});assert.equal(r.status,'source-verified',JSON.stringify(r));const text=await fs.readFile(f.file,'utf8');assert.equal((text.match(/rel="CANONICAL"/g)??[]).length,1);assert.ok(!text.includes('rel="canonical"'));assert.match(text,/href="{{ canonical_url }}"/);
});
test('partial write recovery conflicts are explicit and never overwrite external changes',async t=>{
 const f=await fixture(t);await fs.writeFile(f.project+'/layout/alternate.liquid',source);
 const originalRename=fs.rename,originalWrite=fs.writeFile;let firstTarget;
 const mock=t.mock.method(fs,'rename',async function(from,to){if(String(from).includes('.perf-site-')){if(!firstTarget){firstTarget=to;return originalRename.call(this,from,to);}await originalWrite(firstTarget,'external concurrent edit');throw new Error('Second write failed');}return originalRename.call(this,from,to);});
 try{const r=await repairSEO({...f,output:f.root+'/fix'});assert.equal(r.status,'rollback-conflict');assert.equal(r.rollback.receipt.partial,true);assert.equal(await fs.readFile(firstTarget,'utf8'),'external concurrent edit');}finally{mock.mock.restore();}
});
test('unparseable JSON-LD cannot be accepted by changing it to an unverified dynamic output',async t=>{
 const text=source.replace('</body>','<script type="application/ld+json">{bad}</script></body>'),f=await fixture(t,text);
 await assert.rejects(createSEOPlan({...f,config:{schemaVersion:1,summary:'Hide static error behind dynamic output',targets:[{file:'layout/theme.liquid',ruleId:'Q-JSONLD-JSON'}],changes:[{target:'layout/theme.liquid',replacementText:text.replace('{bad}','{{ unknown_data }}')}]}}),/SEO repair cannot change/);
 assert.equal(await fs.readFile(f.file,'utf8'),text);
});
test('SEO replacements reject text that cannot round-trip through UTF-8',async t=>{
 const f=await fixture(t);await assert.rejects(createSEOPlan({...f,config:{schemaVersion:1,summary:'Invalid source encoding',targets:[{file:'layout/theme.liquid',ruleId:'Q-SEO-TITLE'}],changes:[{target:'layout/theme.liquid',replacementText:source.replace('<head>','<head><title>\ud800</title>')}]}}),/Invalid or unchanged replacement/);assert.equal(await fs.readFile(f.file,'utf8'),source);
});
