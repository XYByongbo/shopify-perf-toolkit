import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../scripts/perfkit.mjs', import.meta.url));
const source = '<img src="{{ section.settings.image | image_url: width: 900 }}" alt="Keep me" loading="lazy">\n{% schema %}{"name":"Original"}{% endschema %}\n';
const run = (...args) => spawnSync(process.execPath, [cli, ...args], {encoding:'utf8'});

async function siteFixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'perfkit-site-cli-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project=path.join(root,'theme');
  const originals={'assets/theme.js':'export const ready = true;\n','assets/theme.css':'.hero { color: blue; }\n','sections/image.liquid':source};
  for(const [target,contents] of Object.entries(originals)) {
    await fs.mkdir(path.dirname(path.join(project,target)),{recursive:true});
    await fs.writeFile(path.join(project,target),contents);
  }
  await fs.mkdir(path.join(root,'reviewed'));
  await fs.writeFile(path.join(root,'reviewed/theme.js'),'export const ready = false;\n');
  const context={reason:'Reviewed synthetic replacement for CLI contract testing.',evidence:{summary:'Synthetic fixture; no storefront performance or behavior claim.'}};
  const recipe=path.join(root,'recipe.json'),plan=path.join(root,'plan.json');
  await fs.writeFile(recipe,JSON.stringify({schemaVersion:1,changes:[
    {target:'assets/theme.js',kind:'reviewed-replacement',replacementFile:'reviewed/theme.js',...context},
    {target:'assets/theme.css',kind:'reviewed-replacement',replacementText:'.hero { color: green; }\n',...context},
    {target:'sections/image.liquid',kind:'image-responsive',sourceIndex:0,sizes:'100vw',widths:[320,640],...context},
  ]}));
  const planned=run('plan-site','--project',project,'--recipe',recipe,'--out',plan);
  assert.equal(planned.status,0,planned.stderr);
  const body=JSON.parse(await fs.readFile(plan,'utf8'));
  assert.equal(body.kind,'site-change-plan');
  assert.equal(body.changes.length,3);
  for(const [target,contents] of Object.entries(originals)) assert.equal(await fs.readFile(path.join(project,target),'utf8'),contents);
  return {root,project,plan,body,originals};
}

async function receiptRaceRunner(root,mode='race') {
  const preload=path.join(root,'receipt-race.mjs');
  // Simulate another process claiming the output after the writability probe.
  // Theme operations remain real; the final exclusive receipt write gets EEXIST.
  await fs.writeFile(preload,`import fs from 'node:fs/promises';
import path from 'node:path';
const write=fs.writeFile;
fs.writeFile=async function(file,...args) {
  if(path.resolve(String(file))===process.env.PERFKIT_TEST_RECEIPT) {
    if(process.env.PERFKIT_TEST_OUTPUT_FAILURE==='partial') {
      await write(file,'{"partial":',{flag:'wx'});
      throw Object.assign(new Error('Simulated disk full while saving receipt.'),{code:'ENOSPC'});
    }
    await write(file,'concurrent output',{flag:'wx'});
  }
  return write(file,...args);
};\n`);
  return (output,...args)=>spawnSync(process.execPath,['--import',preload,cli,...args,'--out',output],{encoding:'utf8',env:{...process.env,PERFKIT_TEST_RECEIPT:output,PERFKIT_TEST_OUTPUT_FAILURE:mode}});
}

test('CLI executes when invoked through a symlink or aliased temporary path', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'perfkit-entry-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const alias=path.join(root,'perfkit.mjs');
  await fs.symlink(cli,alias);
  const result=spawnSync(process.execPath,[alias,'--help'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/Shopify Perf Toolkit/);
  assert.match(result.stdout,/score-target/);
});

