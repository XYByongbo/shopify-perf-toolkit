import { indexThemeSources, publicSourceIndex, pathsToSource } from './source-attribution.mjs';
import { sha256 } from './runtime-profile.mjs';
import { readRunEvidence,normalizeEvidenceUrl } from './run-evidence.mjs';
import { validateDomainCandidate } from './domain-candidates.mjs';
import {parseLiquidAsset,effectiveAssetSettings,associateLiquidAsset} from './liquid-assets.mjs';

const mapped = source => ['verified-bytes','verified-ast'].includes(source?.status);
function validateScope(profiles, limit) {
  if (!Array.isArray(profiles) || profiles.length > 24 || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error('Provide at most 24 profiles and limit 1..20.');
  }
}

export async function diagnoseBottlenecks({ project, profiles = [], run, liquidProfile, limit = 3, sourceSession } = {}) {
  validateScope(profiles, limit);
  return diagnoseIndexedBottlenecks(await indexThemeSources(project, {session:sourceSession}), {profiles, run, liquidProfile, limit});
}

export async function diagnoseIndexedBottlenecks(index, { profiles = [], run, liquidProfile, limit = 3 } = {}) {
  validateScope(profiles, limit);
  const observations = [], issues = [];
  const local = new Map(index.snapshot.files.map(f => [f.file,f.sourceHash]));
  const reports = run ? (await readRunEvidence(run,{ allowExploration: true })).groups.flatMap(g => g.records.map(r => ({ report: r.report, device: g.device }))) : [];
  const add = item => {
    const verified = mapped(item.source) && local.get(item.source.file) === item.source.sourceHash;
    const file = verified ? item.source.file : null;
    observations.push({ ...item, file, eligible: Boolean(item.eligible && verified), line: verified ? item.source.line ?? null : null,
      association: verified ? item.source.status : 'unmapped', controllability: verified ? 'theme-code' : 'requires-source-review',
      paths: file ? pathsToSource(index,file) : [], candidateId: sha256(JSON.stringify([index.snapshot.hash,item.kind,file,item.line,item.source?.column,item.source?.offset,verified?null:item.url,item.metric,item.page?normalizeEvidenceUrl(item.page):item.page,item.device,item.state])).slice(0,24) });
  };
  for (const [profileIndex, profile] of profiles.entries()) {
    if (profile.kind !== 'runtime-profile' || profile.status !== 'complete' || !profile.sourceStable || profile.snapshot?.hash !== index.snapshot.hash) {
      issues.push({ profileIndex, reason: 'incomplete-or-stale-runtime-profile' }); continue;
    }
    const scope = { profileIndex, page: profile.config.url, device: profile.config.device, state: profile.config.state };
    for (const row of profile.cpu ?? []) if (row.selfMs >= 10 && row.url) add({ kind: 'cpu', metric: 'tbt', ...scope, url: row.url, source: row.source, line: row.source?.line,liquidAssetEvidence:liquidCandidateEvidence(profile,row.source,index.files),
      function: row.functionName, callPath: row.callPath ?? [], costMs: row.selfMs, inclusiveMs: row.inclusiveMs, eligible: mapped(row.source) && row.selfMs >= 50 && (!profile.config.actions?.length || profile.cpuWindow === 'navigation-through-initial-settle'),
      evidence: 'Sampled self CPU over this diagnostic window; inclusive time overlaps, and this is not TBT or guaranteed savings.',
      action: 'Trace this function and its callers; remove unnecessary execution or scope the component to its render site.' });
    for (const resource of profile.resources ?? []) {
      const blocking = profile.renderResources?.find(r => r.url === resource.url &&
        (r.tag === 'link' && (!r.media || r.media === 'all') || r.blocking?.split(/\s+/).includes('render') || r.tag === 'script' && r.inHead && !r.async && !r.defer && r.type !== 'module'));
      if (!blocking) continue;
      const durationMs = Number.isFinite(resource.finishedTimestamp) && Number.isFinite(resource.timestamp) ? (resource.finishedTimestamp-resource.timestamp)*1000 : null;
      add({ kind: 'render-resource', metric: 'lcp', ...scope, url: resource.url, source: resource.source, costMs: durationMs,liquidAssetEvidence:liquidCandidateEvidence(profile,resource.source,index.files),
        eligible: mapped(resource.source) && durationMs >= 100, renderDelayMs: profile.lcp?.renderDelayMs ?? null,
        evidence: 'Render-blocking markup and observed request duration; requests may overlap. Confirm the critical path before attributing a saving.',
        action: resource.type === 'Stylesheet' ? 'Build critical CSS from the declared multi-state coverage matrix.' : 'Review loading dependencies and component reachability; retain app/business behavior.' });
    }
    for (const entry of profile.coverage?.css ?? []) {
      const resource = profile.resources.find(r => r.url === entry.url && mapped(r.source));
      if (!resource || entry.sourceHash !== local.get(resource.source.file)) continue;
      const bytes = entry.totalBytes-entry.usedBytes;
      if (bytes >= 4096) add({ kind: 'css-coverage', metric: 'lcp', ...scope, source: resource.source, url: entry.url, costMs: null, unusedBytes: bytes, eligible: false,
        evidence: 'Unused only in this recorded state. Combine with render-blocking evidence and other states; never remove globally from one sample.', action: 'Collect other templates, breakpoints and interactive states before splitting.' });
    }
  }
  // LHR findings supplement, never fabricate source identity from filenames or estimate additive score gains.
  for (const { report, device } of reports) {
    if (report.runWarnings?.length) { issues.push({ page: report.requestedUrl, reason: 'lighthouse-warnings', warnings: report.runWarnings }); continue; }
    for (const item of report.audits?.['render-blocking-insight']?.details?.items ?? []) if (item.url) {
      observations.push({ kind: 'lhr-render-resource', metric: 'lcp', url: item.url, device, page: report.requestedUrl,
        estimatedOpportunityMs: item.wastedMs ?? null, eligible: false, association: 'unmapped', evidence: 'Lighthouse estimate; use runtime byte/AST proof to associate local code. Not additive savings.' });
    }
  }
  if (liquidProfile) {
    const current = liquidProfile.status === 'complete' && liquidProfile.sourceSnapshot?.hash === index.snapshot.hash;
    if (!current) issues.push({ reason: 'incomplete-or-stale-liquid-profile' });
    else for (const row of liquidProfile.hotspots ?? []) observations.push({ kind: 'liquid', metric: 'ttfb', file: row.file, line: row.line, sourceHash: row.sourceHash,
      costMs: row.selfMs, inclusiveMs: row.inclusiveMs, association: row.association, eligible: false, paths: row.file ? pathsToSource(index,row.file) : [],
      evidence: 'Liquid self time, not browser TTFB. Verify deployed source before generating a hotspot patch.', action: 'Inspect repeated pure filters or renders in this measured frame.' });
  }
  for(const item of observations)if(item.source?.scriptKind==='liquid-asset'&&!replayLiquidSource(item,index.snapshot))item.eligible=false;
  const eligible = observations.filter(o => o.eligible);
  // Repeated observations are not summed. Rank the largest observed self cost for each independent hypothesis.
  const unique = new Map();
  for (const row of eligible) if (!unique.has(row.candidateId) || unique.get(row.candidateId).costMs < row.costMs) unique.set(row.candidateId,row);
  const candidates = [...unique.values()].sort((a,b) => b.costMs-a.costMs).slice(0,limit);
  return { schemaVersion: 1, kind: 'bottleneck-diagnosis', sourceHash: index.snapshot.hash, graph: publicSourceIndex(index),
    status: issues.length ? 'review-required' : candidates.length ? 'candidates-ready' : 'no-supported-candidate', candidates, observations, issues,
    limitations: ['Observed cost ranks investigations, not predicted score gain.', 'Unmapped/opaque scripts and dynamic dependencies remain visible; no automatic app removal.', 'Coverage and CPU diagnostics cannot substitute for an independent score experiment.'] };
}

