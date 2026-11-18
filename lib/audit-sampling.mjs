import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { readThemeSource } from './core/source-reader.mjs';
import { createRunDirectory } from './run-directory.mjs';
import { normalizeEvidenceUrl } from './run-evidence.mjs';
import { inspectPerformanceSource } from './performance-rules.mjs';
import { validateDomainProfileConfig } from './domain-profile.mjs';
import { validateProfileConfig } from './runtime-profile.mjs';
import { sourceSnapshot } from './theme-source.mjs';

const supportedRules = new Set([
  'PERF_DUAL_HERO', 'PERF_IMAGE_TAG_LOADING', 'PERF_IMAGE_TAG_SIZES', 'PERF_LCP_REVEAL', 'PERF_LCP_BACKGROUND',
]);

function imageSelector(image) {
  const classes = image?.className?.split(/\s+/).filter(value => /^[A-Za-z_][\w-]*$/.test(value)) ?? [];
  return classes.length ? 'img.' + classes.join('.') : null;
}

async function staticSelectors(finding, snapshot) {
  const file = snapshot.files.find(entry => entry.file === finding.file && entry.sourceHash === finding.sourceHash);
  if (!file) throw new Error('Finding source no longer matches the audited theme.');
  const {source} = await readThemeSource(snapshot.project,file.file,file.sourceHash);
  const inspected = inspectPerformanceSource({...file,source});
  const current = inspected.findings.find(entry => entry.id === finding.id);
  if (!current) throw new Error('Finding could not be reproduced from the current source.');
  const detail = current.evidence[0];
  const offsets = current.ruleId === 'PERF_DUAL_HERO' ? [detail.desktopOffset,detail.mobileOffset] : [current.offset];
  const imageSelectors = offsets.map(offset => imageSelector(inspected.images.find(image => image.offset === offset)));
  return imageSelectors.every(Boolean) ? imageSelectors : detail.selector ? [detail.selector] : [];
}

/** Translate a single current audit finding into ordinary read-only runtime profile configs. */
export async function planAuditSampling({audit,findingId,url,device='both',selector,themeId,store,settleMs,output}) {
  if (audit?.kind !== 'performance-audit' || audit.schemaVersion !== 1 || !path.isAbsolute(audit.project ?? '') || !Array.isArray(audit.findings)) {
    throw new Error('Provide a saved audit-performance report.');
  }
  const findings = audit.findings.filter(entry=>entry.id===findingId);
  const finding = findings[0];
  if (findings.length !== 1 || !supportedRules.has(finding.ruleId)) {
    throw new Error('Select one audit finding for image loading, responsive image sizing, dual heroes, LCP reveal, or LCP backgrounds.');
  }

  const snapshot = await sourceSnapshot(audit.project);
  if (!snapshot.complete || snapshot.hash !== audit.sourceHash) throw new Error('Audited source changed; rerun audit-performance.');
  const observed = finding.file ? null : finding.evidence?.find(entry=>entry.page && entry.selector);
  if (!finding.file && (!observed || normalizeEvidenceUrl(url) !== normalizeEvidenceUrl(observed.page))) {
    throw new Error('The URL must match the page recorded by this runtime finding.');
  }
  const inferred = finding.file ? await staticSelectors(finding,snapshot) : [observed.selector];
  const selectors = [...new Set(selector === undefined ? inferred : [selector])];
  if (!selectors.length) throw new Error('This finding has no stable literal selector. Supply --selector scoped to the actual rendered instance.');

  const page = new URL(url);
  const previewId = page.searchParams.get('preview_theme_id');
  if (themeId !== undefined && previewId !== null && themeId !== previewId) throw new Error('Theme ID differs from the explicit preview URL.');
  const expectedThemeId = themeId ?? previewId;
  if (expectedThemeId !== null && !/^\d+$/.test(expectedThemeId)) throw new Error('Expected a numeric theme ID.');
  if (!['both','mobile','desktop'].includes(device)) throw new Error('Use both, mobile or desktop for device.');
  const devices = device === 'both' ? ['mobile','desktop'] : [device];
  const configs = devices.map(device => validateProfileConfig({
    schemaVersion:1, project:snapshot.project, expectedSourceHash:snapshot.hash, url:page.href, device,
    targetSelectors:selectors, ...(settleMs === undefined ? {} : {settleMs}), ...(expectedThemeId === null ? {} : {expectedThemeId}),
  }));

  if (store !== undefined && expectedThemeId === null) throw new Error('Deployment-bound sampling needs a preview theme ID.');
  const command = store === undefined ? 'profile-runtime' : 'profile-domain';
  const captureConfigs = store === undefined ? configs : configs.map(config => {
    const {schemaVersion,project,url,expectedThemeId,...profile} = config;
    const request = {schemaVersion,mode:'runtime',url,deployment:{project,store,themeId:expectedThemeId},profile};
    validateDomainProfileConfig(request);
    return request;
  });

  const destination = path.resolve(output);
  const relative = path.relative(snapshot.project,destination);
  if (!relative || (!relative.startsWith('..'+path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Sampling output must be outside the theme.');
  }
  const out = await createRunDirectory(output);
  const save = (name,value) => writeFile(path.join(out,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  const captures = configs.map(config=>({
    device:config.device, config:path.join(out,`profile-${config.device}.json`), output:path.join(out,`capture-${config.device}`),
  }));
  for (const [index,config] of captureConfigs.entries()) await save(path.basename(captures[index].config),config);
  await save('profiles.json',captures.map(capture=>path.join(capture.output,'profile.json')));
  const result = {
    schemaVersion:1, kind:'audit-sampling-plan', output:out, sourceHash:snapshot.hash, url:page.href, selectors,
    finding:{id:finding.id,ruleId:finding.ruleId,file:finding.file,line:finding.line,summary:finding.summary},
    captures, profiles:path.join(out,'profiles.json'), command,
    evidence:['initial.lcp','lcp','domainTargetCoverage','domainTargets','resources'],
    scope:store === undefined
      ? 'Read-only browser diagnostics against audited local source. Deployment identity requires separate verification.'
      : 'Runtime evidence bracketed by deployment verification. Source mapping and patch gates still apply.',
  };
  await save('sampling.json',result);
  return result;
}
