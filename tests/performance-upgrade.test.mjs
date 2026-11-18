import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, cp } from 'node:fs/promises';
import path from 'node:path';
import { Liquid } from 'liquidjs';
import { transformCode } from '../lib/code-strategies.mjs';
import { codeStrategies } from '../lib/code-strategy-catalog.mjs';
import { evaluateGain } from '../lib/performance-gain.mjs';
import { verifySite } from '../lib/site-verify.mjs';
import { siteRun, changeReport, saveManifest, regressionForRun } from './helpers/site-run.mjs';
import { createSitePlan, applySitePlan, rollbackSitePlan } from '../lib/site-changes.mjs';
import { sourceSnapshot, sha256, coverageSummary, lcpBreakdown, mapRuntimeSource } from '../lib/runtime-profile.mjs';
import { analyzeLiquidProfile, profileLiquid } from '../lib/liquid-profile.mjs';
import { createSplitPlan } from '../lib/split-plan.mjs';
import { estimateScoreImpact, scoreLosses } from '../lib/score-impact.mjs';
import { checkRunDeployment } from '../lib/deployment.mjs';
import { verifyOptimization, runOptimization } from '../lib/optimize.mjs';
import { runBatch } from '../lib/batch.mjs';

async function theme(t, files) {
  const root = await mkdtemp('/private/tmp/perfkit-upgrade-'); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'assets'));
  for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
  return root;
}
function transform(source, target, kind, parameters) {
  const flags = Object.fromEntries(codeStrategies.find(x => x.kind === kind).evidenceRequired.map(k => [k, true]));
  return transformCode({ source, target, kind, parameters, evidence: { ...flags, sourceHash: sha256(source), summary: 'Synthetic behavior regression fixture.' } });
}
test('a 95 to 80 regression cannot pass original score verification or optimization', async t => {
  const before = await siteRun(t, { devices: ['mobile'], scores: { mobile: [95] } }), after = await siteRun(t, { devices: ['mobile'], scores: { mobile: [80] }, offset: 10 });
  const result = await verifySite({ before: before.root, after: after.root });
  assert.equal(result.scoreTargetOutcome, 'score-targets-met'); assert.equal(result.outcome, 'performance-regressed');
  assert.equal((await verifyOptimization({ before: before.root, after: after.root })).outcome, 'not-accepted');
});
test('score gain cannot conceal CLS/TBT regression; unchanged and noisy samples do not establish gain', async t => {
  const before = await siteRun(t, { devices: ['mobile'] });
  const unchanged = await siteRun(t, { devices: ['mobile'], offset: 10 });
  assert.equal((await evaluateGain({ before: before.root, after: unchanged.root })).outcome, 'no-measurable-gain');
  const after = await siteRun(t, { devices: ['mobile'], offset: 20, scores: { mobile: [95] }, augment: r => { r.audits['cumulative-layout-shift'].numericValue = 0.25; } });
  assert.equal((await evaluateGain({ before: before.root, after: after.root })).outcome, 'performance-regressed');
  const noisy = await siteRun(t, { devices: ['mobile'], offset: 30, scores: { mobile: [70,80,84,90,98] } });
  assert.equal((await evaluateGain({ before: before.root, after: noisy.root })).outcome, 'no-measurable-gain');
  await changeReport(after, r => { r.fetchTime = '2026-10-16T00:00:00.000Z'; });
  assert.equal((await evaluateGain({ before: before.root, after: after.root })).outcome, 'invalid-evidence');
});
test('weighted lost points and nonlinear score gain are version bound, never byte rankings', () => {
  const report = { lighthouseVersion: '13.5.0', configSettings: { formFactor: 'mobile' }, categories: { performance: { auditRefs: [{ id: 'largest-contentful-paint', weight: 25 }, { id: 'total-blocking-time', weight: 30 }, { id: 'cumulative-layout-shift', weight: 25 }, { id: 'first-contentful-paint', weight: 10 }, { id: 'speed-index', weight: 10 }] } },
    audits: { 'largest-contentful-paint': { score: 0.5, numericValue: 4000 }, 'total-blocking-time': { score: 0.1, numericValue: 1200 } } };
  assert.equal(scoreLosses(report)[0].metric, 'TBT'); assert.equal(scoreLosses(report)[0].lostPoints, 27);
  assert.ok(estimateScoreImpact(report, { LCP: 1500 }).estimatedPoints > 8);
  report.lighthouseVersion = 'unknown-future'; assert.equal(estimateScoreImpact(report, { LCP: 1500 }).estimatedPoints, null);
});
test('coverage unions UTF-16 ranges and reports UTF-8 bytes separately; CDN identity needs exact bytes', () => {
  const c = coverageSummary({ url: 'https://cdn.shopify.com/a.js', text: '你好abc', ranges: [{ start: 0, end: 2 }, { start: 1, end: 3 }] });
  assert.equal(c.usedUnits, 3); assert.equal(c.usedBytes, 7); assert.equal(c.totalBytes, 9);
  const snapshot = { files: [{ file: 'assets/a.js', sourceHash: sha256('hello') }] };
  assert.equal(mapRuntimeSource('https://cdn.shopify.com/a.js', sha256('hello'), snapshot).status, 'verified-bytes');
  assert.equal(mapRuntimeSource('https://cdn.shopify.com/a.js', sha256('other'), snapshot).status, 'unmapped');
  assert.equal(lcpBreakdown({ lcp: { url: 'https://cdn/a.png', startTime: 1000 }, navigation: { responseStart: 100 }, resources: [{ name: 'https://cdn/a.png', requestStart: 0, responseStart: 0 }] }).loadDurationMs, null);
});
test('new asset plans apply, roll back, reject drift, preflight all files and refuse symlinks', async t => {
  const project = await theme(t, { 'assets/main.js': 'const a = 1;' });
  const create = { kind: 'create-asset', target: 'assets/lazy.js', replacementText: 'export const lazy = true;', reason: 'Split component', evidence: { summary: 'Synthetic regression fixture' } };
  const plan = await createSitePlan({ project, recipe: { schemaVersion: 1, changes: [create] } });
  await applySitePlan(plan, project); assert.equal(await readFile(path.join(project, create.target), 'utf8'), create.replacementText);
  await assert.rejects(applySitePlan(plan, project), { code: 'TARGET_EXISTS' });
  await writeFile(path.join(project, create.target), 'export const edited = true;');
  await assert.rejects(rollbackSitePlan(plan, project), { code: 'SOURCE_DRIFT' });
  await writeFile(path.join(project, create.target), create.replacementText); await rollbackSitePlan(plan, project);
  await assert.rejects(readFile(path.join(project, create.target)), { code: 'ENOENT' });
  assert.equal((await rollbackSitePlan(plan, project)).completed, true);
  await symlink(path.join(project, 'assets/main.js'), path.join(project, create.target));
  await assert.rejects(applySitePlan(plan, project));
  await assert.rejects(createSitePlan({ project, recipe: { schemaVersion: 1, changes: [{ ...create, target: 'snippets/new.liquid' }] } }), { code: 'INVALID_NEW_ASSET' });
});
test('parsed script changes preserve content_for_header and schema while rejecting unsafe scheduling', async t => {
  const source = '<head>\n{{ content_for_header }}\n<script src="{{ \'heavy.js\' | asset_url }}"></script>\n</head>';
  const start = source.indexOf('<script');
  const after = transform(source, 'layout/theme.liquid', 'liquid-defer-script', { tagStart: start }).after;
  assert.ok(after.includes(' defer>')); assert.ok(after.includes('{{ content_for_header }}'));
  const project = await theme(t, { 'layout/theme.liquid': source });
  const result = transform(source, 'layout/theme.liquid', 'liquid-scope-resource', { tagStart: start, pageTypes: ['product'] });
  const plan = await createSitePlan({ project, recipe: { schemaVersion: 1, changes: [{ kind: 'reviewed-replacement', target: 'layout/theme.liquid', replacementText: result.after, reason: 'Product component only', evidence: { summary: 'Validated all page states in fixture.' } }] } });
  await applySitePlan(plan, project); await rollbackSitePlan(plan, project);
  for (const tag of ['<script async src="a.js"></script>', '<script src="a.js">useDependency()</script>']) assert.throws(() => transform(tag, 'snippets/x.liquid', 'liquid-defer-script', { tagStart: 0 }));
});
test('loop caching preserves rendered output and empty-loop variable scope across whitespace forms', async () => {
  const liquid = new Liquid();
  for (const trim of [false, true]) {
    const open = trim ? '{%-' : '{%', close = trim ? '-%}' : '%}';
    const source = ` A ${open} for p in collection.products ${close}\n ${open} assign title = settings.title | upcase ${close}[{{title}}:{{p}}]${open} endfor ${close} B {{title}}`;
    const start = source.indexOf(`${open} assign`), after = transform(source, 'sections/products.liquid', 'liquid-cache-loop-filter', { assignStart: start }).after;
    for (const products of [[], ['a'], ['a','b','c']]) {
      const data = { title: 'existing', settings: { title: 'test' }, collection: { products } };
      assert.equal(await liquid.parseAndRender(after, structuredClone(data)), await liquid.parseAndRender(source, structuredClone(data)));
    }
  }
  const unsafe = '{% for p in collection.products %}{% assign a = p.title | upcase %}{{a}}{% endfor %}';
  assert.throws(() => transform(unsafe, 'sections/p.liquid', 'liquid-cache-loop-filter', { assignStart: unsafe.indexOf('{% assign') }));
});
test('Liquid profiles preserve self versus inclusive cost and refuse malformed stacks/units', () => {
  const data = { shared: { frames: [{ name: 'sections/main.liquid:2' }, { name: 'snippets/card.liquid:7' }] }, profiles: [{ name: 'fixture', type: 'evented', unit: 'microseconds', startValue: 0, endValue: 10000,
    events: [{ type: 'O', at: 0, frame: 0 }, { type: 'O', at: 2000, frame: 1 }, { type: 'C', at: 8000, frame: 1 }, { type: 'C', at: 10000, frame: 0 }] }] };
  const result = analyzeLiquidProfile(data, { files: [{ file: 'snippets/card.liquid', sourceHash: 'fixture' }] });
  assert.equal(result.totalSelfMs, 10); assert.equal(result.hotspots[0].selfMs, 6); assert.equal(result.hotspots[1].inclusiveMs, 10);
  assert.equal(result.hotspots[0].line, 7);
  const bad = structuredClone(data); bad.profiles[0].events[2].frame = 0; assert.throws(() => analyzeLiquidProfile(bad));
  bad.profiles[0].unit = 'bytes'; assert.throws(() => analyzeLiquidProfile(bad));
});
test('CSS splitting produces a reversible multi-file plan with protected header and JS-disabled fallback', async t => {
  const css = '.hero { color: red; }\n.footer { color: blue; }';
  const loader = '<head>\n{{ content_for_header }}\n<link rel="stylesheet" href="{{ \'theme.css\' | asset_url }}">\n</head>';
  const project = await theme(t, { 'assets/theme.css': css, 'layout/theme.liquid': loader });
  const plan = await createSplitPlan({ project, config: { schemaVersion: 1, mode: 'css', source: 'assets/theme.css', newAsset: 'assets/deferred.css', loaderTarget: 'layout/theme.liquid', tagStart: loader.indexOf('<link'), criticalRuleStarts: [0], reason: 'Noncritical footer CSS',
    evidence: { summary: 'Synthetic state coverage fixture', sourceHash: sha256(css), loaderHash: sha256(loader), dependencyReview: true, allStatesCovered: true, cascadeAndOrderReviewed: true, inlineLoadHandlerAllowed: true } } });
  await applySitePlan(plan, project);
  assert.ok((await readFile(path.join(project, 'layout/theme.liquid'), 'utf8')).includes('<noscript>'));
  assert.ok(!(await readFile(path.join(project, 'assets/theme.css'), 'utf8')).includes('footer'));
  await rollbackSitePlan(plan, project); assert.equal(await readFile(path.join(project, 'assets/theme.css'), 'utf8'), css);
  await assert.rejects(readFile(path.join(project, 'assets/deferred.css')), { code: 'ENOENT' });
});
test('prepare/apply workflow saves reviewable plans and only applies an exact reviewed hash', async t => {
  const project = await theme(t, { 'assets/main.js': 'const count = 1;' });
  const output = await mkdtemp('/private/tmp/perfkit-workflow-'); t.after(() => rm(output, { recursive: true, force: true }));
  const config = { schemaVersion: 1, action: 'prepare', project, recipe: { schemaVersion: 1, changes: [{ kind: 'create-asset', target: 'assets/component.js', replacementText: 'export const a = 1;', reason: 'Fixture split', evidence: { summary: 'Fixture' } }] } };
  const prepared = await runOptimization({ config, output: path.join(output, 'prepare') }); assert.equal(prepared.status, 'review-required');
  const apply = { schemaVersion: 1, action: 'apply', project, plan: path.join(output, 'prepare/plan.json'), reviewedPlanHash: 'wrong' };
  assert.equal((await runOptimization({ config: apply, output: path.join(output, 'wrong') })).status, 'failed');
  apply.reviewedPlanHash = prepared.planHash;
  assert.equal((await runOptimization({ config: apply, output: path.join(output, 'apply') })).status, 'awaiting-preview-sync');
  assert.equal(checkRunDeployment({ manifest: { config: { pages: [] } } }).status, 'unverified');
});

