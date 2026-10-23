import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Liquid } from 'liquidjs';
import postcss from 'postcss';
import { transformCode, analyzeCode } from '../lib/code-strategies.mjs';
import { codeStrategies } from '../lib/code-strategy-catalog.mjs';
import { createSitePlan, applySitePlan, rollbackSitePlan } from '../lib/site-changes.mjs';
import { unifiedDiff } from '../lib/changes.mjs';

const hash = s => createHash('sha256').update(s).digest('hex');
const evidence = (source, kind) => ({ ...Object.fromEntries(codeStrategies.find(x => x.kind === kind).evidenceRequired.map(k => [k, true])), sourceHash:hash(source),summary:'Synthetic behavior fixture; not a production performance claim.' });
const js = `let position = 0; let paints = [];\nfunction paint() { paints.push(position); }\nwindow.addEventListener('scroll', paint, { passive: true });\nfunction destroy() { window.removeEventListener('scroll', paint); }\n`;
const css = '.card { display: -webkit-box; display: flex; color: red; color: red; --x: 1; --x: 1; }\n';
const liq = `before\n{%- for product in collection.products -%}\n{%- if forloop.index <= 3 -%}\n<b>{{ forloop.index }}:{{ product.title | escape }}:{{ forloop.first }}</b>\n{%- endif -%}\n{%- endfor -%}\nafter`;
const params = { 'js-raf-listener': { registrationStart:js.indexOf('window.addEventListener') }, 'css-dedupe-declarations': {}, 'css-offscreen-rendering':{selector:'.details',intrinsicBlockSize:600},'liquid-limit-guarded-loop':{loopStart:liq.indexOf('{%- for')} };
const transform = (source, kind, parameters=params[kind],target=kind.startsWith('js-')?'assets/main.js':kind.startsWith('css-')?'assets/main.css':'sections/main.liquid') => transformCode({source,kind,parameters,target,evidence:evidence(source,kind)});

function execute(source) {
  let sequence=0; const frames=new Map(), listeners=new Map(), cancelled=[];
  const context=vm.createContext({window:{addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}},
    requestAnimationFrame:fn=>{const id=sequence++;frames.set(id,fn);return id;},cancelAnimationFrame:id=>{cancelled.push(id);frames.delete(id);}});
  vm.runInContext(source,context);
  return {context,frames,cancelled,event:()=>listeners.get('scroll')?.(),run:s=>vm.runInContext(s,context),flush:()=>{for(const [id,fn] of [...frames]){frames.delete(id);fn();}}};
}
test('RAF transformation coalesces bursts, reads latest state and cancels pending teardown (including RAF id zero)',()=>{
  const before=execute(js),after=execute(transform(js,'js-raf-listener').after);
  for(let i=1;i<=50;i++){before.run(`position=${i}`);after.run(`position=${i}`);before.event();after.event();}
  assert.equal(before.run('paints.length'),50);assert.equal(after.run('paints.length'),0);assert.equal(after.frames.size,1);
  after.flush();assert.equal(after.run('paints.length'),1);assert.equal(after.run('paints[0]'),50);
  after.event();after.run('destroy()');assert.equal(after.frames.size,0);after.flush();assert.equal(after.run('paints.length'),1);
  after.event();assert.equal(after.frames.size,0);
  const fresh=execute(transform(js,'js-raf-listener').after);fresh.event();fresh.run('destroy()');assert.deepEqual(fresh.cancelled,[0]);
});
test('RAF preserves unrelated listeners and creates collision-free names',()=>{
  const source='const __perfRaf0Id = 7;\n'+js;
  const result=transform(source,'js-raf-listener',{registrationStart:source.indexOf('window.addEventListener')});
  assert.match(result.after,/__perfRaf1Id/);assert.match(result.after,/const __perfRaf0Id = 7/);
});
for (const [name,source] of [
  ['event argument',js.replace('function paint()', 'function paint(event)')],
  ['receiver',js.replace('paints.push(position)', 'paints.push(this.scrollY)')],
  ['alias',js+'const copy = paint;'],
  ['direct call',js+'paint();'],
  ['shadowed teardown',js.replace('function destroy()', 'function destroy(paint)')],
  ['abort signal',js.replace('{ passive: true }','{ signal: abort.signal }')],
  ['capture',js.replace('{ passive: true }','true')],
  ['once',js.replace('{ passive: true }','{ once: true }')],
  ['nested registration',js.replace("window.addEventListener('scroll', paint, { passive: true });", "if (ready) window.addEventListener('scroll', paint, { passive: true });")],
  ['handler reassignment',js+'paint = another;'],
  ['different removal',js.replace("removeEventListener('scroll'", "removeEventListener('resize'")],
  ['runtime shadow', 'const requestAnimationFrame = custom;\n'+js],
]) test(`RAF rejects ${name}`,()=>assert.throws(()=>transform(source,'js-raf-listener',{registrationStart:source.indexOf('window.addEventListener')}),{code:'UNSUPPORTED_CODE_PATTERN'}));