test('CLI inspect, plan, report, apply and rollback preserve source and fail before overwriting receipts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'perfkit-cli-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const project = path.join(root, 'theme');
  await fs.mkdir(path.join(project, 'sections'), {recursive:true});
  const file = path.join(project, 'sections/image.liquid');
  await fs.writeFile(file, source);
  const inspection = path.join(root,'inspection.json'), plan = path.join(root,'plan.json');
  assert.equal(run('inspect','--project',project,'--target','sections/image.liquid','--out',inspection).status, 0);
  assert.equal(run('plan-image','--project',project,'--target','sections/image.liquid','--inspection',inspection,'--image','0','--sizes','100vw','--widths','320,640','--out',plan).status, 0);
  assert.equal(await fs.readFile(file,'utf8'), source);
  const html = path.join(root, 'inspection.html');
  assert.equal(run('report','--input',inspection,'--out',html).status, 0);
  assert.match(await fs.readFile(html,'utf8'), /<!doctype html>/i);
  const occupied = path.join(root, 'receipt.json');
  await fs.writeFile(occupied, 'retain');
  assert.equal(run('apply','--project',project,'--plan',plan,'--out',occupied).status, 2);
  assert.equal(await fs.readFile(file,'utf8'), source);
  assert.equal(await fs.readFile(occupied,'utf8'), 'retain');
  const applied = run('apply','--project',project,'--plan',plan);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).status, 'applied');
  const changed = await fs.readFile(file,'utf8');
  assert.match(changed, /srcset=/);
  assert.match(changed, /alt="Keep me" loading="lazy"/);
  assert.equal(JSON.parse(run('apply','--project',project,'--plan',plan).stdout).status, 'already-applied');
  await fs.appendFile(file, '<!-- concurrent editor -->');
  assert.equal(run('rollback','--project',project,'--plan',plan).status, 2);
  assert.match(await fs.readFile(file,'utf8'), /concurrent editor/);
  await fs.writeFile(file, changed);
  assert.equal(JSON.parse(run('rollback','--project',project,'--plan',plan).stdout).status, 'rolled-back');
  assert.equal(await fs.readFile(file,'utf8'), source);
});

test('CLI plan-site, apply and rollback preserve every file and save complete multi-file receipts', async t => {
  const {root,project,plan,body,originals}=await siteFixture(t);
  const appliedPath=path.join(root,'receipts','applied.json');
  const applied=run('apply','--project',project,'--plan',plan,'--out',appliedPath);
  assert.equal(applied.status,0,applied.stderr);
  assert.equal(JSON.parse(applied.stdout).output,appliedPath);
  const appliedReceipt=JSON.parse(await fs.readFile(appliedPath,'utf8'));
  assert.equal(appliedReceipt.kind,'site-change-receipt');
  assert.equal(appliedReceipt.completed,true);
  assert.equal(appliedReceipt.status,'applied');
  assert.equal(appliedReceipt.files.length,3);
  for(const entry of body.changes) assert.equal(await fs.readFile(path.join(project,entry.target),'utf8'),entry.after);
  assert.deepEqual(await fs.readdir(path.dirname(appliedPath)),['applied.json']);
  const repeat=run('apply','--project',project,'--plan',plan);
  assert.equal(repeat.status,0,repeat.stderr);
  assert.equal(JSON.parse(repeat.stdout).status,'already-applied');
  const rollbackPath=path.join(root,'receipts','rolled-back.json');
  const rolledBack=run('rollback','--project',project,'--plan',plan,'--out',rollbackPath);
  assert.equal(rolledBack.status,0,rolledBack.stderr);
  const receipt=JSON.parse(await fs.readFile(rollbackPath,'utf8'));
  assert.equal(receipt.completed,true);
  assert.equal(receipt.status,'rolled-back');
  assert.equal(receipt.files.length,3);
  for(const [target,contents] of Object.entries(originals)) assert.equal(await fs.readFile(path.join(project,target),'utf8'),contents);
});

