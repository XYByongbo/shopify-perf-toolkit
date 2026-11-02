import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {themeStepFixture} from './helpers/theme-step-fixture.mjs';
import {candidatePriority,compareCandidates} from '../lib/candidate-priority.mjs';
import {resourceHealth,resourceIntelligence} from '../lib/resource-intelligence.mjs';
import {structureDependencies,sourceOwnership,compareOwnership,observationChanges,waiverCoverage} from '../lib/theme-governance.mjs';
import {transformCode,analyzeCode} from '../lib/code-strategies.mjs';
import {sha256} from '../lib/source-utils.mjs';
import {auditPerformance} from '../lib/performance-audit.mjs';
import {analyzeResourceSource} from '../lib/resource-audit.mjs';
import {createSitePlan,applySitePlan,rollbackSitePlan,validateSitePlan} from '../lib/site-changes.mjs';
import {buildThemeWorkflow} from '../lib/theme-workflow.mjs';
import {renderReport} from '../lib/report.mjs';
import {checkResourceEquivalence} from '../lib/resource-equivalence.mjs';
const generate=(source,kind,parameters)=>transformCode({source,target:'sections/main.liquid',kind,parameters,evidence:{sourceHash:sha256(source),summary:'Synthetic exact reviewed scope',fontUsageReviewed:true,fallbackMetricsReviewed:true,identicalResponseBytesReviewed:true,dependenciesReviewed:true,contentTypeReviewed:true,corsAndIntegrityReviewed:true}});

test('priority uses evidence and executable scope, compares like costs, stable under permutation',()=>{
  const rows=[{candidateId:'b',kind:'cpu',metric:'tbt',costMs:900,eligible:true},
    {candidateId:'a',kind:'image-lcp',metric:'lcp',costMs:100,eligible:true,methods:['image-priority'],criticalPathConfirmed:true}];
  assert.equal([...rows].sort(compareCandidates)[0].candidateId,'a');
  assert.deepEqual([...rows].sort(compareCandidates),[...rows].reverse().sort(compareCandidates));
  assert.equal(candidatePriority(rows[1]).disposition,'prepare-with-review');
  assert.equal(compareCandidates({...rows[0],candidateId:'a'},{...rows[0],candidateId:'b',costMs:100}),-800);
});

test('resource health retains untriggered, truncated, missing and unbound failures',async t=>{
  const f=await themeStepFixture(t,{'sections/main.liquid':'<p>Content</p>'});
  f.runtime.resourceHealth={version:1,images:[{selector:'#x',complete:false,decoded:null},{selector:'#broken',complete:true,decoded:false,naturalWidth:0}],truncated:true};
  const h=resourceHealth([f.runtime])[0];assert.equal(h.status,'failures-observed');assert.equal(h.pending,1);
  const flow=buildThemeWorkflow({snapshot:f.snapshot,profiles:[f.runtime],files:[]});
  assert.equal(flow.next.action,'bind-failed-resource-source');assert.equal(flow.stages[1].status,'source-binding-required');
  assert.equal(resourceHealth([{config:{}}])[0].status,'not-collected');
  f.runtime.resourceHealth.images=[];assert.equal(resourceHealth([f.runtime])[0].status,'partial');
});

test('resource cost joins keep actual requests separate from static reference counts and reject stale profiles',async t=>{
  const f=await themeStepFixture(t,{'sections/main.liquid':'<p>ok</p>'});
  f.runtime.resources=[{url:'https://a.test/a.js',type:'Script',timestamp:1,finishedTimestamp:1.2,encodedDataLength:20}];
  const result=resourceIntelligence({profiles:[f.runtime,{...f.runtime,sourceStable:false}],snapshot:f.snapshot,
    staticResources:[{url:'https://a.test/a.js',references:[{file:'x'},{file:'y'}]}]});
  assert.equal(result.captures[0].requestCount,1);assert.equal(result.captures[0].referenceCount,2);
  assert.equal(result.captures[0].requests[0].estimatedSavings,null);assert.deepEqual(result.rejectedProfiles,[1]);
});

test('font generator preserves font identity and other arguments, rejects dynamic displays',()=>{
  const source="{{ settings.body_font | font_face: font_display: 'block' }}";
  assert.equal(generate(source,'liquid-font-display',{outputStart:0,display:'swap'}).after,source.replace("'block'","'swap'"));
  assert.match(generate('{{ settings.body_font | font_face }}','liquid-font-display',{outputStart:0,display:'optional'}).after,/font_face: font_display: 'optional'/);
  assert.throws(()=>generate('{{ settings.body_font | font_face: font_display: settings.display }}','liquid-font-display',{outputStart:0,display:'swap'}),/Dynamic/);
});

