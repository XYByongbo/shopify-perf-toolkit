import { readRunEvidence } from './run-evidence.mjs';

export function median(values) {
  const v = [...values].sort((a,b) => a-b), n = v.length;
  return n ? n % 2 ? v[(n-1)/2] : (v[n/2-1]+v[n/2])/2 : null;
}
export async function summarizeRun(run) {
  const e = await readRunEvidence(run, { allowPartial: true, allowExploration: true });
  const groups = e.groups.map(g => {
    const scores = g.records.map(x => Math.round(x.report.categories.performance.score * 100));
    const lcp = g.records.map(x => x.report.audits['largest-contentful-paint'].numericValue);
    return { pageId: g.pageId, device: g.device, status: g.status, scores, minimum: scores.length ? Math.min(...scores) : null,
      median: median(scores), lcpMedianMs: median(lcp), warnings: g.records.filter(x => x.report.runWarnings?.length).length,
      failedAttempts: (g.attempts ?? []).filter(x => x.status === 'failed').length, reportsDirectory: g.reportsDirectory };
  });
  return { schemaVersion: 1, kind: 'measurement-summary', run: e.root, engine: e.manifest.engine,
    purpose: e.manifest.config.purpose ?? 'acceptance', status: e.manifest.status, counts: e.manifest.counts ?? null,
    stopped: e.manifest.stopped ?? null, groups, issues: e.issues, acceptance: 'not-evaluated-use-verify-site',
    evidence: { manifestSha256: e.manifestHash, rawReportsRetained: true },
    scope: 'All listed samples, including warnings and failures. This is not visual/functional or score acceptance.' };
}