test('CLI checks receipt directory writability before applying or rolling back source', async t => {
  const {root,project,plan,body,originals}=await siteFixture(t);
  const directory=path.join(root,'readonly');
  await fs.mkdir(directory);
  try {
    await fs.chmod(directory,0o555);
    const writable=await fs.access(directory,2).then(()=>true,()=>false);
    if(writable) return t.skip('This environment bypasses directory write permissions.');
    const applied=run('apply','--project',project,'--plan',plan,'--out',path.join(directory,'apply.json'));
    assert.equal(applied.status,2,applied.stderr);
    assert.match(applied.stderr,/EACCES|EPERM/);
    assert.equal(applied.stdout,'');
    for(const [target,contents] of Object.entries(originals)) assert.equal(await fs.readFile(path.join(project,target),'utf8'),contents);
    const setup=run('apply','--project',project,'--plan',plan);
    assert.equal(setup.status,0,setup.stderr);
    const rolledBack=run('rollback','--project',project,'--plan',plan,'--out',path.join(directory,'rollback.json'));
    assert.equal(rolledBack.status,2,rolledBack.stderr);
    assert.match(rolledBack.stderr,/EACCES|EPERM/);
    assert.equal(rolledBack.stdout,'');
    for(const entry of body.changes) assert.equal(await fs.readFile(path.join(project,entry.target),'utf8'),entry.after);
  } finally { await fs.chmod(directory,0o755); }
});

test('CLI preserves successful apply and rollback receipts on stdout when a concurrent writer claims --out', async t => {
  const {root,project,plan,body,originals}=await siteFixture(t);
  const racedRun=await receiptRaceRunner(root);
  for(const direction of ['apply','rollback']) {
    const output=path.join(root,`${direction}-receipt.json`);
    const result=racedRun(output,direction,'--project',project,'--plan',plan);
    assert.equal(result.status,2,result.stderr);
    const receipt=JSON.parse(result.stdout);
    assert.equal(receipt.kind,'site-change-receipt');
    assert.equal(receipt.completed,true);
    assert.equal(receipt.direction,direction);
    assert.equal(receipt.status,direction==='apply'?'applied':'rolled-back');
    assert.equal(receipt.files.length,3);
    assert.equal(receipt.planHash,body.planHash);
    const diagnostic=JSON.parse(result.stderr.trim());
    assert.equal(diagnostic.code,'RECEIPT_OUTPUT_FAILED');
    assert.equal(diagnostic.outputError.code,'EEXIST');
    assert.equal(diagnostic.output,output);
    assert.match(diagnostic.error,/complete receipt is on stdout/);
    assert.equal(await fs.readFile(output,'utf8'),'concurrent output');
    for(const entry of body.changes) assert.equal(await fs.readFile(path.join(project,entry.target),'utf8'),direction==='apply'?entry.after:originals[entry.target]);
  }
});

