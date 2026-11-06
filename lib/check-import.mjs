import {readThemeSource,relativeFile} from './core/source-reader.mjs';
export {readThemeSource} from './core/source-reader.mjs';
import {waiverCoverage} from './theme-governance.mjs';
import { sha256 as hash } from './source-utils.mjs';
import { realpath } from 'node:fs/promises';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const docs = 'https://shopify.dev/docs/api/liquid/';
export const correctionPolicy = { version: 2, verifiedAt: '2026-10-16', sources: [
  'https://shopify.dev/docs/storefronts/themes/tools/theme-check/checks/liquid-complexity',
  'https://shopify.dev/docs/storefronts/themes/tools/theme-check/checks/liquid-nesting-depth',
  `${docs}filters/structured_data`, `${docs}tags/content_for`, `${docs}tags/paginate`, `${docs}filters/img_url`,
] };
function category(rule) {
  if (/^(?:AssetSize|DeprecateLazysizes|DeprecateBgsizes|CdnPreconnect)/.test(rule)) return 'performance-candidate';
  if (/SpaceInsideBraces|SchemaJsonFormat|LiquidTag|VariableName/.test(rule)) return 'style';
  if (/Deprecated|IncludeToRender/.test(rule)) return 'compatibility';
  if (/Img|RemoteAsset|Blocking|AssetPreload|Pagination/.test(rule)) return 'performance-candidate';
  if (/NestedSnippet|TemplateLength|Unused|LiquidComplexity|LiquidNestingDepth/.test(rule)) return 'maintainability';
  return 'correctness-review';
}
function correction(rule, message, sourceLine, matched) {
  const basis = { policyVersion: correctionPolicy.version, sourceBinding: matched ? 'hash-matched' : 'unverified', automaticSuppression: false };
  if (rule === 'UnknownFilter' && /\bstructured_data\b/.test(message) && /\|\s*structured_data\b/.test(sourceLine)) return { ...basis,
    status: 'false-positive-candidate', reason: 'structured_data is a native Shopify filter. Re-run a compatible checker; object context still needs validation.', source: `${docs}filters/structured_data` };
  if (rule === 'SyntaxError' && /content_for/.test(message) && /\{%[-]?\s*content_for\s+(['"])blocks\1\s*-?%\}/.test(sourceLine)) return { ...basis,
    status: 'tool-compatibility-review', reason: 'This content_for blocks form is supported. The surrounding syntax may still be invalid; do not disable LiquidTag to suppress SyntaxError.', source: `${docs}tags/content_for` };
  if (rule === 'PaginationSize') {
    const size = sourceLine.match(/\bpaginate\s+[\w.]+\s+by\s+(\d+)\s*-?%\}/)?.[1];
    if (size && Number(size) >= 1 && Number(size) <= 250) return { ...basis, status: 'policy-review', reason: 'Literal page size is within the documented 1–250 range. Check whether the report uses an old platform limit or an intentional stricter project budget.', source: `${docs}tags/paginate` };
  }
  if (rule === 'DeprecatedFilter') return { ...basis, status: 'migration-review', reason: 'Deprecation is migration debt, not evidence of a scheduled outage. Preserve dimensions, crop and object semantics.', source: `${docs}filters/img_url` };
  if (/^(NestedSnippet|TemplateLength|LiquidComplexity|LiquidNestingDepth)$/.test(rule)) return { ...basis, status: 'measurement-required', reason: 'Complexity, control-flow nesting, snippet call depth and line count are distinct maintenance signals; measure Liquid rendering before claiming performance loss.' };
  if (rule === 'ImgWidthAndHeight') return { ...basis, status: 'layout-evidence-required', reason: 'Check CSS reserved aspect ratio and measured layout shifts before attributing CLS to missing dimensions.' };
  return null;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function baselineDiff(current, baseline) {
  if (!baseline) return { status: 'not-requested', gate: 'not-evaluated' };
  if (baseline.kind !== 'check-import' || baseline.schemaVersion !== 1 || !Array.isArray(baseline.findings)) throw new Error('Baseline must be a check-import report.');
  const reasons = [];
  for (const name of ['tool', 'toolVersion', 'positionBase', 'rulesConfig', 'scope', 'scannedFiles', 'severityMap']) {
    if (current.metadata[name] == null || baseline.metadata?.[name] == null || JSON.stringify(canonical(current.metadata[name])) !== JSON.stringify(canonical(baseline.metadata[name]))) reasons.push(`Missing or different ${name}.`);
  }
  if (!current.complete || !baseline.complete) reasons.push('Both reports require complete scan metadata and matching source fingerprints.');
  if (baseline.correctionPolicy?.version !== current.correctionPolicy.version) reasons.push('Correction policy differs.');
  if (reasons.length) return { status: 'not-comparable', gate: 'review-required', reasons };
  const buckets = new Map();
  for (const f of baseline.findings) { const entries = buckets.get(f.fingerprint) ?? []; entries.push(f); buckets.set(f.fingerprint, entries); }
  const added = [], existing = [], changed = [];
  for (const f of current.findings) {
    const old = buckets.get(f.fingerprint)?.shift();
    if (!old) added.push(f.id);
    else { existing.push(f.id); if (old.severity !== f.severity) changed.push({ id: f.id, before: old.severity, after: f.severity }); }
  }
  const absent = [...buckets.values()].flat().map(f => f.id);
  const newErrors = current.findings.filter(f => f.severity === 'error' && (added.includes(f.id) || changed.some(c => c.id === f.id))).map(f => f.id);
  return { status: 'comparable', gate: newErrors.length ? 'review-required' : 'no-new-errors', added, existing, absent, severityChanged: changed, newErrors,
    note: 'Absent means not reported under the same scan contract, not proven fixed. Corrections never silently waive errors. This gate is not performance or business acceptance.' };
}
/** Import native grouped Theme Check JSON or explicit report observations. No commands in reports are executed. */
export async function importCheck({ project, input, metadata = {}, baseline = null } = {}) {
  const root = await realpath(project);
  if (!object(metadata)) throw new Error('metadata must be an object.');
  metadata = structuredClone(metadata);
  if (Array.isArray(metadata.scannedFiles)) metadata.scannedFiles = [...new Set(metadata.scannedFiles.map(file => relativeFile(file, metadata.sourceRoot)))].sort();
  const native = Array.isArray(input);
  if (!native && (!object(input) || input.schemaVersion !== 1 || input.kind !== 'check-observations' || !Array.isArray(input.findings))) throw new Error('Expected grouped Theme Check JSON or check-observations schemaVersion 1.');
  const observations = [];
  if (native) {
    for (const group of input) {
      if (!object(group) || !Array.isArray(group.offenses) || typeof group.path !== 'string') throw new Error('Invalid native Theme Check group.');
      relativeFile(group.path, metadata.sourceRoot);
      for (const offense of group.offenses) observations.push({ ...offense, file: group.path, ruleId: offense.check, line: Number.isInteger(offense.start_row) && [0, 1].includes(metadata.positionBase) ? offense.start_row + 1 - metadata.positionBase : null, column: offense.start_column ?? null });
    }
  } else observations.push(...input.findings);
  if (observations.length > 100000) throw new Error('Report exceeds 100000 observations.');
  const findings = [], cache = new Map(), issues = [];
  for (const [index, raw] of observations.entries()) {
    if (!object(raw) || typeof raw.ruleId !== 'string' || !raw.ruleId || typeof (raw.message ?? raw.summary) !== 'string') throw new Error('Each observation needs ruleId and message.');
    const file = raw.file == null && !native ? null : relativeFile(raw.file, metadata.sourceRoot);
    const line = Number.isInteger(raw.line) && raw.line > 0 ? raw.line : null;
    const count = raw.count ?? 1;
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('count must be a positive integer.');
    if (file && !cache.has(file)) {
      try { cache.set(file, await readThemeSource(root, file)); }
      catch { cache.set(file, null); issues.push({ file, reason: 'Current source unavailable, changed or unsafe.' }); }
    }
    const current = cache.get(file), expectedHash = metadata.sourceHashes?.[file];
    const matched = !!current && typeof expectedHash === 'string' && expectedHash === current.sourceHash;
    const sourceLine = current && line ? current.source.split(/\r?\n/)[line - 1] : undefined;
    const severityValue = typeof raw.severity === 'number' ? metadata.severityMap?.[raw.severity] : raw.severity;
    const severity = ['error', 'warning', 'suggestion', 'style', 'info'].includes(severityValue) ? severityValue : 'unknown';
    const message = raw.message ?? raw.summary;
    findings.push({ id: `check-${index + 1}`, ruleId: raw.ruleId, file, line, count, severity, originalSeverity: raw.severity ?? null,
      summary: message, category: category(raw.ruleId), status: 'reported', priority: null,
      sourceHash: current?.sourceHash ?? null, sourceBinding: matched && sourceLine !== undefined ? 'hash-matched' : expectedHash && current ? 'mismatch-or-location-missing' : 'unverified',
      fingerprint: hash(JSON.stringify([file, raw.ruleId, message, sourceLine?.trim() ?? line, count])),
      correction: correction(raw.ruleId, message, sourceLine ?? '', matched),
      evidence: { original: raw, sourceLine: sourceLine ?? null },
      verification: ['Re-run the checker against the recorded source/configuration.', 'Confirm actual template, configuration and runtime impact before choosing priority or a patch.'] });
  }
  const contractReady = ['tool', 'toolVersion', 'scope'].every(key => typeof metadata[key] === 'string' && metadata[key].trim()) && object(metadata.rulesConfig)
    && object(metadata.severityMap) && [0, 1].includes(metadata.positionBase) && Array.isArray(metadata.scannedFiles) && metadata.scannedFiles.length > 0 && metadata.complete === true;
  let scopeMatched = contractReady;
  if (contractReady) {
    for (const name of metadata.scannedFiles) {
      const file = relativeFile(name, metadata.sourceRoot);
      if (!cache.has(file)) { try { cache.set(file, await readThemeSource(root, file)); } catch { cache.set(file, null); } }
      if (!cache.get(file) || cache.get(file).sourceHash !== metadata.sourceHashes?.[file]) scopeMatched = false;
    }
    if (findings.some(f => !metadata.scannedFiles.includes(f.file))) scopeMatched = false;
  }
  const complete = !!scopeMatched && findings.every(f => f.sourceBinding === 'hash-matched' && f.severity !== 'unknown' && f.count === 1);
  const result = { schemaVersion: 1, kind: 'check-import', project: root, complete, metadata, correctionPolicy,
    rawReportHash: hash(JSON.stringify(input)), reportSource: structuredClone(native ? metadata.reportSource ?? null : input.source ?? null), findings, issues,
    summary: { observations: findings.length, reportedOccurrences: findings.reduce((n, f) => n + f.count, 0), corrections: findings.filter(f => f.correction).length,
      byCategory: Object.fromEntries([...new Set(findings.map(f => f.category))].map(c => [c, findings.filter(f => f.category === c).reduce((n, f) => n + f.count, 0)])) },
    limitations: ['Import does not execute Theme Check or report instructions, modify source, or suppress diagnostics.',
      'PDF aggregate observations are report claims, not source findings; they cannot establish a passing baseline.',
      'Missing metadata, unknown numeric severity mapping, source drift and incomplete scans prevent comparable gating.',
      'Style counts, compatibility debt and performance evidence are separate; no speed improvement is inferred from issue counts.'] };
  result.comparison = baselineDiff(result, baseline);
  result.waivers=waiverCoverage(result);
  result.configurationChange={status:!baseline?'no-baseline':JSON.stringify(canonical(metadata.rulesConfig))===JSON.stringify(canonical(baseline.metadata?.rulesConfig))?'unchanged':'changed-requires-separate-observation-baseline',
    before:baseline?.waivers??(baseline?waiverCoverage(baseline):null),after:result.waivers,sourceChangeIsNotInferredFromCounts:true};
  return result;
}
