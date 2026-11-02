import {normalizeEvidenceUrl} from './run-evidence.mjs';
import {resourceHealth} from './resource-intelligence.mjs';
import {validDomainProfile} from './domain-profile.mjs';
import {targetNodes} from './domain-candidates.mjs';
import {literalAttribute} from './performance-syntax.mjs';

const definitions=[
  ['baseline','固定基线',['source-identity','original-metric-goal','independent-samples']],
  ['resources','恢复失效资源',['browser-GET-and-decode','approved-original-hash','corrected-content-baseline']],
  ['first-paint','首屏图片与内容',['initial-Liquid-content','LCP-discovery-transfer-render','shared-instance-preservation']],
  ['styles-fonts','CSS 与字体',['cascade-and-actual-font-use','multi-state-coverage','style-work-not-link-count']],
  ['scripts-apps','JavaScript 与 App',['ordered-producer-consumer','first-interaction','actual-script-and-business-response']],
  ['liquid-query','Liquid 与查询',['raw-Shopify-self-time','call-context','unchanged-visible-items-and-pagination']],
  ['hidden-content','隐藏内容',['actual-initial-cost','complete-first-open','no-JS-contract']],
  ['acceptance','独立验证与重新诊断',['original-score-and-gain-gates','content-layout-interaction','retain-negative-evidence']],
];
export function candidateStage(c) {
  if(['image-lcp','image-cls','section-fetch'].includes(c.kind))return 'first-paint';
  if(c.kind==='stylesheet'||c.kind==='render-resource'&&/\.css$/.test(c.file))return 'styles-fonts';
  if(['liquid-hotspot','liquid-query','liquid-render'].includes(c.kind))return 'liquid-query';
  if(c.kind==='hidden-dom')return 'hidden-content';
  return 'scripts-apps';
}
export function buildThemeWorkflow({snapshot,profiles=[],candidates=[],history=[],groups=[],identity,files=[],knownResourceFailures,intelligence}) {
  const valid=profiles.filter(p=>p.kind==='runtime-profile'&&validDomainProfile(p,snapshot));
  const nodes=targetNodes(files.filter(f=>/^(sections|snippets|layout|templates|blocks)\//.test(f.file)));
  const issues=valid.flatMap(p=>{
    const h=p.resourceHealthAfter??p.resourceHealth;
    if(h?.version!==1||!Array.isArray(h.images))return [];
    return h.images.filter(i=>i.complete===true&&i.decoded===false).map(i=>{
      const matches=nodes.filter(n=>{try{return n.tag==='img'&&n.id&&'#'+n.id===i.selector&&!n.attrs.has('srcset')&&new URL(literalAttribute(n.node,'src')?.replace(/&amp;/g,'&'),p.config.url).href===i.url
        &&p.domainTargets?.some(t=>t.id===n.id&&t.idCount===1&&!t.inPicture);}catch{return false;}});
      return {page:p.config.url,device:p.config.device,selector:i.selector,url:i.url,...(matches.length===1?{binding:{target:matches[0].file,offset:matches[0].offset,sourceHash:matches[0].sourceHash}}:{}),
        action:matches.length===1?'plan-resource-repair':'bind-failed-resource-source',requiredInputs:['exact source target/offset','approved replacement URL and SHA-256','original asset content review'],performanceClaim:false};
    });
  });
  const failures=knownResourceFailures??issues.filter(i=>i.binding);
  const health=resourceHealth(valid),unbound=issues.filter(i=>!i.binding);
  const fontTasks=(intelligence?.fonts?.reviewTasks??[]).map(t=>({...t,stage:'styles-fonts',action:'analyze-code',requiresCostAndUsageEvidence:true}));
  const resourceTasks=(intelligence?.resources?.captures??[]).flatMap(c=>(c.resourceGroups??[]).flatMap(group=>{
    const requests=c.requests.filter(r=>r.resourceGroupId===group.id),request=requests[0];
    if(!request||!(group.cpuSelfMs>=50||requests.some(r=>r.requestMs>=100)))return [];
    return [{stage:['Stylesheet','Font'].includes(request.type)?'styles-fonts':request.type==='Image'?'first-paint':'scripts-apps',
      page:c.page,device:c.device,url:group.url,file:request.source?.file??null,action:request.next,
      cpuSelfMs:group.cpuSelfMs,requestDurationsMs:requests.map(r=>r.requestMs),estimatedSavings:null,requiresCostAndUsageEvidence:true}];
  }));
  const reviewTasks=[...resourceTasks,...fontTasks];
  const ready=candidates.filter(c=>!c.gainCeiling?.blocked&&(!c.methods||c.remainingMethods===undefined||c.remainingMethods.length));
  const relevant=issue=>!ready.length||ready.some(c=>c.device===issue.device&&normalizeEvidenceUrl(c.page)===normalizeEvidenceUrl(issue.page));
  const blockingFailures=failures.filter(relevant),blockingUnbound=unbound.filter(relevant);
  const stages=definitions.map(([id,title,verification],i)=>({step:i+1,id,title,verification,
    status:id==='baseline'?(identity?.status==='verified'?'identity-bound':'requires-measurement')
      :id==='resources'?(failures.length?'repair-required':unbound.length?'source-binding-required':health.some(h=>h.status==='partial')?'partial-health-coverage':health.length&&health.every(h=>h.status==='no-failure-observed')?'no-failed-image-observed':'requires-browser-health-evidence')
        :id==='acceptance'?'independent-formal-verification-required':ready.some(c=>candidateStage(c)===id)?'executable-candidate':'no-measured-candidate',
    reviewTasks:reviewTasks.filter(t=>t.stage===id),
    candidates:ready.filter(c=>candidateStage(c)===id).map(c=>({candidateId:c.candidateId,file:c.file,page:c.page,device:c.device,
      method:c.remainingMethods?.[0]??c.methods?.[0]??null,route:c.methods?'plan-domain':c.officialMethods?.some(m=>m.executor==='demand:critical-css')?'plan-demand':'plan-site',
      availableOfficialExecutors:c.officialMethods??[],reviewRequired:true}))}));
  const next=blockingFailures.length?{action:'restore-approved-content',failures:blockingFailures}
    :blockingUnbound.length?{action:'bind-failed-resource-source',issues:blockingUnbound}
    :ready.length?{action:'prepare-source-bound-patch',stage:candidateStage(ready[0]),candidateId:ready[0].candidateId,method:ready[0].remainingMethods?.[0]??ready[0].methods?.[0]??null}
      :resourceTasks.length?{action:'review-resource-cost-and-strategy',tasks:resourceTasks}
      :fontTasks.length?{action:'review-font-cost-and-strategy',tasks:fontTasks}
      :{action:'collect-missing-cost-evidence-or-stop',reason:'No untested, source-bound mechanism remains; do not repeat score sampling or relax gates.'};
  return {version:1,kind:'theme-optimization-workflow',stages,next,health,reviewTasks,resourceFailures:failures,unboundResourceIssues:issues.filter(i=>!i.binding),
    formalSampleMatrixComplete:groups.length?groups.every(g=>g.samples>=5):false,
    failedMechanisms:history.filter(h=>h.outcome!=='invalid-evidence').map(h=>({method:h.method,outcome:h.outcome,hypothesisKey:h.hypothesisKey})),
    noGainFlow:['confirm-deployment-and-mechanism-execution','read-bound-original-cost-and-critical-path','exclude-equivalent-mechanism','prepare-different-source-bound-cost-or-stop'],
    contentRepairIsNotPerformanceGain:true};
}
