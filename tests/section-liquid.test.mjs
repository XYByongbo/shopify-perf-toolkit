import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {Liquid} from 'liquidjs';
import {initialSectionStartup,prepareInitialLiquid,inlineInitialController,checkControllerOwnership} from '../lib/section-liquid.mjs';
import {permitsBareInline} from '../lib/section-csp.mjs';
import {sourceSnapshot} from '../lib/runtime-profile.mjs';
import {fetchTargets} from '../lib/extended-methods.mjs';
import {remainingDomainMethods,hypothesisKey,reassessCandidate} from '../lib/recovery.mjs';
import {controller,renderTag,writeTheme} from './fixtures/section-liquid/theme.mjs';

async function fixture(t) {
  const project=await mkdtemp('/private/tmp/perfkit-liquid-unit-');t.after(()=>rm(project,{recursive:true,force:true}));await writeTheme(project);
  const donor=await readFile(path.join(project,'sections/ajax-main.liquid'),'utf8');
  const config={targetFile:'sections/main.liquid',sourceFile:'sections/ajax-main.liquid',renderOffset:donor.indexOf(renderTag),startupFunction:'load',legacyView:'ajax',
    update:{triggerSelector:'#refresh',assertionSelector:'#first-title',requestUrl:'https://example.com/collections/all?sort_by=title-descending&view=ajax'}};
  const args={project,source:controller,fetchOffset:controller.indexOf('fetch('),selector:'#hero',config};return {project,args};
}
test('only a single direct startup is removable; dynamic callers survive',()=>{
  const n=fetchTargets(controller)[0];assert.ok(n.methods.includes('section-liquid-initial'));
  const startup=initialSectionStartup(controller,n.offset);assert.equal(controller.slice(startup.start,startup.end),'load();');
  for(const source of [controller.replace('load();','if (true) load();'),controller+'load();',controller.replace('load();','load(sideEffect());'),controller+'const alias = load;',controller.replace('await fetch(url.href)','await (async () => fetch(url.href))()')])
    assert.equal(initialSectionStartup(source,source.indexOf('fetch(')),null);
});
test('Liquid candidate copies the existing render expression and preserves settings, escaped text and empty states',async t=>{
  const {project,args}=await fixture(t),result=await prepareInitialLiquid(args);
  assert.equal(result.contract.renderSource.tag,renderTag);assert.ok(result.after.includes(renderTag));
  const engine=new Liquid({root:path.join(project,'snippets'),extname:'.liquid'});engine.registerFilter('asset_url',n=>'/assets/'+n);
  for(const products of [[],[{title:'<Alpha & more>',url:'/fr/products/alpha'}]])for(const heading of ['Title','Localized & alternate']) {
    const context={section:{settings:{heading}},collection:{products,url:'/fr/collections/all'}};
    const expected=await engine.parseAndRender(renderTag,context);
    const rendered=await engine.parseAndRender(result.after.replace(/\{% schema %\}[\s\S]*?\{% endschema %\}/g,''),context);
    assert.ok(rendered.includes(expected));assert.ok(!rendered.includes('<Alpha & more>'));
  }
});
test('nonempty/conditional target and local/dynamic render dependencies are rejected',async t=>{
  const {project,args}=await fixture(t),target=path.join(project,'sections/main.liquid'),original=await readFile(target,'utf8');
  for(const modified of [original.replace('<div id="hero"></div>','<div id="hero">Existing content</div>'),'{% if product %}'+original+'{% endif %}',"{% assign collection = collections.other %}"+original]){
    await writeFile(target,modified);await assert.rejects(prepareInitialLiquid(args),{code:'UNSUPPORTED_CODE_PATTERN'});
  }
  await writeFile(target,original);
  const file=path.join(project,'sections/ajax-main.liquid');
  for(const tag of ["{% render fragment %}","{% render 'catalog-content', collection: local_collection %}","{% assign local_collection = collection %}"+renderTag]) {
    await writeFile(file,tag);await assert.rejects(prepareInitialLiquid({...args,config:{...args.config,renderOffset:tag.indexOf('{% render')}}),{code:'UNSUPPORTED_CODE_PATTERN'});
  }
});
test('failed scoped Ajax can switch to Liquid first render, but cannot retry the HTML/JSON mechanism',()=>{
  const c={kind:'section-fetch',file:'assets/main.js',line:4,metric:'lcp',device:'mobile',page:'https://example.com/',methods:['section-fetch-single','section-fetch-json','section-liquid-initial','section-liquid-inline']};
  const history=[{baselineHash:'source',hypothesisKey:hypothesisKey(c),method:'section-fetch-single',outcome:'performance-regressed'}];
  assert.deepEqual(remainingDomainMethods(c,'source',history),['section-liquid-initial','section-liquid-inline']);
  history.push({...history[0],method:'section-liquid-initial',outcome:'formal-rejected'});assert.deepEqual(remainingDomainMethods(c,'source',history),['section-liquid-inline']);
  assert.match(reassessCandidate(c,'source',history).reassessment.changedAssumption,/external controller request/);
  history.push({...history[0],method:'section-liquid-inline'});assert.deepEqual(remainingDomainMethods(c,'source',history),[]);
  const restricted={...c,data:{securityPolicy:{complete:true,headers:["script-src 'self'"],meta:[]}}};
  assert.deepEqual(remainingDomainMethods(restricted,'source',history.slice(0,2)),[]);
});