/** Bound only the console copy; the complete JSON remains on disk. Never selects best samples. */
export function compactArtifact(value, { maxBytes = 4096, maxGroups = 8 } = {}) {
  if(!Number.isInteger(maxBytes)||maxBytes<1024||!Number.isInteger(maxGroups)||maxGroups<1)throw new Error('Invalid summary bounds.');
  if (!value.groups && !value.findings && Buffer.byteLength(JSON.stringify(value)) <= maxBytes) return value;
  const result = { kind: value.kind ?? 'artifact' };
  for (const k of ['status','outcome','purpose','output','run','counts','summary','stopped','acceptance','reviewRequired','diagnostics','evidence','decision','goal','fieldStatus']) {
    if (value[k] !== undefined) result[k] = value[k];
  }
  if (value.groups) {
    result.groups = value.groups.slice(0, maxGroups).map(g => Object.fromEntries(['pageId','device','status','scores','minimum','median','warnings','failedAttempts']
      .filter(k => g[k] !== undefined).map(k => [k,g[k]])));
    result.omittedGroups = Math.max(0, value.groups.length - result.groups.length);
  }
  if(value.workflow)result.workflow={next:value.workflow.next?.action,reviewTasks:value.workflow.reviewTasks?.length??0,resourceFailures:value.workflow.resourceFailures?.length??0,unboundResources:value.workflow.unboundResourceIssues?.length??0};
  if(value.intelligence)result.intelligence={resourceCaptures:value.intelligence.resources?.captures.length??0,
    rejectedProfiles:value.intelligence.resources?.rejectedProfiles.length??0,fontReviewTasks:value.intelligence.fonts?.reviewTasks.length??0,
    generatedFiles:value.intelligence.ownership?.filter(f=>f.generators?.length).length??0,observationChanges:value.observationChanges?.status??'not-requested'};
  if (value.findings) result.findingCount = value.findings.length;
  if(value.kind==='rendered-html-audit') {
    result.input=value.input;result.scope=value.scope;result.sourceAssociation=value.sourceAssociation;
    result.findingsTruncated=value.findings_truncated;
  }
  if(value.kind==='batch-run' && value.diagnostics?.renderedHtml) {
    const html=value.diagnostics.renderedHtml,reports=html.reports??[];
    result.diagnostics={...value.diagnostics,renderedHtml:{status:html.status,inputs:html.inputs??reports.length,
      completed:html.completed??reports.length,failedArtifact:html.failedArtifact,
      errors:reports.reduce((n,r)=>n+r.errors,0),warnings:reports.reduce((n,r)=>n+r.warnings,0),sourceAssociation:html.sourceAssociation}};
  }
  if(value.kind==='field-evidence')result.groups=value.groups.slice(0,maxGroups).map(g=>({url:g.url,scope:g.scope,device:g.device,country:g.country,samples:g.samples,percentile:g.percentile,status:g.status,metrics:g.metrics}));
  if(value.kind==='app-attribution'){
    result.groups=value.groups.slice(0,maxGroups).map(g=>({device:g.device,state:g.state,phase:g.phase,owner:g.owner?.name??'unknown',selfMs:g.selfMs}));result.unknownResources=value.unknownResources;
  }
  if (value.candidates) result.candidates = value.candidates.slice(0,3).map(c => ({ candidateId: c.candidateId, file: c.file, line: c.line, kind: c.kind, metric: c.metric, costMs: c.costMs }));
  if (value.kind === 'source-graph') result.graph = { files: value.files.length, edges: value.edges.length, unresolved: value.unresolved.length, sourceHash: value.sourceHash };
  if (value.kind === 'patch-experiment-verification') { result.fingerprint=value.fingerprint; result.hypothesis=value.hypothesis; result.formalAcceptance=value.formalAcceptance; result.error=value.error; }
  if (value.strategies) {
    result.strategyCount = value.strategies.length;
    result.strategies = value.strategies.slice(0,12).map(s => ({ kind: s.kind, effect: s.effect }));
    result.details = 'Use --out or --format full for parameters, evidence requirements and boundaries.';
  }
  if(['shopify-docs-index','official-method-catalog'].includes(value.kind)){result.coverage=value.coverage;result.checkedAt=value.checkedAt??value.finishedAt;result.failures=value.failures;result.details='Read saved JSON or --format full for all method cards and contracts.';}
  if (value.kind === 'runtime-profile') result.profile = {
    resources: value.resources?.length ?? 0, mappedResources: value.resources?.filter(r => r.source?.status === 'verified-bytes').length ?? 0,
    jsCoverageEntries: value.coverage?.js?.length ?? 0, cssCoverageEntries: value.coverage?.css?.length ?? 0,
    lcp: value.lcp ?? null, trace: value.trace ?? null,
  };
  if (value.kind === 'optimization-run' && value.sourceHash) result.sourceHash = value.sourceHash;
  if (value.kind === 'improvement-session') {
    result.next=value.next; result.error=value.error; result.session=value.output+'/session.json';
    result.rounds=value.history.length; result.retained=value.retained.length;
    result.recovery=value.recovery; result.previewSyncRequired=value.previewSyncRequired;
  }
  if (value.kind === 'recovery-cycle') {
    result.session=value.session;result.error=value.error;result.recovery=value.recovery;
    result.plan=value.plan;result.reviewContentHash=value.reviewContentHash;
    result.steps=value.events?.length;result.pending=value.pending;
  }
  if(value.kind==='optimization-verification') {
    result.error=value.error;
    if(value.budget)result.budget={passed:value.budget.passed,scope:value.budget.scope,
      violations:value.budget.details.filter(d=>!d.passed).slice(0,3),
      violationCount:value.budget.details.filter(d=>!d.passed).length};
  }
  if (value.checks) result.checkCounts = value.checks.reduce((a,c) => {
    const status=c.status??(typeof c.pass==='boolean'?(c.pass?'pass':'fail'):'unknown');
    return {...a,[status]:(a[status]??0)+1};
  }, {});
  if (value.errors?.length) result.errorCount = value.errors.length;
  if (value.issues?.length) result.issueCount = value.issues.length;
  while (Buffer.byteLength(JSON.stringify(result)) > maxBytes && result.groups?.length) {
    result.groups.pop(); result.omittedGroups++;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) return { kind: String(result.kind).slice(0,96), status: String(value.status ?? value.outcome ?? 'see-full-artifact').slice(0,160),
    output: typeof value.output === 'string' && value.output.length < 512 ? value.output : undefined,
    summaryTruncated: true, detail: 'Read the saved full JSON; console output is capped.' };
  return result;
}