test('strict optimization acceptance needs changed verified source, all sample groups, behavior and visual evidence', async t => {
  const before = await siteRun(t, { devices: ['mobile'], scores: { mobile: [70] } }), after = await siteRun(t, { devices: ['mobile'], scores: { mobile: [85] }, offset: 10 });
  async function identity(fixture, body, themeId) {
    const sourceManifest = [{ file: 'assets/theme.js', sourceHash: sha256(body) }], sourceHash = sha256(JSON.stringify(sourceManifest));
    const proof = { kind: 'deployment-proof', status: 'verified', scope: 'theme-text-source', method: 'shopify-cli-source-pull-and-browser-theme-id', sourceManifest, sourceHash, remoteSourceHash: sourceHash,
      project: '/synthetic/theme', store: 'fixture.myshopify.com', themeId, pages: fixture.manifest.config.pages.map(p => ({ ...p, status: 'verified', store: 'fixture.myshopify.com', themeId })) };
    fixture.manifest.deployment = { before: { ...proof, startedAt: '2026-10-15T23:58:00Z', finishedAt: '2026-10-15T23:59:00Z' }, after: { ...proof, startedAt: '2026-10-17T00:00:00Z', finishedAt: '2026-10-17T00:01:00Z' } };
    fixture.manifest.startedAt = '2026-10-15T23:57:00Z'; fixture.manifest.finishedAt = '2026-10-17T00:02:00Z';
    fixture.manifest.config.deployment = { project: proof.project, store: proof.store, themeId };
    await saveManifest(fixture); return sourceHash;
  }
  await identity(before,'before','1'); const expectedSourceHash = await identity(after,'after','1');
  const args = { before: before.root, after: after.root, expectedSourceHash,
    regression: regressionForRun(after),
    review: { sourceHash: expectedSourceHash, contentPreserved: true, visualsPreserved: true, summary: 'Synthetic contract evidence, not real theme measurements.' } };
  assert.equal((await verifyOptimization(args)).outcome,'optimization-accepted');
  const variant = structuredClone(args.regression);
  variant.scenarios.runs[0].finalUrl += '&variant=123#details';
  assert.equal((await verifyOptimization({...args,regression:variant})).outcome,'optimization-accepted','Same-document query/hash state changes remain supported');
  assert.equal((await verifyOptimization({ ...args, expectedSourceHash: sha256('wrong') })).outcome,'not-accepted');
  assert.equal((await verifyOptimization({ ...args, regression: undefined })).outcome,'not-accepted');
  const project = await theme(t, {'assets/theme.js':'before'});
  const recipe = {schemaVersion:1,changes:[{kind:'reviewed-replacement',target:'assets/theme.js',replacementText:'after',reason:'Synthetic full plan gate',evidence:{summary:'Protocol fixture only'}}]};
  const plan = await createSitePlan({project,recipe});
  assert.equal((await verifyOptimization({...args,plan})).outcome,'optimization-accepted');
  const tampered = structuredClone(plan); tampered.changes[0].reason += ' altered';
  assert.equal((await verifyOptimization({...args,plan:tampered})).outcome,'invalid-evidence');
  await writeFile(path.join(project,'assets/theme.js'),'unrelated');
  const unrelated = await createSitePlan({project,recipe});
  const mismatch = await verifyOptimization({...args,plan:unrelated});
  assert.equal(mismatch.outcome,'not-accepted');
  assert.equal(mismatch.checks.find(c=>c.id==='plan-matches-measured-source').pass,false);
  for (const mutate of [
    r => { r.scenarios.sourceStable = false; },
    r => { r.remote.store = 'wrong.myshopify.com'; },
    r => { r.scenarios.runs[0].themeId = '999'; },
    r => { r.scenarios.runs[0].constrained = true; },
    r => { r.scenarios.runs[0].steps.push({action:'click',outcome:'failed'}); },
    r => { r.remote.startedAt = r.scenarios.createdAt; },
    r => { r.remote.pages = []; },
    r => { r.remote.sourceManifest = []; },
    r => { r.scenarios.runs[0].documentStable = false; },
    r => { r.scenarios.runs[0].finalUrl = 'https://other.example/'; },
    r => { r.scenarios.runs[0].store = 'other.myshopify.com'; },
    r => { r.scenarios.runs[0].steps[0].outcome = 'skipped'; },
    r => { r.scenarios.config.scenarios[0].steps.push({action:'assert-text',selector:'output',text:'missing'}); },
    r => { delete r.scenarios.finishedAt; },
  ]) {
    const regression = structuredClone(args.regression); mutate(regression);
    assert.notEqual((await verifyOptimization({...args,regression})).outcome,'optimization-accepted');
  }
  after.manifest.deployment.after.themeId='other'; await saveManifest(after);
  assert.equal((await verifyOptimization(args)).outcome,'not-accepted');
});

