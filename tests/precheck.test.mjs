import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {analyzeLiquidStructure} from '../lib/liquid-structure.mjs';
import {precheckTheme,validatePrecheck,assertPrecheckOutput} from '../lib/precheck.mjs';
import {dimensionFor} from '../lib/quality-catalog.mjs';
import {renderReport} from '../lib/report.mjs';
import {runBatch} from '../lib/batch.mjs';
import {siteRun} from './helpers/site-run.mjs';

async function fixture(t,content) {
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'precheck-test-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const project=path.join(root,'theme');await mkdir(path.join(project,'sections'),{recursive:true});
  await writeFile(path.join(project,'sections/main.liquid'),content);
  return {root,project};
}
function runner({raw=[],config,fail=false,onCheck}={}) {
  return async(command,args)=>{
    assert.ok(!args.includes('--auto-correct'));assert.ok(!args.includes('--init'));
    if(args[0]==='version')return {code:0,stdout:'4.9.4',stderr:''};
    if(args.includes('--version'))return {code:0,stdout:'3.29.0',stderr:''};
    if(args.includes('--print'))return {code:0,stderr:'',stdout:config??'LiquidComplexity:\n  enabled: true\n  maxComplexity: 120\nLiquidNestingDepth:\n  enabled: true\n  maxDepth: 10\n'};
    if(onCheck)await onCheck(args);
    return {code:fail?2:raw.length?1:0,stdout:JSON.stringify(raw),stderr:fail?'checker failure':''};
  };
}