test('CSS dedupe preserves fallback order, custom properties, comments and different important flags',()=>{
  const source=css+'.other { color: red; /* boundary */ color: red; color: red !important; }';
  const result=transform(source,'css-dedupe-declarations');
  const root=postcss.parse(result.after);const nodes=root.first.nodes;
  assert.deepEqual(nodes.map(n=>[n.prop,n.value]),[['display','-webkit-box'],['display','flex'],['color','red'],['--x','1'],['--x','1']]);
  assert.equal(root.last.nodes.length,4);assert.ok(result.after.length<source.length);
  assert.throws(()=>transform(result.after,'css-dedupe-declarations'),{code:'NO_CHANGE'});
});
test('CSS offscreen adds only explicit containment declarations and requires unique eligible rule',()=>{
  const source='.details { display: flow-root; color: blue; }\n.other { color: red; }';
  const result=transform(source,'css-offscreen-rendering');const root=postcss.parse(result.after);
  assert.equal(root.first.nodes.find(n=>n.prop==='content-visibility').value,'auto');
  assert.equal(root.first.nodes.find(n=>n.prop==='contain-intrinsic-block-size').value,'auto 600px');
  assert.equal(root.last.toString(),postcss.parse(source).last.toString());
  for(const bad of ['.details { color: red }','.details {display:block}', '.details {contain: paint}', '.details {} .details {}','@media (min-width:1px){.details{color:red}}','.details { position: sticky; }','.details { & .child { color:red } }'])
    assert.throws(()=>transform(bad,'css-offscreen-rendering'),{code:'UNSUPPORTED_CODE_PATTERN'});
  assert.throws(()=>transform(source,'css-offscreen-rendering',{selector:'body',intrinsicBlockSize:600}),{code:'UNSUPPORTED_CODE_PATTERN'});
});
test('Liquid limited loop renders identical escaped content across empty, short and long collections',async()=>{
  const after=transform(liq,'liquid-limit-guarded-loop').after;const engine=new Liquid();
  assert.match(after,/limit: 3/);assert.doesNotMatch(after,/if forloop.index/);
  for(const count of [0,1,2,3,4,50,100]){
    const context={collection:{products:Array.from({length:count},(_,n)=>({title:`Item <${n}> & "quote"`}))}};
    assert.equal(await engine.parseAndRender(after,context),await engine.parseAndRender(liq,context));
  }
  assert.equal(await engine.parseAndRender(after,{}),await engine.parseAndRender(liq,{}));
});
for(const [label,source] of [
  ['last metadata',liq.replace('forloop.first','forloop.last')],
  ['metadata alias',liq.replace('forloop.first','forloop | json')],
  ['bracket metadata',liq.replace('forloop.first',"forloop['length']")],
  ['side effects',liq.replace('<b>','{% assign x = product %}<b>')],
  ['untrimmed',liq.replace('{%- for','{% for')],
  ['else',liq.replace('{%- endif -%}','{% else %}other{%- endif -%}')],
  ['loop options',liq.replace('in collection.products','in collection.products reversed')],
  ['opaque raw',`{% raw %}${liq}{% endraw %}`],
  ['nested opaque comments',`{% comment %}{% comment %}inner{% endcomment %}${liq}{% endcomment %}`],
  ['nested loops',liq.replace('<b>','{% for x in xs %}{% endfor %}<b>')],
]) test(`Liquid rejects ${label}`,()=>assert.throws(()=>transform(source,'liquid-limit-guarded-loop',{loopStart:source.indexOf('{%- for')})));