export function requireHypothesis(diagnosis, candidateId, snapshot, target) {
  if (diagnosis?.kind !== 'bottleneck-diagnosis' || diagnosis.sourceHash !== snapshot.hash) throw new Error('Diagnosis is missing or belongs to different source.');
  const item = diagnosis.candidates?.find(c => c.candidateId === candidateId);
  const domain=item?.source?.status==='verified-domain-source'&&validateDomainCandidate(item,{...snapshot,complete:sha256(JSON.stringify(snapshot.files))===snapshot.hash});
  if (!item?.eligible || !(mapped(item.source)||domain) || (target && item.file !== target) || !snapshot.files.some(f => f.file === item.file && f.sourceHash === item.source.sourceHash)) throw new Error('Select a source-verified, material-cost candidate for this target.');
  if(/\.m?js\.liquid$/.test(item.file)&&!replayLiquidSource(item,snapshot))throw new Error('Compiled Liquid asset proof cannot be replayed against current sources and settings.');
  return item;
}

export function replayLiquidSource(item,snapshot) {
  try {
    const e=item.liquidAssetEvidence;if(!e||e.template.file!==item.file||sha256(e.template.text)!==item.source.sourceHash||e.template.sourceHash!==item.source.sourceHash
      ||[e.template,...e.configFiles].some(f=>sha256(f.text)!==f.sourceHash||!snapshot.files.some(s=>s.file===f.file&&s.sourceHash===f.sourceHash)))return false;
    const settings=effectiveAssetSettings(e.configFiles),unit={...e.template,model:parseLiquidAsset(e.template.text)};
    const mapped=associateLiquidAsset(e.response,unit,settings,{line:item.source.runtimeLine,column:item.source.runtimeColumn});
    return mapped&&['file','sourceHash','bodyHash','offset','line','column'].every(k=>mapped[k]===item.source[k])&&sha256(JSON.stringify(mapped.liquidProof))===sha256(JSON.stringify(item.source.liquidProof));
  }catch{return false;}
}

export function liquidCandidateEvidence(profile,source,files) {
  if(source?.scriptKind!=='liquid-asset')return undefined;
  const template=files.find(f=>f.file===source.file),compiled=profile.compiledAssets?.find(f=>f.bodyHash===source.bodyHash&&sha256(f.text)===f.bodyHash);
  return template&&compiled?{template:{file:template.file,text:template.text,sourceHash:template.sourceHash},response:compiled.text,
    configFiles:files.filter(f=>['config/settings_schema.json','config/settings_data.json'].includes(f.file)).map(({file,text,sourceHash})=>({file,text,sourceHash}))}:null;
}
