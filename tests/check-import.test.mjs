import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { importCheck } from '../lib/check-import.mjs';
import { renderReport } from '../lib/report.mjs';
const digest = s => createHash('sha256').update(s).digest('hex');
async function fixture(t, source = '{{ product | structured_data }}') {
  const project = await mkdtemp(path.join(tmpdir(), 'perfkit-import-')); t.after(() => rm(project,{recursive:true,force:true}));
  await mkdir(path.join(project,'sections')); await writeFile(path.join(project,'sections/a.liquid'),source);
  const metadata = {tool:'theme-check',toolVersion:'1.15.0',positionBase:0,rulesConfig:{UnknownFilter:{enabled:true}},scope:'whole-theme',severityMap:{0:'error',1:'warning',2:'info'},scannedFiles:['sections/a.liquid'],sourceHashes:{'sections/a.liquid':digest(source)},complete:true};
  const input = [{path:'sections/a.liquid',offenses:[{check:'UnknownFilter',severity:'error',start_row:0,start_column:0,message:"Unknown filter 'structured_data'"}]}];
  return {project,metadata,input};
}
test('native import preserves raw diagnostics, binds hashes and annotates native filter without suppressing it', async t=>{
  const args=await fixture(t), result=await importCheck(args);
  assert.equal(result.complete,true); assert.equal(result.findings[0].line,1); assert.equal(result.findings[0].severity,'error');
  assert.equal(result.findings[0].correction.status,'false-positive-candidate'); assert.equal(result.findings[0].correction.automaticSuppression,false);
  assert.equal(result.findings[0].evidence.original.message,args.input[0].offenses[0].message);
  assert.equal(await readFile(path.join(args.project,'sections/a.liquid'),'utf8'),'{{ product | structured_data }}');
});
test('missing numeric mapping or coordinate metadata never guesses severity or marks a report complete',async t=>{
  const args=await fixture(t); args.input[0].offenses[0].severity=1;
  let result=await importCheck({...args,metadata:{}}); assert.equal(result.complete,false);assert.equal(result.findings[0].severity,'unknown');assert.equal(result.findings[0].line,null);
  args.metadata.positionBase=1; args.input[0].offenses[0].start_row=1;
  result=await importCheck(args);assert.equal(result.findings[0].line,1);assert.equal(result.findings[0].severity,'warning');
});
test('aggregate PDF observations retain counts and cannot pass source gating', async t=>{
  const args=await fixture(t); const result=await importCheck({...args,input:{schemaVersion:1,kind:'check-observations',findings:[{ruleId:'ImgWidthAndHeight',count:217,severity:'error',message:'Reported missing dimensions'},{ruleId:'SpaceInsideBraces',count:2306,severity:'style',message:'Reported formatting'}]}});
  assert.equal(result.complete,false);assert.equal(result.summary.reportedOccurrences,2523);assert.equal(result.summary.byCategory.style,2306);assert.equal(result.findings[0].priority,null);
});
test('corrections are narrow; valid pagination is policy review, nearby unrelated errors are retained',async t=>{
  const source="{% content_for 'blocks' %}\n{% paginate collection.products by 100 %}\n{{ p | img_url }}\n{{ x | parse_json }}";
  const args=await fixture(t,source); args.input[0].offenses=[
    {check:'SyntaxError',message:'Unknown tag content_for',start_row:0,severity:'error'},
    {check:'PaginationSize',message:'Too many items',start_row:1,severity:'suggestion'},
    {check:'DeprecatedFilter',message:'img_url deprecated',start_row:2,severity:'suggestion'},
    {check:'UnknownFilter',message:'Unknown filter parse_json',start_row:3,severity:'error'},
    {check:'SyntaxError',message:'Unexpected comma',start_row:0,severity:'error'},
  ];
  const r=await importCheck(args);
  assert.deepEqual(r.findings.map(f=>f.correction?.status??null),['tool-compatibility-review','policy-review','migration-review',null,null]);
});
test('same contract baseline handles moved lines, new errors and severity escalation',async t=>{
  const args=await fixture(t);const baseline=await importCheck(args);
  const changed='\n{{ product | structured_data }}';await writeFile(path.join(args.project,'sections/a.liquid'),changed);
  args.metadata.sourceHashes['sections/a.liquid']=digest(changed);args.input[0].offenses[0].start_row=1;
  let r=await importCheck({...args,baseline});assert.equal(r.comparison.gate,'no-new-errors');assert.equal(r.comparison.existing.length,1);
  args.input[0].offenses.push({check:'MissingTemplate',severity:'error',start_row:1,message:'Missing snippet'});
  r=await importCheck({...args,baseline});assert.equal(r.comparison.gate,'review-required');assert.equal(r.comparison.newErrors.length,1);
  const lower=structuredClone(baseline);lower.findings[0].severity='suggestion';
  r=await importCheck({...args,baseline:lower});assert.equal(r.comparison.severityChanged.length,1);
});
test('changed version/config/scope and stale fingerprints prevent comparison',async t=>{
  const args=await fixture(t);const baseline=await importCheck(args);
  for(const metadata of [{...args.metadata,toolVersion:'new'},{...args.metadata,rulesConfig:{}},{...args.metadata,scope:'sections-only'},{...args.metadata,sourceHashes:{}}]){
    const r=await importCheck({...args,metadata,baseline});assert.equal(r.comparison.status,'not-comparable');
  }
});
test('complete empty scan requires actual scanned file fingerprints',async t=>{
  const args=await fixture(t);assert.equal((await importCheck({...args,input:[]})).complete,true);
  assert.equal((await importCheck({...args,input:[],metadata:{...args.metadata,scannedFiles:[]}})).complete,false);
});
test('paths outside theme and malformed reports are rejected, symlinks cannot supply source evidence',async t=>{
  const args=await fixture(t);
  for (const file of ['../outside.liquid','/etc/passwd','sections/../outside.liquid']) await assert.rejects(importCheck({...args,input:[{path:file,offenses:args.input[0].offenses}]}));
  await assert.rejects(importCheck({...args,input:{findings:[]}}));
  await symlink(path.join(args.project,'sections/a.liquid'),path.join(args.project,'sections/alias.liquid'));
  const r=await importCheck({...args,input:[{path:'sections/alias.liquid',offenses:args.input[0].offenses}]});assert.equal(r.complete,false);assert.equal(r.findings[0].sourceHash,null);
});
test('absolute paths use explicit sourceRoot and HTML treats report instructions as text',async t=>{
  const args=await fixture(t);args.input[0].path='/old/theme/sections/a.liquid';args.metadata.sourceRoot='/old/theme';
  args.input[0].offenses[0].message='<script>publish()</script>';
  const result=await importCheck(args),html=renderReport(result);assert.equal(result.findings[0].file,'sections/a.liquid');assert.ok(!html.includes('<script>publish()'));assert.ok(html.includes('&lt;script&gt;'));
});
test('CLI imports aggregate observations with review exit and refuses output overwrite',async t=>{
  const args=await fixture(t);const input=path.join(args.project,'observations.json'),out=path.join(args.project,'report.json');
  await writeFile(input,JSON.stringify({schemaVersion:1,kind:'check-observations',findings:[{ruleId:'ImgLazyLoading',severity:'suggestion',count:255,message:'Reported'}]}));
  const cli=new URL('../scripts/perfkit.mjs',import.meta.url).pathname;
  const run=()=>spawnSync(process.execPath,[cli,'import-check','--project',args.project,'--input',input,'--out',out],{encoding:'utf8'});
  assert.equal(run().status,3);assert.equal(JSON.parse(await readFile(out,'utf8')).summary.reportedOccurrences,255);assert.equal(run().status,2);
});