test('CLI preserves failed site receipts and both errors when receipt output also fails', async t => {
  for(const direction of ['apply','rollback']) {
    const {root,project,plan,body,originals}=await siteFixture(t);
    if(direction==='rollback') {
      const applied=run('apply','--project',project,'--plan',plan);
      assert.equal(applied.status,0,applied.stderr);
    }
    const target=body.changes[0].target;
    const drift=(direction==='apply'?originals[target]:body.changes[0].after)+'// concurrent edit\n';
    await fs.writeFile(path.join(project,target),drift);
    const savedOutput=path.join(root,'saved-failure-receipt.json');
    const savedFailure=run(direction,'--project',project,'--plan',plan,'--out',savedOutput);
    assert.equal(savedFailure.status,2,savedFailure.stderr);
    assert.equal(JSON.parse(savedFailure.stdout).output,savedOutput);
    assert.equal(JSON.parse(savedFailure.stderr).code,'SOURCE_DRIFT');
    assert.equal(JSON.parse(await fs.readFile(savedOutput,'utf8')).status,'preflight-failed');
    const failureMode=direction==='apply'?'race':'partial';
    const racedRun=await receiptRaceRunner(root,failureMode);
    const output=path.join(root,'failure-receipt.json');
    const result=racedRun(output,direction,'--project',project,'--plan',plan);
    assert.equal(result.status,2,result.stderr);
    const receipt=JSON.parse(result.stdout);
    assert.equal(receipt.kind,'site-change-receipt');
    assert.equal(receipt.direction,direction);
    assert.equal(receipt.completed,false);
    assert.equal(receipt.status,'preflight-failed');
    assert.equal(receipt.error.code,'SOURCE_DRIFT');
    assert.equal(receipt.planHash,body.planHash);
    const diagnostics=result.stderr.trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(diagnostics.length,2);
    assert.equal(diagnostics[0].code,'RECEIPT_OUTPUT_FAILED');
    assert.equal(diagnostics[0].outputError.code,failureMode==='race'?'EEXIST':'ENOSPC');
    assert.equal(diagnostics[1].code,'SOURCE_DRIFT');
    assert.equal(diagnostics[1].error,receipt.error.message);
    assert.equal(await fs.readFile(output,'utf8'),failureMode==='race'?'concurrent output':'{"partial":');
    assert.equal(await fs.readFile(path.join(project,target),'utf8'),drift);
    for(const entry of body.changes.slice(1)) assert.equal(await fs.readFile(path.join(project,entry.target),'utf8'),direction==='apply'?entry.before:entry.after);
  }
});

test('CLI also retains single-file operation receipts after output races', async t => {
  const {root,project,body}=await siteFixture(t);
  const plan=path.join(root,'single-plan.json');
  const entry=body.changes.find(change=>change.recipeKind==='image-responsive');
  await fs.writeFile(plan,JSON.stringify(entry));
  const racedRun=await receiptRaceRunner(root);
  for(const direction of ['apply','rollback']) {
    const output=path.join(root,`single-${direction}.json`);
    const result=racedRun(output,direction,'--project',project,'--plan',plan);
    assert.equal(result.status,2,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),{target:entry.target,beforeHash:entry.beforeHash,afterHash:entry.afterHash,planId:entry.id,status:direction==='apply'?'applied':'rolled-back'});
    assert.equal(JSON.parse(result.stderr).outputError.code,'EEXIST');
    assert.equal(await fs.readFile(path.join(project,entry.target),'utf8'),direction==='apply'?entry.after:entry.before);
  }
});

test('CLI doctor discovers installed Chrome and validates explicit executable overrides', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'perfkit-doctor-cli-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const fakeCLI=path.join(root,'lighthouse.mjs');
  await fs.writeFile(fakeCLI,'// Not launched: doctor only checks configured prerequisites.\n');
  const env={...process.env,PERF_KIT_LIGHTHOUSE_CLI:fakeCLI};
  delete env.PERF_KIT_BROWSER_EXECUTABLE;
  delete env.CHROME_PATH;
  const diagnose=overrides=>{
    const result=spawnSync(process.execPath,[cli,'doctor'],{encoding:'utf8',env:{...env,...overrides}});
    assert.equal(result.status,0,result.stderr);
    return JSON.parse(result.stdout).measurement;
  };
  const absent=diagnose({});
  if(process.platform==='win32') {
    assert.equal(absent.available,false);
    assert.match(absent.reason,/macOS or Linux/);
    return;
  }
  if(absent.available) { assert.equal(path.isAbsolute(absent.chrome),true); await fs.access(absent.chrome,1); assert.equal(absent.launchVerified,false); }
  else assert.match(absent.reason,/Chrome|Chromium|PERF_KIT_BROWSER_EXECUTABLE|Browser/);
  assert.equal(diagnose({CHROME_PATH:'relative/chrome'}).available,false);
  assert.equal(diagnose({CHROME_PATH:root}).available,false);
  assert.equal(diagnose({CHROME_PATH:fakeCLI}).available,false);
  const configured=diagnose({CHROME_PATH:process.execPath});
  assert.equal(configured.available,true);
  assert.equal(configured.chrome,process.execPath);
  assert.equal(configured.launchVerified,false);
  assert.equal(diagnose({CHROME_PATH:process.execPath,PERF_KIT_BROWSER_EXECUTABLE:''}).available,false);
});