test('resource rehosting produces replayable reversible plan and rejects non-equivalent bytes and responsive content',async t=>{
  const source='<img id="original" src="https://old.test/a.png" width="10" height="10">',hash='a'.repeat(64);
  const f=await themeStepFixture(t,{'sections/main.liquid':source});
  const parameters={tagStart:0,replacementUrl:'https://new.test/a.png',originalBodyHash:hash,replacementBodyHash:hash};
  const evidence={sourceHash:sha256(source),summary:'Synthetic equivalent original',identicalResponseBytesReviewed:true,dependenciesReviewed:true,contentTypeReviewed:true,corsAndIntegrityReviewed:true};
  const plan=await createSitePlan({project:f.root,recipe:{schemaVersion:1,changes:[{target:'sections/main.liquid',kind:'liquid-rehost-resource',parameters,evidence,reason:'Equivalent delivery test'}]}});
  await validateSitePlan(plan);await applySitePlan(plan,f.root);await rollbackSitePlan(plan,f.root);
  assert.equal(checkResourceEquivalence(plan,{}, {},{},[]),false);
  assert.throws(()=>generate(source,'liquid-rehost-resource',{...parameters,replacementBodyHash:'b'.repeat(64)}),/hashes/);
  assert.throws(()=>generate(source.replace('width=', 'srcset="a.png 1x" width='),'liquid-rehost-resource',parameters),/Responsive/);
});

test('schema dependencies retain aliases, visible_if and generated upstream ownership without deleting',()=>{
  const files=[{file:'sections/pf-a.liquid',text:"{% render 'card' %}"},{file:'snippets/card.liquid',text:`{% assign options = section.settings %}{{ options.title }}{% schema %}{"settings":[{"id":"title","type":"text"},{"id":"show","type":"checkbox","visible_if":"{{ section.settings.title != blank }}"}],"blocks":[{"type":"item","settings":[{"id":"label","type":"text"}]}]}{% endschema %}`}];
  const edges=[{from:files[0].file,to:files[1].file}];
  const structure=structureDependencies(files,edges)[1];assert.equal(structure.topLevelSettings,2);assert.deepEqual(structure.aliases,['options']);
  assert.deepEqual(structure.settings[0].visibleIfDependencies,['show']);assert.equal(structure.settings[0].deletionAuthorized,false);
  assert.equal(sourceOwnership(files,edges)[1].status,'generator-referenced-candidate');
  assert.equal(compareOwnership([{file:'x',sourceHash:'a'}],[{file:'x',sourceHash:'b'}])[0].cause,'not-inferred');
});

test('configuration URL candidates do not fabricate browser requests; waiver coverage remains separate',()=>{
  const r=analyzeResourceSource('{"sections":{"a":{"settings":{"image":"https://a.test/img.png"}}}}','templates/product.json');
  assert.equal(r.resources.length,1);assert.equal(r.resources[0].type,'configuration-url-candidate');
  const checks={metadata:{rulesConfig:{effectiveConfiguration:'RemoteAsset:\n  enabled: false\n'}}};
  assert.deepEqual(waiverCoverage(checks).disabledRules,['RemoteAsset']);
});

test('audit and code-analysis expose integrated intelligence and compare complete independent observations',async t=>{
  const source="{{ settings.body_font | font_face }}<p>Hello</p>";
  const f=await themeStepFixture(t,{'sections/main.liquid':source});
  const a=await auditPerformance({project:f.root});assert.ok(a.intelligence);assert.ok(a.observationContract);
  const b=await auditPerformance({project:f.root,baseline:a});
  assert.equal(b.observationChanges.status,a.complete?'same-observation-contract':'not-comparable');
  const analysis=await analyzeCode({project:f.root,target:'sections/main.liquid'});
  assert.ok(analysis.reviewTasks.some(t=>t.recipe?.kind==='liquid-font-display'));
  assert.match(renderReport(b),/资源与字体执行证据/);
  assert.equal(observationChanges({...a,complete:true},{...a,complete:true,observationContract:{version:99}}).status,'not-comparable');
});