test('verify workflow shares attempt budget, measures exploration then formal candidate and requires matching regression', async t => {
  const project = await theme(t, { 'assets/main.js':'const value = 1;' }), snapshotBefore = await sourceSnapshot(project);
  const plan = await createSitePlan({ project, recipe: { schemaVersion:1, changes:[{target:'assets/main.js',kind:'reviewed-replacement',replacementText:'const value = 2;',reason:'Synthetic verification flow',evidence:{summary:'Contract fixture; not a store result.'}}] } });
  const root = await mkdtemp('/private/tmp/perfkit-verify-flow-'); t.after(()=>rm(root,{recursive:true,force:true}));
  const planFile=path.join(root,'plan.json');await writeFile(planFile,JSON.stringify(plan));await applySitePlan(plan,project);
  const snapshotAfter=await sourceSnapshot(project);
  const baseline=await siteRun(t,{devices:['mobile'],scores:{mobile:[70]}});
  const bind=async(f,snapshot)=>{
    const deployment={project,store:'fixture.myshopify.com',themeId:'123'};
    const proof={kind:'deployment-proof',status:'verified',scope:'theme-text-source',method:'shopify-cli-source-pull-and-browser-theme-id',...deployment,sourceHash:snapshot.hash,remoteSourceHash:snapshot.hash,sourceManifest:snapshot.files,pages:f.manifest.config.pages.map(p=>({...p,status:'verified',store:deployment.store,themeId:'123'}))};
    Object.assign(f.manifest,{startedAt:'2026-10-15T23:57:00Z',finishedAt:'2026-10-17T00:02:00Z',deployment:{before:{...proof,startedAt:'2026-10-15T23:58:00Z',finishedAt:'2026-10-15T23:59:00Z'},after:{...proof,startedAt:'2026-10-17T00:00:00Z',finishedAt:'2026-10-17T00:01:00Z'}}});
    f.manifest.config.deployment=deployment;await saveManifest(f);
  };
  await bind(baseline,snapshotBefore);
  const calls=[]; let regression,verifications=0;
  const measurement={schemaVersion:1,engine:'lighthouse',pages:baseline.manifest.config.pages,devices:['mobile'],runs:5,deployment:{project,store:'fixture.myshopify.com',themeId:'123'}};
  const config={schemaVersion:1,action:'verify',project,plan:planFile,reviewedPlanHash:plan.planHash,before:baseline.root,measurement,
    scenarios:{schemaVersion:1,url:measurement.pages[0].url,viewports:[{name:'mobile',width:390,height:844}],scenarios:[{name:'content',steps:[{action:'assert-text',selector:'main',text:'Fixture'}]}]},
    review:{sourceHash:snapshotAfter.hash,contentPreserved:true,visualsPreserved:true,summary:'Synthetic reviewer evidence.'}};
  const budgetConfig = {...config,measurement:{...measurement,devices:['mobile','desktop'],budget:{maxAttempts:10}}};
  const blocked = await runOptimization({config:budgetConfig,output:path.join(root,'budget-blocked'),dependencies:{
    measureSite:()=>assert.fail('Insufficient total budget must stop before exploration'),
  }});
  assert.equal(blocked.status,'stopped');
  assert.equal(blocked.error.code,'OPTIMIZATION_BUDGET');
  assert.equal(blocked.measurementStarted,false);
  assert.equal(blocked.budget.counts.attempted,0);
  assert.equal(blocked.samplingBudget.totalAttempts,16);
  const standardsBlocked = await runOptimization({
    config:{...budgetConfig,goal:{kind:'loading',metric:'lcp'},acceptancePolicy:'standards-v1'},
    output:path.join(root,'standards-budget-blocked'),
    dependencies:{measureSite:()=>assert.fail('Budget must stop before measurement')},
  });
  assert.equal(standardsBlocked.error.code,'OPTIMIZATION_BUDGET');
  assert.equal(standardsBlocked.budget.counts.attempted,0);
  assert.equal(standardsBlocked.artifacts['standards-preflight.json'],undefined);
  const exactBudget = {...config,measurement:{...measurement,budget:{maxAttempts:8}}};
  const result=await runOptimization({config:exactBudget,output:path.join(root,'verify'),dependencies:{
    verifyOptimization:async input=>{verifications++;return verifyOptimization(input);},
    measureSite:async({config:c,output})=>{
      calls.push(c);const f=await siteRun(t,{devices:['mobile'],reports:c.runs,offset:c.purpose==='exploration'?10:20,scores:{mobile:[85]}});
      f.manifest.config={...c};await bind(f,snapshotAfter);regression=regressionForRun(f);await cp(f.root,output,{recursive:true});return{status:'complete',counts:{attempted:c.runs,failed:0}};
    },runScenarios:async({config:c})=>{assert.equal(c.project,project);assert.equal(c.expectedThemeId,'123');return regression.scenarios;},
    verifyDeployment:async()=>regression.remote
  }});
  assert.equal(result.status,'optimization-accepted',JSON.stringify(result.error));assert.deepEqual(calls.map(c=>c.purpose),['exploration','acceptance']);
  assert.equal(calls[1].budget.maxAttempts,calls[0].budget.maxAttempts-3);assert.equal(result.budget.counts.attempted,8);assert.equal(verifications,1);
  for (const scenarios of [{...config.scenarios,project:'/wrong/project'}, {...config.scenarios,expectedThemeId:'999'}]) {
    const denied=await runOptimization({config:{...config,scenarios},output:path.join(root,`mismatch-${scenarios.expectedThemeId??'project'}`),dependencies:{
      measureSite:async()=>assert.fail('Mismatched regression must stop before measurement') }});
    assert.equal(denied.status,'failed');assert.match(denied.error.message,/project\/theme differs/);
  }
  const wrongMatrix = await runOptimization({
    config:{...config,measurement:{...measurement,pages:[{...measurement.pages[0],id:'other'}]},rollbackOnFailure:true},
    output:path.join(root,'wrong-matrix'),
    dependencies:{measureSite:()=>assert.fail('A different page/device matrix must stop before measurement')},
  });
  assert.match(wrongMatrix.error.message,/page\/device matrix must match the baseline/);
  assert.equal(wrongMatrix.measurementStarted,false);
  assert.equal(wrongMatrix.budget.counts.attempted,0);
  assert.equal(wrongMatrix.localRollback,'retained-pending-evidence');

  const missingBaseline = await runOptimization({
    config:{...config,before:path.join(root,'missing-baseline'),rollbackOnFailure:true},
    output:path.join(root,'missing-evidence'),
    dependencies:{measureSite:()=>assert.fail('Missing baseline must stop before measurement')},
  });
  assert.equal(missingBaseline.measurementStarted,false);
  assert.equal(missingBaseline.localRollback,'retained-pending-evidence');
  assert.equal((await sourceSnapshot(project)).hash,snapshotAfter.hash);

  const pending=await runOptimization({config:{...config,exploreFirst:false,rollbackOnFailure:true},output:path.join(root,'pending'),dependencies:{
    measureSite:async({config:c,output})=>{const f=await siteRun(t,{devices:['mobile'],offset:30,scores:{mobile:[85]}});
      f.manifest.config={...c};await bind(f,snapshotAfter);regression=regressionForRun(f);await cp(f.root,output,{recursive:true});return {status:'complete',counts:{attempted:5,failed:0}};},
    runScenarios:async()=>({...regression.scenarios,sourceStable:false}),verifyDeployment:async()=>regression.remote,
  }});
  assert.equal(pending.status,'not-accepted');
  assert.equal(pending.localRollback,'retained-pending-evidence');
  assert.equal((await sourceSnapshot(project)).hash,snapshotAfter.hash);
  assert.equal((await verifyOptimization({...pending.verificationInput,regression})).outcome,'optimization-accepted');

  const rejected = await runOptimization({config:{...config,exploreFirst:false,rollbackOnFailure:true},output:path.join(root,'rollback'),dependencies:{
    measureSite:async({config:c,output})=>{
      const f=await siteRun(t,{devices:['mobile'],offset:40,scores:{mobile:[50]}});
      f.manifest.config={...c};await bind(f,snapshotAfter);regression=regressionForRun(f);
      await cp(f.root,output,{recursive:true});return {status:'complete',counts:{attempted:5,failed:0}};
    },
    runScenarios:async()=>regression.scenarios,verifyDeployment:async()=>regression.remote,
  }});
  assert.equal(rejected.localRollback,'complete-preview-still-requires-sync');
  assert.equal((await sourceSnapshot(project)).hash,snapshotBefore.hash);
});
test('text identity includes protected config and ignores large media without exposing merchant settings', async t => {
  const project = await theme(t, { 'config/settings_data.json': '{"secret":"fixture-only"}', 'assets/style.css': '.x{}' });
  await writeFile(path.join(project,'assets/movie.mp4'),Buffer.alloc(6*1024*1024));
  const snapshot = await sourceSnapshot(project);
  assert.equal(snapshot.complete,true); assert.equal(snapshot.files.length,2);
  assert.ok(snapshot.files.some(f=>f.file==='config/settings_data.json')); assert.ok(!JSON.stringify(snapshot).includes('fixture-only'));
  await symlink(path.join(project,'assets/style.css'),path.join(project,'assets/alias.css'));
  assert.equal((await sourceSnapshot(project)).complete,false);
});