test('CLI rejects ambiguous flags and reports incomparable verification as nonzero', async t => {
  assert.equal(run('inspect','--project','x','--project','y').status, 2);
  assert.equal(run('apply','--prject','x').status, 2);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'perfkit-cli-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const input = path.join(root,'malformed.json');
  await fs.writeFile(input,'{}');
  const result = run('verify','--before',input,'--after',input);
  assert.equal(result.status, 3);
  assert.equal(JSON.parse(result.stdout).outcome, 'not-comparable');
});

test('CLI score-target propagates passing, failing, warning and invalid-input decisions from synthetic reports', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'perfkit-score-cli-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const before = path.join(root, 'before'), after = path.join(root, 'after');
  // Synthetic fixtures exercise the CLI contract; these are not store measurements.
  for(const [directory, scores, offset] of [[before,[50,50,50,50,50],0],[after,[75,79,80,81,85],10]]) {
    await fs.mkdir(directory);
    for(const [index, score] of scores.entries()) {
      const report = {
        lighthouseVersion:'synthetic-fixture',fetchTime:`2026-10-16T00:${String(index+offset).padStart(2,'0')}:00Z`,
        requestedUrl:'https://example.test/products/example',finalDisplayedUrl:'https://example.test/products/example',
        userAgent:'Synthetic fixture HeadlessChrome/130.0.0.0',configSettings:{formFactor:'mobile',throttlingMethod:'simulate',throttling:{rttMs:150,throughputKbps:1638.4,cpuSlowdownMultiplier:4}},
        categories:{performance:{score:score/100}},runWarnings:[],
        audits:Object.fromEntries([['first-contentful-paint',1000],['largest-contentful-paint',2000],['cumulative-layout-shift',0.05],['total-blocking-time',100]].map(([key,numericValue])=>[key,{numericValue}]))
      };
      await fs.writeFile(path.join(directory,`${index}.json`),JSON.stringify(report));
    }
  }
  const args = ['score-target','--before',before,'--after',after];
  const output = path.join(root,'accepted.json');
  const accepted = run(...args,'--out',output);
  assert.equal(accepted.status,0,accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).score_target_met,true);
  assert.deepEqual(JSON.parse(await fs.readFile(output,'utf8')),JSON.parse(accepted.stdout));
  assert.equal(run(...args,'--out',output).status,2);
  const failed = run(...args,'--minimum','85','--target','90');
  assert.equal(failed.status,3,failed.stderr);
  assert.equal(JSON.parse(failed.stdout).status,'failed');
  assert.equal(run(...args,'--out',path.join(after,'nested','output.json')).status,2);
  const file = path.join(after,'0.json');
  const warning = JSON.parse(await fs.readFile(file,'utf8'));
  warning.runWarnings=['Synthetic warning requiring review'];
  await fs.writeFile(file,JSON.stringify(warning));
  const review = run(...args);
  assert.equal(review.status,3,review.stderr);
  assert.equal(JSON.parse(review.stdout).status,'review-required');
  assert.equal(run('score-target','--before',before).status,2);
  for(const directory of [before,after]) {
    for(const name of await fs.readdir(directory)) {
      const fixturePath=path.join(directory,name);
      const report=JSON.parse(await fs.readFile(fixturePath,'utf8'));
      report.configSettings.formFactor='desktop';
      report.runWarnings=[];
      if(directory===after) report.categories.performance.score+=0.1;
      await fs.writeFile(fixturePath,JSON.stringify(report));
    }
  }
  const desktop=run(...args);
  assert.equal(desktop.status,0,desktop.stderr);
  assert.deepEqual(JSON.parse(desktop.stdout).thresholds,{minimum_each_after_run:85,target_after_median:90});
});