test('counts control flow, when/elsif and logical operators, excludes comment/raw/schema',()=>{
 const s=`{% comment %}{% if fake %}{% endcomment %}{% raw %}{% if fake %}{% endraw %}
{% schema %}{"x":"{% if fake %}"}{% endschema %}
{% if a and b or c %}A{% elsif d %}B{% else %}C{% endif %}
{% case x %}{% when 'x' %}x{% when 'y' %}y{% endcase %}
{% paginate collection.products by 10 %}{% for p in collection.products %}x{% endfor %}{% endpaginate %}`;
 const r=analyzeLiquidStructure(s);assert.equal(r.complexity,10);assert.equal(r.maxDepth,1);assert.equal(r.breakdown.when,2);assert.equal(r.breakdown.and,1);
});
test('Liquid multiline syntax and exact threshold boundaries',()=>{
 const source='{% liquid\n if a\n if b\n echo "x"\n endif\n endif\n%}';
 const at=analyzeLiquidStructure(source,{maxComplexity:3,maxDepth:2});assert.equal(at.thresholdDecision,null);assert.equal(at.exceedingPaths.length,0);
 const over=analyzeLiquidStructure(source,{maxComplexity:2,maxDepth:1});assert.equal(over.thresholdDecision.line,3);assert.equal(over.exceedingPaths[0].depth,2);assert.deepEqual(over.deepestPath.map(p=>p.line),[2,3]);
});
test('HTML nesting and render/include do not increase Liquid nesting',()=>{
 const r=analyzeLiquidStructure('<div><div>{% render "x" %}{% include "y" %}{% if a %}a{% elsif b %}b{% endif %}</div></div>');assert.equal(r.maxDepth,1);assert.equal(r.complexity,3);
});
test('review hints retain exact expressions and do not claim semantic safety',()=>{
 const r=analyzeLiquidStructure('{% if a %}x{% else %}x{% endif %}{% if a %}y{% endif %}');
 assert.ok(r.hints.some(h=>h.type==='identical-branches-candidate'));assert.ok(r.hints.some(h=>h.type==='repeated-condition-candidate'));
 assert.equal(analyzeLiquidStructure('{% if a %} x{% else %}x{% endif %}').hints.length,0);
});
test('precheck validates options and classifies both checks as architecture',()=>{
 for(const value of [null,[],{unknown:true},{maxDepth:0},{maxComplexity:1.5},{timeoutMs:0}])assert.throws(()=>validatePrecheck(value));
 assert.equal(dimensionFor({ruleId:'LiquidNestingDepth'}),'architecture');
});
test('snapshot check binds current source and keeps thresholds separate from performance',async t=>{
 const f=await fixture(t,'<div>safe</div>');
 const result=await precheckTheme({project:f.project,dependencies:{runProcess:runner({onCheck:async args=>{
   const snapshot=args[args.indexOf('--path')+1];assert.notEqual(snapshot,f.project);assert.equal(await readFile(path.join(snapshot,'sections/main.liquid'),'utf8'),'<div>safe</div>');
 }})}});
 assert.equal(result.complete,true);assert.equal(result.reviewRequired,false);assert.equal(result.checks.complete,true);assert.equal(result.summary.complexity,0);
 assert.match(renderReport(result),/Liquid 前期预检/);assert.equal(await readFile(path.join(f.project,'sections/main.liquid'),'utf8'),'<div>safe</div>');
});
test('official warning carries exact nesting path and review requirement',async t=>{
 const source='{% if a %}\n{% if b %}x{% endif %}\n{% endif %}',f=await fixture(t,source);
 const raw=[{path:'sections/main.liquid',offenses:[{check:'LiquidNestingDepth',severity:'warning',start_row:1,start_column:0,message:'This Liquid block is nested 2 levels deep, which exceeds the maximum allowed depth of 1.'}]}];
 const config='LiquidComplexity:\n  enabled: true\n  maxComplexity: 120\nLiquidNestingDepth:\n  enabled: true\n  maxDepth: 1\n';
 const r=await precheckTheme({project:f.project,config:{maxDepth:1},dependencies:{runProcess:runner({raw,config})}});
 assert.equal(r.complete,true);assert.equal(r.reviewRequired,true);assert.equal(r.findings[0].actual,2);assert.equal(r.findings[0].nestingPath.length,2);assert.equal(r.findings[0].sourceBinding,'hash-matched');
});
test('missing rule support, process failure and mutation reject clean results',async t=>{
 const f=await fixture(t,'safe');
 await assert.rejects(precheckTheme({project:f.project,dependencies:{runProcess:runner({config:'LiquidComplexity:\n  enabled: false\n'})}}),/does not enable/);
 await assert.rejects(precheckTheme({project:f.project,dependencies:{runProcess:runner({fail:true})}}),/Theme Check failed/);
 await assert.rejects(precheckTheme({project:f.project,dependencies:{runProcess:runner({onCheck:async args=>writeFile(path.join(args[args.indexOf('--path')+1],'sections/main.liquid'),'mutated')})}}),/changed the temporary/);
 assert.equal(await readFile(path.join(f.project,'sections/main.liquid'),'utf8'),'safe');
});
test('missing official diagnostics or parser failures remain partial, not clean',async t=>{
 const f=await fixture(t,'{% if a %}x{% endif %}');
 const config='LiquidComplexity:\n  enabled: true\n  maxComplexity: 1\nLiquidNestingDepth:\n  enabled: true\n  maxDepth: 10\n';
 const r=await precheckTheme({project:f.project,config:{maxComplexity:1},dependencies:{runProcess:runner({config})}});
 assert.equal(r.complete,false);assert.equal(r.reviewRequired,true);assert.equal(r.issues[0].reason,'official-and-explanatory-results-differ');
 await writeFile(path.join(f.project,'sections/main.liquid'),'{% if %}');
 const invalid=await precheckTheme({project:f.project,dependencies:{runProcess:runner()}});assert.equal(invalid.complete,false);assert.equal(invalid.summary.unparsedFiles,1);
});
test('source drift rejects stale evidence',async t=>{
 const f=await fixture(t,'safe');await assert.rejects(precheckTheme({project:f.project,dependencies:{runProcess:runner({onCheck:async()=>writeFile(path.join(f.project,'sections/main.liquid'),'changed')})}}),/source changed/);
});
test('batch precheck precedes measurement, produces evidence and supplemental report',async t=>{
 const f=await fixture(t,'safe'),run=await siteRun(t,{devices:['mobile'],scores:{mobile:[85]}});
 const r=await runBatch({config:{schemaVersion:1,project:f.project,run:run.root,resources:false,precheck:true},output:path.join(f.root,'batch'),dependencies:{precheckTheme:args=>precheckTheme({...args,dependencies:{runProcess:runner()}})}});
 assert.equal(r.status,'complete');assert.equal(r.steps[0].command,'precheck');assert.equal(r.reviewRequired,false);
 const report=JSON.parse(await readFile(path.join(f.root,'batch/audit.json'),'utf8'));assert.equal(report.supplemental[0].kind,'theme-precheck');assert.equal(report.supplemental[0].status,'current-source');
 await readFile(path.join(f.root,'batch/precheck-checks.json'));
});
test('failed precheck stops before measurement and retains failure status',async t=>{
 const f=await fixture(t,'safe');const r=await runBatch({config:{schemaVersion:1,project:f.project,precheck:true,measurement:{schemaVersion:1,engine:'lighthouse',pages:[{id:'home',url:'https://example.com'}]}},output:path.join(f.root,'fail'),dependencies:{precheckTheme:async()=>{throw new Error('missing CLI');},measureSite:async()=>assert.fail('must not measure')}});
 assert.equal(r.status,'failed');assert.equal(r.diagnostics.precheck.status,'failed');assert.equal(r.acceptance,'not-evaluated');
});

