import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {auditWindowBudget} from '../lib/resource-budget.mjs';
import {compareFieldSnapshots,monitorField} from '../lib/field-monitor.mjs';
import {auditPolicy} from '../lib/policy-audit.mjs';
import {instanceLifecycle,cartMutationQueue} from '../assets/runtime/theme-adapter-primitives.mjs';

test('window budgets keep ownership, unknown bytes, incomplete capture and deltas distinct',async()=>{
 const p={kind:'runtime-profile',status:'complete',config:{url:'https://example.com/',device:'mobile'},browserVersion:'fixture',environment:{cache:'disabled'},networkCapture:{complete:true,navigationStart:10,interactionStart:21,captureEnd:24},resources:[{id:'a',url:'https://cdn.example.com/a.js',timestamp:11,finishedTimestamp:12,transferBytes:50},{id:'b',url:'https://cdn.example.com/b.js',timestamp:21,finishedTimestamp:22,transferBytes:70}]};
 const config={profiles:[p],windows:[{id:'ten',fromMs:0,toMs:10000,maxTransferBytes:60},{id:'interaction',anchor:'interaction',fromMs:0,toMs:3000,maxTransferBytes:80}],owners:[]};
 const good=await auditWindowBudget(config);assert.equal(good.status,'passed');assert.deepEqual(good.details.map(d=>d.transferBytes),[50,70]);
 const incomplete=structuredClone(p);incomplete.networkCapture.captureEnd=18;assert.equal((await auditWindowBudget({...config,profiles:[incomplete]})).status,'review-required');
 const unknown=structuredClone(p);delete unknown.resources[0].transferBytes;assert.equal((await auditWindowBudget({...config,profiles:[unknown]})).details[0].transferBytes,null);
 assert.equal((await auditWindowBudget({...config,windows:[{...config.windows[0],owner:'theme'}]})).status,'review-required');
 const before=structuredClone(p);before.resources[0].transferBytes=20;
 assert.equal((await auditWindowBudget({...config,beforeProfiles:[before],windows:[{...config.windows[0],maxDeltaBytes:10}]})).status,'review-required');
 const duplicate=structuredClone(p);duplicate.resources.push(duplicate.resources[0]);assert.equal((await auditWindowBudget({...config,profiles:[duplicate]})).status,'review-required');
});

function snapshot(start,end,value=2400){return {sourceId:'fixture',release:{version:'1',sourceHash:'a'.repeat(64),deployedAt:'2026-09-01'},field:{schemaVersion:1,source:'rum-export',window:{start,end},groups:[{url:'https://example.com/',scope:'url',pageType:'home',device:'mobile',samples:1000,metrics:{lcp:value}}]}};}
test('field trends refuse overlapping, mixed and insufficient windows without averaging percentiles',()=>{
 const a=snapshot('2026-10-01','2026-10-14'),b=snapshot('2026-10-15','2026-10-28',3000),options={now:Date.parse('2026-11-01')};
 assert.ok(compareFieldSnapshots(b,a,options).alerts.some(a=>a.type==='trend-regression'));
 const overlap=snapshot('2026-10-10','2026-10-23',3000);assert.ok(compareFieldSnapshots(overlap,a,options).groups[0].reasons.includes('overlapping-or-repeated-windows'));
 b.release.deployedAt='2026-10-20';assert.equal(compareFieldSnapshots(b,a,options).alerts.length,0);
 b.release.deployedAt='2026-09-01';b.field.groups[0].samples=2;assert.equal(compareFieldSnapshots(b,a,options).alerts.length,0);
});
test('monitor persists every bounded cycle and retains failed sources; it does not send alerts',async t=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'perfkit-monitor-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const s=snapshot('2026-10-15','2026-10-28',3000),input=path.join(root,'field.json');await writeFile(input,JSON.stringify(s.field));let sleeps=0;
 const result=await monitorField({config:{schemaVersion:1,sources:[{id:'fixture',input,approvalRef:'fixture-export',release:s.release},{id:'missing',input:path.join(root,'absent.json'),approvalRef:'fixture-export',release:s.release}],schedule:{cycles:2,intervalMs:1000}},output:path.join(root,'run')},{sleep:async()=>{sleeps++;},now:()=>Date.parse('2026-11-01')});
 assert.equal(result.cycles.length,2);assert.equal(sleeps,1);assert.equal(result.cycles[0].records[1].status,'failed');assert.equal(result.status,'review-required');
});
test('engineering policy compares baseline debt and shared dependency changes without claiming official checks',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'perfkit-policy-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const side of ['a','b']){await mkdir(path.join(root,side,'snippets'),{recursive:true});await writeFile(path.join(root,side,'snippets/x.liquid'),Array(160).fill('Text').join('\n'));}
 const same=await auditPolicy({project:path.join(root,'b'),beforeProject:path.join(root,'a')});assert.equal(same.status,'passed');assert.equal(same.findings[0].introducedOrWorsened,false);assert.ok(same.notAssessed.length);
 await writeFile(path.join(root,'b','snippets/x.liquid'),Array(161).fill('Text').join('\n'));
 assert.equal((await auditPolicy({project:path.join(root,'b'),beforeProject:path.join(root,'a')})).status,'review-required');
});
test('instance lifecycle handles pending unmount, reconnect and repeated setup without destroying a newer instance',async()=>{
 let mounts=0,destroys=0,resolve;const element={};
 const lifecycle=instanceLifecycle({mount:async()=>{mounts++;await new Promise(r=>resolve=r);return mounts;},unmount:()=>{destroys++;}});
 const a=lifecycle.mount(element),b=lifecycle.mount(element);await Promise.resolve();assert.equal(mounts,1);await lifecycle.unmount(element);resolve();await Promise.all([a,b]);assert.equal(destroys,1);
 const c=lifecycle.mount(element);await Promise.resolve();resolve();await c;await lifecycle.unmount(element);await lifecycle.unmount(element);assert.equal(destroys,2);
});
test('cart writes are serialized and deduped; null sections and uncertain writes recover without replay',async()=>{
 const calls=[],events=[],recovered=[];let quantity=0;
 const mutate=cartMutationQueue({sections:['cart'],request:async(url,body)=>{calls.push({url,body});quantity++;return {status:200,body:{sections:{cart:null}}};},readCart:async()=>({items:[{key:'variant:custom',quantity}]}),render:()=>assert.fail('Null sections must recover'),recover:cart=>recovered.push(cart),onSuccess:e=>events.push(e),routeRoot:'/fr/'});
 const operation={operationId:'one',operation:'add',payload:{items:[{id:1,quantity:1,properties:{engraving:'A'}}]},sectionsUrl:'/fr/products/p'};
 await Promise.all([mutate(operation),mutate(operation)]);assert.equal(calls.length,1);assert.equal(events.length,1);assert.equal(recovered.length,1);assert.equal(calls[0].url,'/fr/cart/add.js');assert.equal(calls[0].body.items[0].properties.engraving,'A');
 let uncertain=0;const retry=cartMutationQueue({sections:['cart'],request:async()=>{uncertain++;throw new Error('timeout after server mutation');},readCart:async()=>({item_count:1}),render:()=>{},recover:()=>{},onSuccess:()=>assert.fail('Uncertain writes cannot emit success')});
 await assert.rejects(retry({...operation,operationId:'timeout'}),e=>e.reconciled&&e.writeOutcome==='unknown');assert.equal(uncertain,1);
});
