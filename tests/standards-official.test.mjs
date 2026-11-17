import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {runBatch} from '../lib/batch.mjs';
import {auditSite} from '../lib/site-audit.mjs';
import {auditQuality} from '../lib/quality-audit.mjs';
import {siteRun} from './helpers/site-run.mjs';

test('batch runs installed Shopify Theme Check and keeps official findings separate from formal scores',{skip:process.env.PERF_KIT_THEME_CHECK_TESTS!=='1',timeout:120000},async t=>{
  const root=await mkdtemp('/private/tmp/perfkit-standards-official-');t.after(()=>rm(root,{recursive:true,force:true}));
  const project=root+'/theme', output=root+'/batch';
  const source='<!doctype html><html><head>{{ content_for_header }}</head><body><img src="/image.png" alt="Fixture">{{ content_for_layout }}</body></html>';
  const configuration='extends: theme-check:recommended\nAssetSizeCSS:\n  enabled: true\n  thresholdInBytes: 100000\nAssetSizeJavaScript:\n  enabled: true\n  thresholdInBytes: 10000\n';
  await mkdir(project+'/layout',{recursive:true});
  await writeFile(project+'/layout/theme.liquid',source);
  await writeFile(project+'/.theme-check.yml',configuration);
  const before=await siteRun(t,{devices:['mobile'],scores:{mobile:[82]}});
  const after=await siteRun(t,{devices:['mobile'],scores:{mobile:[89]},offset:20});
  const batch=await runBatch({config:{schemaVersion:1,project,checks:{run:true},resources:false,quality:true,
    before:before.root,run:after.root},output});
  let failure = batch.error;
  if (batch.status !== 'complete') {
    try {
      const report = JSON.parse(await readFile(output+'/checks-failure.json','utf8'));
      failure = {...batch.error,commands:report.commands?.map(c=>({args:c.args,exitCode:c.exitCode,
        stdout:c.stdout.slice(0,1000),stderr:c.stderr.slice(0,3000)}))};
    } catch { /* Keep the original batch error when no transport report was saved. */ }
  }
  assert.equal(batch.status,'complete',JSON.stringify(failure));
  assert.equal(batch.acceptance,'score-targets-met');
  assert.equal(batch.diagnostics.checks.status,'review-required');
  assert.equal(batch.reviewRequired,true);
  const result=JSON.parse(await readFile(output+'/checks.json','utf8'));
  assert.equal(result.complete,true);
  assert.ok(result.requiredChecks.every(c=>c.status==='enabled'),JSON.stringify(result.requiredChecks));
  assert.equal(result.execution.commands.length,5);
  assert.match(result.metadata.rulesConfig.effectiveConfiguration,/thresholdInBytes: 100000/);
  assert.ok(result.findings.some(f=>f.ruleId==='ImgWidthAndHeight'&&f.file==='layout/theme.liquid'));
  assert.equal(await readFile(project+'/layout/theme.liquid','utf8'),source);
  assert.equal(await readFile(project+'/.theme-check.yml','utf8'),configuration);
  const audit=JSON.parse(await readFile(output+'/audit.json','utf8'));
  assert.equal(audit.supplemental.find(s=>s.kind==='check-import')?.status,'current-source');
  const html=await readFile(output+'/audit.html','utf8');
  assert.match(html,/Shopify 官方 Theme Check/);
  assert.match(html,/ImgWidthAndHeight/);
  const quality=JSON.parse(await readFile(output+'/quality.json','utf8'));
  assert.equal(quality.summary.checkerCurrent,true);
  await writeFile(project+'/.theme-check.yml',configuration.replace('100000','200000'));
  const stale=await auditSite({project,run:after.root,checks:result});
  assert.equal(stale.supplemental.find(s=>s.kind==='check-import')?.status,'stale');
  assert.equal(stale.supplemental.find(s=>s.kind==='performance-audit')?.report.intelligence.waivers.sourceStatus,'stale-or-incomplete-checker-report');
  assert.equal((await auditQuality({project,checks:result})).summary.checkerCurrent,false);
});