test('unsupported official CLI preserves version and command failure before stopping batch',async t=>{
 const f=await fixture(t,'safe');
 const r=await runBatch({config:{schemaVersion:1,project:f.project,precheck:true,measurement:{schemaVersion:1,engine:'lighthouse',pages:[{id:'home',url:'https://example.com'}]}},output:path.join(f.root,'unsupported'),dependencies:{
  precheckTheme:args=>precheckTheme({...args,dependencies:{runProcess:async(_cmd,args)=>args[0]==='version'
   ?{code:0,stdout:'4.7.0\n',stderr:''}:{code:2,stdout:'',stderr:'Nonexistent flag: --no-input'}}}),
  measureSite:async()=>assert.fail('Unsupported precheck must stop before measurement'),
 }});
 assert.equal(r.status,'failed');assert.equal(r.acceptance,'not-evaluated');
 const failure=JSON.parse(await readFile(path.join(f.root,'unsupported/precheck-failure.json'),'utf8'));
 assert.equal(failure.commands[0].stdout,'4.7.0\n');assert.match(failure.commands[1].stderr,/no-input/);
 assert.equal(failure.commands[1].exitCode,2);assert.ok(r.artifacts['precheck-failure.json']);
});

test('default 120/10 boundaries do not warn until 121/11',()=>{
 const decision='{% if a %}x{% endif %}';assert.equal(analyzeLiquidStructure(decision.repeat(119)).thresholdDecision,null);assert.equal(analyzeLiquidStructure(decision.repeat(120)).complexity,121);
 const nest=n=>'{% if a %}'.repeat(n)+'x'+'{% endif %}'.repeat(n);
 assert.equal(analyzeLiquidStructure(nest(10)).exceedingPaths.length,0);assert.equal(analyzeLiquidStructure(nest(11)).exceedingPaths.length,1);
});
test('same-line nested tags bind by column and warning does not replace score acceptance',async t=>{
 const source='{% if a %}{% if b %}x{% endif %}{% endif %}',f=await fixture(t,source);
 const raw=[{path:'sections/main.liquid',offenses:[{check:'LiquidNestingDepth',severity:'warning',start_row:0,start_column:10,message:'This Liquid block is nested 2 levels deep, which exceeds the maximum allowed depth of 1.'}]}];
 const config='LiquidComplexity:\n  enabled: true\n  maxComplexity: 120\nLiquidNestingDepth:\n  enabled: true\n  maxDepth: 1\n';
 const before=await siteRun(t,{devices:['mobile'],scores:{mobile:[85]}}),after=await siteRun(t,{devices:['mobile'],scores:{mobile:[85]},offset:20});
 const result=await runBatch({config:{schemaVersion:1,project:f.project,run:after.root,before:before.root,resources:false,precheck:{maxDepth:1}},output:path.join(f.root,'warning'),dependencies:{precheckTheme:args=>precheckTheme({...args,dependencies:{runProcess:runner({raw,config})}})}});
 assert.equal(result.status,'complete');assert.equal(result.acceptance,'score-targets-met');assert.equal(result.reviewRequired,true);
 const p=JSON.parse(await readFile(path.join(f.root,'warning/precheck.json'),'utf8'));assert.equal(p.complete,true);assert.equal(p.findings[0].column,10);assert.equal(p.findings[0].nestingPath[1].column,10);
});
test('precheck rejects malformed batch configuration before creating outputs',async t=>{
 const f=await fixture(t,'safe');
 for (const precheck of [null,[],{unknown:true},{maxDepth:-1}]) await assert.rejects(runBatch({config:{schemaVersion:1,project:f.project,run:f.root,precheck},output:path.join(f.root,'invalid')}));
});


test('precheck output cannot create files in the theme, including symlinked parents',async t=>{
 const f=await fixture(t,'safe');
 await assert.rejects(assertPrecheckOutput(f.project,path.join(f.project,'new/report.json')),/outside the theme/);
 const alias=path.join(f.root,'alias');await symlink(f.project,alias);
 await assert.rejects(assertPrecheckOutput(f.project,path.join(alias,'new/report.json')),/outside the theme/);
 await assertPrecheckOutput(f.project,path.join(f.root,'reports/new.json'));
});