test('resource equivalence requires complete page/device pairs, actual byte hashes, MIME and stable deployment',async t=>{
  const source='<script id="loader" src="https://old.test/a.js"></script>',hash='a'.repeat(64);
  const f=await themeStepFixture(t,{'sections/main.liquid':source});
  const parameters={tagStart:0,replacementUrl:'https://new.test/a.js',originalBodyHash:hash,replacementBodyHash:hash};
  const changed=generate(source,'liquid-rehost-resource',parameters).after;
  const change={target:'sections/main.liquid',before:source,after:changed,beforeHash:sha256(source),afterHash:sha256(changed),recipeKind:'liquid-rehost-resource',parameters};
  const a=structuredClone(f.runtime),b=structuredClone(a);
  b.snapshot.files[0].sourceHash=change.afterHash;b.snapshot.hash=sha256(JSON.stringify(b.snapshot.files));
  const advance=s=>new Date(Date.parse(s)+60000).toISOString();
  for(const k of ['createdAt','finishedAt'])b[k]=advance(b[k]);
  for(const k of ['startedAt','finishedAt'])b.domainProof[k]=advance(b.domainProof[k]);
  for(const side of ['before','after']) {const d=b.domainProof[side];d.sourceHash=b.snapshot.hash;d.remoteSourceHash=b.snapshot.hash;d.sourceManifest=b.snapshot.files;for(const k of ['startedAt','finishedAt'])d[k]=advance(d[k]);}
  a.resources=[{url:'https://old.test/a.js',bodyHash:hash,status:200,mimeType:'application/javascript',method:'GET',timestamp:1,finishedTimestamp:2}];
  a.domainTargets=[{id:'loader',idCount:1,tag:'SCRIPT',attrs:{src:'https://old.test/a.js'}}];
  b.resources=[{url:'https://new.test/a.js',bodyHash:hash,status:200,mimeType:'application/javascript',method:'GET',timestamp:1,finishedTimestamp:2}];
  b.domainTargets=[{id:'loader',idCount:1,tag:'SCRIPT',attrs:{src:'https://new.test/a.js'}}];
  const identity=p=>({sourceHash:p.snapshot.hash,store:p.domainProof.before.store,themeId:'1'});
  const evidence={before:[a],after:[b]},groups=[{url:f.url,device:'mobile'}],plan={changes:[change]};
  assert.equal(checkResourceEquivalence(plan,evidence,identity(a),identity(b),groups),true);
  assert.equal(checkResourceEquivalence(plan,evidence,identity(a),identity(b),[]),false);
  b.resources[0].mimeType='text/html';assert.equal(checkResourceEquivalence(plan,evidence,identity(a),identity(b),groups),false);
});

test('ranking remains transitive when same-scope costs disagree with global ID order',async()=>{
  const {rankCandidates}=await import('../lib/candidate-priority.mjs');
  const rows=[{candidateId:'z',kind:'cpu',metric:'tbt',costMs:900,eligible:true},{candidateId:'m',kind:'image-lcp',metric:'lcp',costMs:500,eligible:true},{candidateId:'a',kind:'cpu',metric:'tbt',costMs:100,eligible:true}];
  const order=rankCandidates(rows).map(c=>c.candidateId);
  for(const permutation of [rows,[rows[2],rows[1],rows[0]],[rows[1],rows[0],rows[2]]])assert.deepEqual(rankCandidates(permutation).map(c=>c.candidateId),order);
  assert.ok(order.indexOf('z')<order.indexOf('a'));
});

test('CLI audit baseline and reviewed ownership are wired, source drift cannot inherit ownership',async t=>{
  const {spawnSync}=await import('node:child_process');
  const f=await themeStepFixture(t,{'sections/main.liquid':'<p>Scope</p>'});
  const baseline=path.join(f.root,'baseline.json'),owners=path.join(f.root,'owners.json'),out=path.join(f.root,'after.json');
  await writeFile(baseline,JSON.stringify(await auditPerformance({project:f.root})));
  await writeFile(owners,JSON.stringify([{file:'sections/main.liquid',owner:'theme',sourceHash:f.snapshot.files[0].sourceHash,evidence:'Synthetic ownership review'}]));
  const r=spawnSync(process.execPath,['scripts/perfkit.mjs','audit-performance','--project',f.root,'--baseline',baseline,'--ownership',owners,'--out',out],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  const {readFile}=await import('node:fs/promises'),audit=JSON.parse(await readFile(out,'utf8'));
  assert.equal(audit.intelligence.ownership[0].owner,'theme');assert.equal(audit.observationChanges.status,'same-observation-contract');
  await assert.rejects(createSitePlan({project:f.root,recipe:{schemaVersion:1,ownership:[{file:'sections/main.liquid',sourceHash:'f'.repeat(64)}],changes:[{target:'sections/main.liquid',kind:'reviewed-replacement',replacementText:'<p>Changed</p>',reason:'Synthetic preservation',evidence:{summary:'Synthetic review'}}]}}),/Ownership review/);
});