test('All strategies require source-bound explicit evidence and reject unknown parameters',()=>{
  assert.throws(()=>transformCode({source:js,target:'assets/main.js',kind:'js-raf-listener',parameters:params['js-raf-listener'],evidence:{summary:'x',sourceHash:hash(js)}}),{code:'MISSING_CODE_EVIDENCE'});
  assert.throws(()=>transformCode({source:js+' ',target:'assets/main.js',kind:'js-raf-listener',parameters:params['js-raf-listener'],evidence:evidence(js,'js-raf-listener')}),{code:'MISSING_CODE_EVIDENCE'});
  assert.throws(()=>transform(css,'css-dedupe-declarations',{deleteAll:true}),{code:'INVALID_CODE_PARAMETERS'});
  assert.throws(()=>transform(css,'css-dedupe-declarations',{},'config/settings_data.json'));
});
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'code-strategy-'));const root=await fs.realpath(dir);t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const [target,source] of Object.entries({'assets/main.js':js,'assets/main.css':css,'sections/main.liquid':liq})){await fs.mkdir(path.dirname(path.join(root,target)),{recursive:true});await fs.writeFile(path.join(root,target),source);}
  return root;
}
const recipeItem=(source,target,kind)=>({target,kind,parameters:params[kind],reason:'Synthetic strategy test',evidence:evidence(source,kind)});
test('Discovery proposes incomplete evidence, never writes, and plan/apply/rollback changes three real files',async t=>{
  const project=await fixture(t),items=[];
  for(const [target,source,kind] of [['assets/main.js',js,'js-raf-listener'],['assets/main.css',css,'css-dedupe-declarations'],['sections/main.liquid',liq,'liquid-limit-guarded-loop']]){
    const result=await analyzeCode({project,target});assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].kind,kind);
    assert.equal(result.candidates[0].recipe.evidence.summary,'');assert.equal(result.candidates[0].recipe.evidence.timingChangeReviewed,undefined);
    assert.equal(await fs.readFile(path.join(project,target),'utf8'),source);items.push(recipeItem(source,target,kind));
  }
  const plan=await createSitePlan({project,recipe:{schemaVersion:1,changes:items}});
  assert.ok(plan.changes.every(x=>x.operation==='generated-code-strategy'));
  assert.equal((await applySitePlan(plan,project)).status,'applied');
  for(const item of plan.changes)assert.equal(await fs.readFile(path.join(project,item.target),'utf8'),item.after);
  assert.equal((await rollbackSitePlan(plan,project)).status,'rolled-back');
  for(const item of plan.changes)assert.equal(await fs.readFile(path.join(project,item.target),'utf8'),item.before);
});
const canonical=v=>v&&typeof v==='object'?Array.isArray(v)?`[${v.map(canonical).join(',')}]`:`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')}}`:JSON.stringify(v);
test('Apply rejects a rehashed generated plan with extra changes, and drift prevents writes',async t=>{
  const project=await fixture(t);const plan=await createSitePlan({project,recipe:{schemaVersion:1,changes:[recipeItem(js,'assets/main.js','js-raf-listener')]}});
  const bad=structuredClone(plan);bad.changes[0].after+='\nwindow.hiddenMutation=true;';bad.changes[0].afterHash=hash(bad.changes[0].after);bad.changes[0].diff=unifiedDiff('assets/main.js',js,bad.changes[0].after);
  const {planHash,...body}=bad;bad.planHash=hash(canonical(body));await assert.rejects(applySitePlan(bad,project),{code:'INVALID_PLAN'});
  await fs.appendFile(path.join(project,'assets/main.js'),'// concurrent edit');await assert.rejects(applySitePlan(plan,project),{code:'SOURCE_DRIFT'});
});
test('CLI exposes catalog, discovers strategies, generates, applies and rolls back without replacement text',async t=>{
  const project=await fixture(t),cli=path.resolve('scripts/perfkit.mjs');
  const run=(...args)=>{const r=spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  const catalog=run('code-strategies','--format','full');assert.equal(catalog.strategies.length,19);
  const discovery=run('analyze-code','--project',project,'--target','assets/main.js','--format','full');assert.equal(discovery.candidates.length,1);
  const recipe=path.join(project,'recipe.json'),plan=path.join(project,'plan.json');
  await fs.writeFile(recipe,JSON.stringify({schemaVersion:1,changes:[recipeItem(js,'assets/main.js','js-raf-listener')]}));
  run('plan-site','--project',project,'--recipe',recipe,'--out',plan);
  run('apply','--project',project,'--plan',plan,'--out',path.join(project,'apply.json'));
  assert.notEqual(await fs.readFile(path.join(project,'assets/main.js'),'utf8'),js);
  run('rollback','--project',project,'--plan',plan,'--out',path.join(project,'rollback.json'));
  assert.equal(await fs.readFile(path.join(project,'assets/main.js'),'utf8'),js);
});