test('batch connects exploratory LHR, code coverage mapping, Liquid and DevTools diagnostics serially', async t => {
  const body='const component = 1;', project=await theme(t,{'assets/component.js':body});
  const url='https://cdn.shopify.com/s/files/1/assets/component.js';
  const run=await siteRun(t,{devices:['mobile'],reports:3,augment:r=>{r.audits['unused-javascript']={title:'Unused JavaScript',score:0.2,scoreDisplayMode:'numeric',metricSavings:{TBT:100},details:{type:'opportunity',overallSavingsMs:100,items:[{url,wastedBytes:400}]}};}});
  run.manifest.config.purpose='exploration';run.manifest.config.runs=3;await saveManifest(run);
  const root=await mkdtemp('/private/tmp/perfkit-batch-upgrade-');t.after(()=>rm(root,{recursive:true,force:true}));const order=[];
  const result=await runBatch({config:{schemaVersion:1,project,run:run.root,resources:false,runtimeProfiles:[{schemaVersion:1,url:'https://fixture.test',state:'initial'}],liquidProfile:{schemaVersion:1,input:'/synthetic/profile.json'},devtoolsProfile:{schemaVersion:1,url:'https://fixture.test'}},output:path.join(root,'batch'),dependencies:{
    profileRuntime:async({output})=>{order.push('runtime');await mkdir(output);const profile={schemaVersion:1,kind:'runtime-profile',status:'complete',sourceStable:true,project,resources:[{url,bodyHash:sha256(body),source:{status:'verified-bytes',file:'assets/component.js',sourceHash:sha256(body)}}]};await writeFile(path.join(output,'profile.json'),JSON.stringify(profile));return profile;},
    profileLiquid:async()=>{order.push('liquid');return{schemaVersion:1,kind:'liquid-profile',status:'complete'};},
    profileDevtools:async({output})=>{order.push('devtools');await mkdir(output);await writeFile(path.join(output,'devtools.json'),'{}');return{status:'complete'};}
  }});
  assert.equal(result.status,'complete',JSON.stringify(result.error));assert.deepEqual(order,['runtime','liquid','devtools']);assert.equal(result.acceptance,'not-evaluated');
  const audit=JSON.parse(await readFile(path.join(root,'batch/audit.json'),'utf8'));assert.equal(audit.resources.find(x=>x.url===url).source.status,'verified-bytes');
  assert.ok(result.artifacts['liquid-profile.json']);assert.ok(result.artifacts['devtools/devtools.json']);
});
test('Liquid CLI adapter adapts the installed URL flag and preserves raw profile provenance',async t=>{
  const project=await theme(t,{'sections/main.liquid':'{{ shop.name }}'}), calls=[];
  const raw={shared:{frames:[{name:'sections/main.liquid:1'}]},profiles:[{type:'sampled',unit:'milliseconds',startValue:0,endValue:4,samples:[[0]],weights:[4]}]};
  const report=await profileLiquid({config:{schemaVersion:1,project,store:'fixture.myshopify.com',themeId:'123',urlPath:'/'},dependencies:{runProcess:async(_cmd,args)=>{calls.push(args);return{code:0,stdout:args[0]==='version'?'4.9.4':args.includes('--help')?'--url --json --no-input':JSON.stringify(raw),stderr:''};}}});
  assert.equal(report.status,'complete');assert.equal(report.hotspots[0].selfMs,4);assert.ok(calls[2].includes('--url'));assert.ok(calls[2].includes('--json'));assert.ok(calls[2].includes('--no-input'));assert.equal(report.evidence.origin,'shopify-cli');
});