test('inline recovery rejects shared, oversized, ambiguous or globally coupled controllers',async t=>{
  const {project,args}=await fixture(t),initial=await prepareInitialLiquid(args),snapshot=await sourceSnapshot(project);
  const input={project,snapshot,file:'assets/main.js',source:controller,controller:controller.replace('load();',''),initial};
  const result=await inlineInitialController(input);assert.ok(result.after.includes('Symbol.for'));assert.ok(!result.after.includes('asset_url'));assert.ok(!result.assetAfter.includes('addEventListener'));
  for(const modified of [
    {...input,controller:'x'.repeat(4097)}, {...input,controller:input.controller+'// </script>'},
    {...input,controller:input.controller+'// {{ injected }}'},
    {...input,source:controller+'const exposed = 1;'},
    {...input,source:controller.replace('location.href','sharedConfig.url'),controller:input.controller.replace('location.href','sharedConfig.url')},
    {...input,initial:{...initial,after:initial.after.replace(' defer',' async')}},
    {...input,initial:{...initial,after:initial.after+"<!-- main.js -->"}},
  ])await assert.rejects(inlineInitialController(modified),{code:'UNSUPPORTED_CODE_PATTERN'});
  await writeFile(path.join(project,'assets/other.js'),"loadScript('main.js')");
  await assert.rejects(inlineInitialController({...input,snapshot:await sourceSnapshot(project)}),{code:'UNSUPPORTED_CODE_PATTERN'});
});

test('both Liquid methods refuse an asset shared across templates and external consumers of its loader global',async t=>{
  const {project,args}=await fixture(t),initial=await prepareInitialLiquid(args);
  const input={project,file:'assets/main.js',source:controller,initial};
  await writeFile(path.join(project,'assets/unrelated.js'),'window.addEventListener("load", () => {}); const data = {load: "status"};');
  await checkControllerOwnership({...input,snapshot:await sourceSnapshot(project)});
  await rm(path.join(project,'assets/unrelated.js'));
  for(const nonce of [initial.after.replace(' defer',' defer nonce="{{ csp_nonce }}"'),initial.after.replace('<script src','<script nonce="{{ csp_nonce }}" src')]) {
    await checkControllerOwnership({...input,initial:{...initial,after:nonce},snapshot:await sourceSnapshot(project)});
    await assert.rejects(inlineInitialController({...input,initial:{...initial,after:nonce},snapshot:await sourceSnapshot(project),controller:controller.replace('load();','')}),{code:'UNSUPPORTED_CODE_PATTERN'});
  }
  await writeFile(path.join(project,'sections/other.liquid'),'<script src="{{ \'main.js\' | asset_url }}" defer></script>');
  await assert.rejects(checkControllerOwnership({...input,snapshot:await sourceSnapshot(project)}),{code:'UNSUPPORTED_CODE_PATTERN'});
  await rm(path.join(project,'sections/other.liquid'));
  for(const [file,text] of [['assets/consumer.js','window.addEventListener("ready", () => load());'],['sections/consumer.liquid','<button onclick="load()">Refresh</button>'],['sections/consumer.liquid','<script>load();</script>'],['sections/consumer.liquid','{% javascript %}load();{% endjavascript %}']]) {
    await writeFile(path.join(project,file),text);
    await assert.rejects(checkControllerOwnership({...input,snapshot:await sourceSnapshot(project)}),{code:'UNSUPPORTED_CODE_PATTERN'});await rm(path.join(project,file));
  }
});

test('bare inline CSP requires observed permissive effective directives for every policy',()=>{
  const p=(headers=[],meta=[])=>({complete:true,headers,meta});
  for(const policy of [undefined,{headers:[],meta:[]},p(["default-src 'self'"]),p(["script-src 'self' 'unsafe-inline' 'nonce-x'"]),p(["script-src 'unsafe-inline' 'sha256-abc'"]),p(["script-src 'unsafe-inline'","script-src-elem 'self'"]),p([], ["script-src 'self'"]),p(["sandbox allow-same-origin"]),p(["script-src 'unsafe-inline', script-src 'self'"])])assert.equal(permitsBareInline(policy),false);
  for(const policy of [p(),p(["script-src 'self' 'unsafe-inline'"]),p(["script-src 'self'; script-src-elem 'unsafe-inline'"]),p(["style-src 'self'"]),p(["sandbox allow-scripts; script-src 'unsafe-inline'"])])assert.equal(permitsBareInline(policy),true);
});
