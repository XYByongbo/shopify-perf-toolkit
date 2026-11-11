import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {readThemeSource} from './core/source-reader.mjs';
import {fields,readEvidenceJSON,digest} from './evidence-contract.mjs';
import {importCheck} from './check-import.mjs';
import {sourceSnapshot} from './theme-source.mjs';
import {requiredThemeChecks,effectiveCheckState} from './theme-check-project.mjs';
import {verificationPlan} from './standards-policy.mjs';
import {normalizeEvidenceUrl} from './run-evidence.mjs';

async function artifact(ref) {
  fields(ref,['artifact','sha256','id'],'standards artifact');
  if(typeof ref.artifact!=='string'||!path.isAbsolute(ref.artifact)||!/^[a-f0-9]{64}$/.test(ref.sha256??''))throw new Error('Standards evidence requires an absolute artifact path and SHA-256.');
  return readEvidenceJSON(ref.artifact,{hash:ref.sha256});
}
const same=(a,b)=>digest(a)===digest(b);
const gate=(id,status,reason,detail={})=>({id,pass:status==='PASS'||status==='N/A',checkStatus:status,
  ...(status==='NOT RUN'?{executed:false}:{}),...(status==='N/A'?{applicable:false}:{}),reason,...detail});

/** Re-import raw official output against retained source directories; never trust saved PASS/complete flags. */
export async function verifyThemeCheckDelta(input,beforeManifest,afterManifest) {
  if(!input)return gate('theme-check-delta','NOT RUN','Before/after Theme Check artifacts were not supplied.');
  try {
    fields(input,['before','after','warningReviews'],'Theme Check delta');
    const imported=[];
    for(const [side,manifest] of [['before',beforeManifest],['after',afterManifest]]) {
      const saved=await artifact(input[side]);
      if(saved.kind!=='check-import'||!saved.rawReport||saved.metadata?.scope!=='project-theme-check-v1')throw new Error('Use check-theme artifacts with raw official output and project configuration.');
      const snapshot=await sourceSnapshot(saved.project);
      if(!snapshot.complete||!same(snapshot.files,manifest)||saved.sourceHash!==snapshot.hash)throw new Error('Theme Check source differs from measured deployment; retain both checked source directories.');
      if(saved.rawReportHash!==digest(saved.rawReport))throw new Error('Theme Check raw report fingerprint mismatch.');
      let currentConfig=null;try{currentConfig=await readFile(path.join(saved.project,'.theme-check.yml'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
      if(currentConfig!==saved.metadata.rulesConfig?.projectConfiguration)throw new Error('Project Theme Check configuration changed after execution.');
      const report=await importCheck({project:saved.project,input:saved.rawReport,metadata:saved.metadata});
      if(!report.complete||!same([...report.metadata.scannedFiles].sort(),manifest.map(f=>f.file).sort()))throw new Error('Theme Check coverage is incomplete.');
      const effective=report.metadata.rulesConfig?.effectiveConfiguration;
      if(typeof effective!=='string')throw new Error('Missing effective Theme Check configuration.');
      const ignored=[...effective.matchAll(/^\s*ignore:\s*\n((?:[ \t]+- [^\n]*\n?)+)/gm)].flatMap(m=>[...m[1].matchAll(/-\s+(.+)/g)].map(x=>x[1].trim().replace(/^['"]|['"]$/g,'')));
      if(ignored.some(pattern=>pattern!=='node_modules/**'))return gate('theme-check-delta','NOT RUN','Project ignore patterns restrict official scan coverage; review them explicitly.',{ignored});
      report.suppressions=[];
      for(const f of snapshot.files.filter(f=>f.file.endsWith('.liquid'))){const {source}=await readThemeSource(saved.project,f.file,f.sourceHash);for(const m of source.matchAll(/theme-check-disable(?:-next-line)?[^\r\n%}]*/g))report.suppressions.push([f.file,m[0].trim()]);}
      const states=requiredThemeChecks.map(id=>({id,state:effectiveCheckState(effective,id)}));
      const missing=states.filter(r=>r.state==='unavailable'),disabled=states.filter(r=>r.state==='disabled');
      if(missing.length)return gate('theme-check-delta','NOT RUN','Required official rules absent from the effective configuration; enable supported rules or update the checker.',{missing});
      if(disabled.length)return gate('theme-check-delta','FAIL','Required official rules disabled.',{disabled});
      const commands=saved.execution?.commands;
      if(!Array.isArray(commands)||!['--version','--list','--print','--output'].every(flag=>commands.some(c=>c.args?.includes(flag)))
        ||commands.some(c=>![0,1].includes(c.exitCode))
        ||!commands.some(c=>c.args?.includes('--output')&&digest(JSON.parse(c.stdout))===saved.rawReportHash))throw new Error('Incomplete official execution record.');
      imported.push(report);
    }
    const [a,b]=imported;
    const oldSuppressions=new Map();for(const row of a.suppressions){const k=digest(row);oldSuppressions.set(k,(oldSuppressions.get(k)??0)+1);}
    for(const row of b.suppressions){const k=digest(row),n=oldSuppressions.get(k)??0;if(!n)throw new Error('New inline Theme Check suppression requires separate review; it cannot establish a passing delta.');oldSuppressions.set(k,n-1);}
    for(const key of ['tool','toolVersion','cliVersion','scope','rulesConfig','severityMap','positionBase'])if(!same(a.metadata[key],b.metadata[key]))throw new Error(`Theme Check ${key} changed; establish a comparable baseline.`);
    const remaining=new Map();for(const f of a.findings){const key=digest([f.fingerprint,f.severity]);remaining.set(key,(remaining.get(key)??0)+1);}
    const added=[];for(const f of b.findings){const key=digest([f.fingerprint,f.severity]),n=remaining.get(key)??0;if(n)remaining.set(key,n-1);else added.push(f);}
    const reviews=input.warningReviews??[];
    if(!Array.isArray(reviews)||reviews.some(r=>!r||typeof r.fingerprint!=='string'||!r.reason?.trim()||!r.reviewer?.trim()))throw new Error('Warning reviews require fingerprint, reason and reviewer.');
    const newErrors=added.filter(f=>f.severity==='error');
    const unreviewedWarnings=added.filter(f=>f.severity==='warning'&&!reviews.some(r=>r.fingerprint===f.fingerprint));
    return gate('theme-check-delta',newErrors.length||unreviewedWarnings.length?'FAIL':'PASS',
      'Official E0 comparison only; existing debt remains visible and does not prove runtime correctness.',
      {newErrors,unreviewedWarnings,added,existing:b.findings.filter(f=>!added.includes(f)),warningReviews:reviews});
  }catch(error){return gate('theme-check-delta','FAIL',error.message);}
}

export async function verifyStandardsEvidence({input,beforeManifest,afterManifest,sourceHash,pages}) {
  if(input!==undefined)fields(input,['themeCheck','scope','checks'],'standardsEvidence');
  const plan=verificationPlan({beforeFiles:beforeManifest,afterFiles:afterManifest,scope:input?.scope});
  const measured=[...new Set(pages.map(normalizeEvidenceUrl))];
  if(plan.pages.length&&(!measured.every(url=>plan.pages.map(normalizeEvidenceUrl).includes(url))||!plan.pages.map(normalizeEvidenceUrl).every(url=>measured.includes(url))))throw new Error('Declared page scope must match the measured page matrix.');
  plan.pages=[...new Set([...measured,...plan.pages.map(normalizeEvidenceUrl)])];
  const refs=input?.checks??[];
  if(!Array.isArray(refs)||new Set(refs.map(r=>r.id)).size!==refs.length||refs.some(r=>!plan.checks.some(c=>c.id===r.id)))throw new Error('Unknown or duplicate scoped evidence check.');
  const checks=[await verifyThemeCheckDelta(input?.themeCheck,beforeManifest,afterManifest)];
  for(const requirement of plan.checks) {
    const ref=refs.find(r=>r.id===requirement.id);let result;
    if(!ref)result=gate(requirement.id,'NOT RUN','No scoped observation artifact supplied.');
    else try {
      const raw=await artifact(ref);
      if(raw.schemaVersion!==1||raw.kind!=='standards-check-observation'||raw.checkId!==requirement.id||raw.sourceHash!==sourceHash
        ||raw.evidenceLevel!==requirement.evidenceLevel||!raw.reviewer?.trim()||!raw.observation?.trim()||!Number.isFinite(Date.parse(raw.observedAt)))throw new Error('Observation identity, evidence level, reviewer or observation missing.');
      if(!['PASS','FAIL','N/A'].includes(raw.status))throw new Error('Observation must report an actual result or a reasoned N/A.');
      if(raw.status==='N/A') {
        if(!['component-isolation','multi-instance','editor-lifecycle','keyboard-motion'].includes(requirement.id)||!raw.reason?.trim())throw new Error('This check needs execution; N/A is unsupported or lacks a reason.');
      }else {
        if(!Array.isArray(raw.conditions?.pages)||!plan.pages.every(url=>raw.conditions.pages.map(normalizeEvidenceUrl).includes(url)))throw new Error('Observation does not cover the declared page scope.');
        if(requirement.id==='responsive-layout'&&(!Array.isArray(raw.conditions.widths)||!plan.widths.every(w=>raw.conditions.widths.includes(w))))throw new Error('Responsive observation does not cover all required widths.');
      }
      result=gate(requirement.id,raw.status,raw.reason??raw.observation,{evidenceLevel:raw.evidenceLevel,artifact:ref.artifact,sha256:ref.sha256,conditions:raw.conditions,reviewer:raw.reviewer});
    }catch(error){result=gate(requirement.id,'FAIL',error.message);}
    result.blocking=requirement.blocking;checks.push(result);
  }
  return {plan,checks,pass:checks.filter(c=>c.blocking!==false).every(c=>c.pass),
    fieldStatus:'not-established',limitations:['Manual observations are reviewer attestations tied to saved artifacts, not independent automatic browser proof.','Post-release field follow-up is reported separately and cannot authorize publication.']};
}
