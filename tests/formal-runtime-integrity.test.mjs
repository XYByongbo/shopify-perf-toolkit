import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {themeStepFixture} from './helpers/theme-step-fixture.mjs';
import {siteRun,regressionForRun} from './helpers/site-run.mjs';
import {proof} from './helpers/improvement-fixture.mjs';
import {sourceSnapshot} from '../lib/runtime-profile.mjs';
import {checkFormalRuntimeIntegrity} from '../lib/formal-runtime-integrity.mjs';
import {verifyOptimization} from '../lib/optimization-verification.mjs';
function addCapture(p){
 p.config.initializationEvents=['StartAsyncLoading'];
 const identity={selector:'#main',tag:'H1',capturedAtMs:100,fontSize:24,text:'Visible content',textCharacters:15,textTruncated:false,viewportCoverage:.2,viewport:{width:390,height:844},backgroundImage:'none',effectiveOpacity:1,ancestors:[{opacity:'1',display:'block',visibility:'visible',activeAnimations:0}],expectedMatch:null};
 const integrity={version:1,timeOrigin:1,lcpSupported:true,lcpEntries:[{startTime:90,size:100,url:'',identity}],settledLcp:identity,lcpTruncated:false,events:[],eventsTruncated:false,initializationEvents:['StartAsyncLoading'],expectedLcpSelectors:[],capturedAtMs:200,errors:[]};
 Object.assign(p,{timeOrigin:1,browserVersion:'synthetic-fixture',environment:{cache:'disabled',serviceWorkers:'blocked'},actions:[],initial:{lcp:{startTime:90,size:100,url:''},integrity},afterActions:{integrity:{...structuredClone(integrity),capturedAtMs:1000}},networkCapture:{version:1,complete:true,truncated:false,redirectsTruncated:false,mainFrameId:'m',mainLoaderId:'l'}});return p;
}
async function setup(t){const f=await themeStepFixture(t,{'assets/main.css':'h1{color:red}'}),a=addCapture(f.runtime);await writeFile(f.root+'/assets/main.css','h1{color:blue}');const b=structuredClone(a);b.snapshot=await sourceSnapshot(f.root);const advance=s=>new Date(Date.parse(s)+60000).toISOString();for(const k of ['createdAt','finishedAt'])b[k]=advance(b[k]);for(const k of ['startedAt','finishedAt'])b.domainProof[k]=advance(b.domainProof[k]);for(const side of ['before','after']){const p=b.domainProof[side];p.sourceHash=b.snapshot.hash;p.remoteSourceHash=b.snapshot.hash;p.sourceManifest=b.snapshot.files;for(const k of ['startedAt','finishedAt'])p[k]=advance(p[k]);}const id=p=>({status:'verified',sourceHash:p.snapshot.hash,store:'fixture.myshopify.com',themeId:'1'});return {...f,a,b,left:id(a),right:id(b),groups:[{url:f.url,device:'mobile'}]};}
test('formal integrity binds both deployments, matrix and config before assessing findings',async t=>{const f=await setup(t),run=(a=f.a,b=f.b)=>checkFormalRuntimeIntegrity({before:[a],after:[b]},f.left,f.right,f.groups);assert.equal(run().pass,true);for(const edit of [p=>p.themeId='2',p=>p.domainProof.before.store='other',p=>p.config.device='desktop',p=>p.config.state='another',p=>p.config.actions=[{type:'wait',ms:1}],p=>p.browserVersion='different',p=>delete p.initial.integrity,p=>p.afterActions.integrity.eventsTruncated=true]){const b=structuredClone(f.b);edit(b);assert.equal(run(f.a,b).pass,false);}assert.equal(checkFormalRuntimeIntegrity(undefined).status,'not-assessed');});
test('score gains cannot bypass a supplied suspect LCP or repeated initialization report',async t=>{
 const f=await setup(t),pages=[{id:'home',url:f.url}];const before=await siteRun(t,{devices:['mobile'],pages,scores:{mobile:[50]}}),after=await siteRun(t,{devices:['mobile'],pages,scores:{mobile:[85]},offset:20});await proof(before,f.a.snapshot,f.root);await proof(after,f.b.snapshot,f.root);
 const regression=regressionForRun(after),input={before:before.root,after:after.root,regression,expectedSourceHash:f.b.snapshot.hash,review:{sourceHash:f.b.snapshot.hash,contentPreserved:true,visualsPreserved:true,summary:'Synthetic contract only'}};
 const legacy=await verifyOptimization(input);assert.equal(legacy.outcome,'optimization-accepted');assert.equal(legacy.runtimeIntegrity.status,'not-assessed');
 regression.integrityProfiles={before:[f.a],after:[f.b]};assert.equal((await verifyOptimization(input)).outcome,'optimization-accepted');
 f.b.initial.integrity.lcpEntries[0].identity.effectiveOpacity=.0001;let result=await verifyOptimization(input);assert.equal(result.outcome,'not-accepted');assert.equal(result.checks.find(c=>c.id==='runtime-metric-and-loading-integrity').pass,false);
 f.b.initial.integrity.lcpEntries[0].identity.effectiveOpacity=1;f.b.afterActions.integrity.events=[{name:'StartAsyncLoading',target:'document',atMs:300},{name:'StartAsyncLoading',target:'document',atMs:301}];result=await verifyOptimization(input);assert.equal(result.outcome,'not-accepted');assert.ok(result.runtimeIntegrity.reports.some(r=>r.repeatedEvents.length));
});
