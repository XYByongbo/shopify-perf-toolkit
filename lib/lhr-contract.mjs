import { createHash } from 'node:crypto';

const fail = (code, message) => Object.assign(new Error(message), { code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const score = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const METRICS = ['first-contentful-paint', 'largest-contentful-paint', 'speed-index', 'total-blocking-time', 'cumulative-layout-shift'];
// Keep the sampling contract aligned with check_score_target.py.
const THROTTLING_FIELDS = {
  simulate: { rttMs: 0, throughputKbps: 0, cpuSlowdownMultiplier: 1 },
  devtools: { requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0, cpuSlowdownMultiplier: 1 },
};

export function normalizeLhrUrl(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\x00-\x20\x7f\\]/.test(value)) {
    throw fail('INVALID_URL', 'Page URLs must be complete HTTP(S) URLs without whitespace or control characters.');
  }
  let url;
  try { url = new URL(value); } catch { throw fail('INVALID_URL', 'A valid HTTP(S) page URL is required.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw fail('INVALID_URL', 'Page URLs must use HTTP(S), without embedded credentials or fragments.');
  }
  return url.href;
}

/** Strict ISO calendar validation, retaining microseconds for equivalent-instant checks. */
export function canonicalFetchTime(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const invalid = () => fail('MISSING_FETCH_TIME', 'fetchTime must be a real calendar date in YYYY-MM-DDTHH:MM:SS[.1–6 digits](Z|±HH:MM) format.');
  if (!match) throw invalid();
  const [, y, mo, d, h, mi, s, fraction = '', zone] = match;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zoneHour = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
  const zoneMinute = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
      || hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59) throw invalid();
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  const offset = (zoneHour * 60 + zoneMinute) * (zone.startsWith('-') ? -1 : 1);
  const utc = new Date(local.getTime() - offset * 60000);
  if (utc.getUTCFullYear() < 1 || utc.getUTCFullYear() > 9999) throw invalid();
  return `${utc.toISOString().slice(0, -5)}.${fraction.padEnd(6, '0')}Z`;
}

function profileEvidence(report) {
  const userAgent = report.environment?.hostUserAgent || report.userAgent;
  if (typeof userAgent !== 'string' || !/\b(?:HeadlessChrome|Chrome|Chromium)\/\d+(?:\.\d+){1,3}\b/.test(userAgent)) {
    throw fail('MISSING_BROWSER', 'A hostUserAgent or userAgent containing an explicit Chrome, HeadlessChrome or Chromium version is required.');
  }
  const settings = report.configSettings;
  const method = settings.throttlingMethod;
  if (!['simulate', 'devtools', 'provided'].includes(method)) {
    throw fail('MISSING_THROTTLING', 'An explicit supported throttlingMethod (simulate, devtools or provided) is required.');
  }
  const reviewReasons = [];
  if (method === 'provided') {
    reviewReasons.push('provided throttling does not encode the actual externally controlled network/CPU conditions; matching report configuration cannot establish controlled conditions and requires manual review.');
  } else {
    if (!object(settings.throttling)) throw fail('INVALID_THROTTLING', `${method} requires explicit throttling parameters.`);
    for (const [field, minimum] of Object.entries(THROTTLING_FIELDS[method])) {
      const value = settings.throttling[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || (field === 'throughputKbps' && value === 0)) {
        throw fail('INVALID_THROTTLING', `${method} requires a valid explicit throttling.${field}.`);
      }
    }
  }
  const profile = { configSettings: settings, browserUserAgent: userAgent };
  const stable = JSON.stringify(profile, (key, item) => object(item)
    ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
  return { profile, profileSha256: createHash('sha256').update(stable).digest('hex'), reviewReasons };
}

/** Validate one raw sample without transport, filesystem, or cross-run state. */
export function validateLhrReport(report, { url, device }) {
  if (!object(report) || !object(report.audits)) throw fail('INVALID_LHR', 'The engine did not produce a Lighthouse report.');
  if (report.runtimeError) throw fail('LHR_RUNTIME_ERROR', 'Lighthouse reported a runtimeError; inspect the retained original report.');
  if ((report.gatherMode ?? 'navigation') !== 'navigation') throw fail('WRONG_MODE', 'Only navigation Lighthouse reports are accepted.');
  if (normalizeLhrUrl(report.requestedUrl) !== normalizeLhrUrl(url)
      || normalizeLhrUrl(report.finalDisplayedUrl ?? report.finalUrl) !== normalizeLhrUrl(url)) {
    throw fail('WRONG_URL', 'The requested or final audited URL differs from the configured page; redirects must be resolved explicitly.');
  }
  if (!object(report.configSettings) || report.configSettings.formFactor !== device) throw fail('WRONG_DEVICE', 'Lighthouse configSettings.formFactor differs from the requested device.');
  if (typeof report.lighthouseVersion !== 'string' || !report.lighthouseVersion.trim()) throw fail('MISSING_VERSION', 'Lighthouse version is missing.');
  const timestampKey = canonicalFetchTime(report.fetchTime);
  if (!score(report.categories?.performance?.score)) throw fail('MISSING_SCORE', 'A valid Lighthouse performance score is required.');
  for (const name of METRICS) {
    const audit = report.audits[name];
    if (!object(audit) || !score(audit.score) || typeof audit.numericValue !== 'number' || !Number.isFinite(audit.numericValue)
        || audit.numericValue < 0 || ['error', 'notApplicable', 'not_applicable'].includes(audit.scoreDisplayMode)) {
      throw fail('MISSING_METRIC', `A valid numeric value and score are required for ${name}.`);
    }
  }
  const evidence = profileEvidence(report);
  return { ...evidence, timestampKey, fetchTime: report.fetchTime, performanceScore: report.categories.performance.score,
    warnings: report.runWarnings ?? [], reviewRequired: evidence.reviewReasons.length > 0 || Boolean(report.runWarnings?.length) };
}
