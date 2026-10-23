import { createHash } from 'node:crypto';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const known = value => value !== undefined && value !== null;
const number = value => typeof value === 'number' && Number.isFinite(value);

// Only resolution/transport candidates may vary. Asset pathname and visual transforms are retained.
export function imageMaterialIdentity(value, baseUrl) {
  if (!value || typeof value !== 'string') return null;
  if (value.startsWith('data:')) return `data:sha256:${createHash('sha256').update(value).digest('hex')}`;
  try {
    const url = new URL(value, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    for (const key of ['width', 'height', 'format', 'quality', 'dpr']) url.searchParams.delete(key);
    url.searchParams.sort();
    url.hash = '';
    return `${url.origin}${url.pathname}${url.search}`;
  } catch { return null; }
}

const materialList = (image, baseUrl) => {
  const values = [image.src, image.currentSrc];
  // Shopify CDN srcset candidates have no unescaped commas in their URLs.
  for (const source of [{ srcset: image.srcset }, ...(image.pictureSources ?? [])]) {
    if (!source.srcset) continue;
    if (source.srcset.includes('data:')) return null; // ambiguous srcset is never guessed
    for (const candidate of source.srcset.split(',')) {
      const value = candidate.trim().split(/\s+/)[0];
      if (value) values.push(value);
    }
  }
  const identities = values.filter(Boolean).map(value => imageMaterialIdentity(value, baseUrl));
  return identities.some(value => !value) || !identities.length ? null : [...new Set(identities)].sort();
};

export function compareCaptures(before, after) {
  const checks = [];
  const limitations = [
    'A single before/after observation is diagnostic only; byte differences do not establish overall LCP or CWV improvement.',
    'Static content, geometry, and control attributes are checked. Interaction behavior is not exercised and INP is not measured.',
    'PNG hash equality confirms identical captured pixels only. A differing hash requires visual review, including dynamic content and animation.',
    'Image byte sums may count a shared resource more than once; per-image resource deltas are the evidence, not total page savings.',
  ];
  const add = (id, status, message, details, scope = 'component') => checks.push({ id, status, scope, message, ...(details === undefined ? {} : { details }) });
  const result = (comparable, outcome) => ({ schemaVersion: 1, kind: 'comparison', comparable, checks, outcome, limitations });
  if (before?.schemaVersion !== 1 || after?.schemaVersion !== 1 || before.kind !== 'capture' || after.kind !== 'capture') {
    add('capture-schema', 'incomparable', 'Both inputs must be schemaVersion 1 capture records.');
    return result(false, 'not-comparable');
  }
  const leftEnvironment = before.environment ?? {};
  const rightEnvironment = after.environment ?? {};
  const requiredEnvironment = ['url', 'finalUrl', 'viewport', 'dpr', 'browser', 'browserVersion', 'userAgent',
    'locale', 'timezoneId', 'colorScheme', 'reducedMotion', 'cache', 'storage', 'serviceWorkers', 'requestPolicy', 'localPreview', 'requestedWaitMs'];
  const mismatches = requiredEnvironment.filter(key => !known(leftEnvironment[key]) || !known(rightEnvironment[key]) || !same(leftEnvironment[key], rightEnvironment[key]));
  if (mismatches.length) add('environment', 'incomparable', 'Capture environments must match and contain the required fields.', { fields: mismatches }, 'page');
  else add('environment', 'pass', 'URL, viewport, DPR, browser, observation settings, and request policy match.', undefined, 'page');
  if (!before.component?.selector || !after.component?.selector || before.component.selector !== after.component.selector
      || !known(before.target) || !known(after.target) || !same(before.target, after.target) || !same(before.project ?? null, after.project ?? null)) {
    add('target', 'incomparable', 'Project, target, and unique component selector must identify the same target.');
  } else add('target', 'pass', 'Project, target, and component selector match.');
  if (checks.some(check => check.status === 'incomparable')) return result(false, 'not-comparable');

  const invariant = (id, a, b, description) => {
    if (!known(a) || !known(b)) add(id, 'unknown', `${description} evidence is missing.`);
    else add(id, same(a, b) ? 'pass' : 'fail', `${description} ${same(a, b) ? 'is unchanged' : 'changed'}.`, same(a, b) ? undefined : { before: a, after: b });
  };
  invariant('component-text', before.component.text, after.component.text, 'Visible component text');
  invariant('component-links', before.component.links, after.component.links, 'Link content and destinations');
  invariant('component-controls', before.component.controls, after.component.controls, 'Control content and attributes');
  invariant('component-visibility', before.component.visible, after.component.visible, 'Component visibility');
  const geometry = (id, a, b) => {
    if (!a || !b || ['x', 'y', 'width', 'height'].some(key => !number(a[key]) || !number(b[key]))) {
      add(id, 'unknown', 'Complete geometry evidence is missing.'); return;
    }
    const deltas = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, b[key] - a[key]]));
    const unchanged = Object.values(deltas).every(value => Math.abs(value) <= 0.5);
    add(id, unchanged ? 'pass' : 'fail', `Geometry ${unchanged ? 'is unchanged within 0.5 CSS px' : 'changed by more than 0.5 CSS px'}.`, { deltasCssPx: deltas });
  };
  geometry('component-geometry', before.component.geometry, after.component.geometry);

  if (!Array.isArray(before.images) || !Array.isArray(after.images)) add('image-inventory', 'unknown', 'Image inventory is missing.');
  else if (before.images.length !== after.images.length) add('image-inventory', 'fail', 'Image count changed.', { before: before.images.length, after: after.images.length });
  else {
    add('image-inventory', 'pass', `${before.images.length} component images exist in both captures.`);
    before.images.forEach((image, index) => {
      const other = after.images[index];
      const prefix = `image-${index + 1}`;
      invariant(`${prefix}-selector`, image.selector, other.selector, 'Image DOM location');
      // Null alt and empty alt are distinct, meaningful accessible content states.
      if (!Object.hasOwn(image, 'alt') || !Object.hasOwn(other, 'alt')) add(`${prefix}-alt`, 'unknown', 'Image alt evidence is missing.');
      else add(`${prefix}-alt`, same(image.alt, other.alt) ? 'pass' : 'fail', same(image.alt, other.alt) ? 'Image alt is unchanged.' : 'Image alt changed.', same(image.alt, other.alt) ? undefined : { before: image.alt, after: other.alt });
      const sourceA = materialList(image, leftEnvironment.finalUrl);
      const sourceB = materialList(other, rightEnvironment.finalUrl);
      if (!sourceA || !sourceB) add(`${prefix}-material`, 'unknown', 'Image material identity could not be established from every source.');
      else add(`${prefix}-material`, same(sourceA, sourceB) ? 'pass' : 'fail', same(sourceA, sourceB) ? 'Image asset identities and visual transforms are unchanged.' : 'Image asset identity or visual transform changed.', { before: sourceA, after: sourceB });
      invariant(`${prefix}-picture-semantics`, (image.pictureSources ?? []).map(s => ({ media: s.media, type: s.type })), (other.pictureSources ?? []).map(s => ({ media: s.media, type: s.type })), 'Picture source media/type selection');
      geometry(`${prefix}-geometry`, image.box, other.box);
      invariant(`${prefix}-visibility`, image.visible, other.visible, 'Image visibility');
      if (image.visible && other.visible) {
        if (other.complete && other.naturalWidth === 0) add(`${prefix}-loaded`, 'fail', 'Visible image completed without a decoded image.');
        else if (other.complete && other.naturalWidth > 0 && other.naturalHeight > 0) add(`${prefix}-loaded`, 'pass', 'Visible image is decoded.');
        else add(`${prefix}-loaded`, 'unknown', 'Visible image was not fully decoded during the observation window.');
      }
      const bodyA = image.resource?.encodedBodySize;
      const bodyB = other.resource?.encodedBodySize;
      const transferA = image.resource?.transferSize;
      const transferB = other.resource?.transferSize;
      const decodedA = image.resource?.decodedBodySize;
      const decodedB = other.resource?.decodedBodySize;
      const usable = (a, b) => number(a) && number(b) && a >= 0 && b >= 0;
      const deltas = {
        encodedBodyBytes: usable(bodyA, bodyB) ? { before: bodyA, after: bodyB, delta: bodyB - bodyA } : null,
        transferredBytes: usable(transferA, transferB) ? { before: transferA, after: transferB, delta: transferB - transferA } : null,
        decodedBodyBytes: usable(decodedA, decodedB) ? { before: decodedA, after: decodedB, delta: decodedB - decodedA } : null,
      };
      add(`${prefix}-bytes`, deltas.encodedBodyBytes ? 'info' : 'unknown', deltas.encodedBodyBytes
        ? 'Observed response body size delta; not a claim about overall page performance.'
        : 'Image response size is unavailable in one or both captures; no zero-byte savings is inferred.', deltas, 'resource');
    });
  }
  const mediaSemantics = (media, base) => media?.map(item => ({
    selector: item.selector, tagName: item.tagName, src: imageMaterialIdentity(item.src, base),
    sources: (item.sources ?? []).map(s => ({ ...s, src: imageMaterialIdentity(s.src, base) })),
    poster: imageMaterialIdentity(item.poster, base), autoplay: item.autoplay, controls: item.controls,
    loop: item.loop, muted: item.muted, title: item.title,
  }));
  invariant('media-semantics', mediaSemantics(before.media, leftEnvironment.finalUrl), mediaSemantics(after.media, rightEnvironment.finalUrl), 'Media sources and behavior attributes');
  if (!Array.isArray(before.consoleErrors) || !Array.isArray(after.consoleErrors)) add('console-errors', 'unknown', 'Console error evidence is missing.', undefined, 'page');
  else {
    const errorsA = new Map();
    const errorKey = error => typeof error === 'string' ? error : `${error.type}: ${error.message}`;
    for (const error of before.consoleErrors) errorsA.set(errorKey(error), (errorsA.get(errorKey(error)) ?? 0) + 1);
    const newErrors = [];
    for (const error of after.consoleErrors) {
      const key = errorKey(error);
      if (errorsA.get(key) > 0) errorsA.set(key, errorsA.get(key) - 1);
      else newErrors.push(error);
    }
    add('console-errors', newErrors.length ? 'fail' : 'pass', newErrors.length ? 'New or more frequent console errors were observed.' : 'No new console errors were observed.', { newErrors }, 'page');
  }
  const hashA = before.screenshots?.component?.sha256;
  const hashB = after.screenshots?.component?.sha256;
  add('component-pixels', hashA && hashB ? (hashA === hashB ? 'pass' : 'review') : 'unknown', hashA && hashB
    ? (hashA === hashB ? 'Component screenshot pixels are identical.' : 'Component screenshot differs and requires visual review.')
    : 'Both component screenshots are required for a pixel comparison.');
  add('functional-interactions', 'review', 'Interactions were not exercised; complete the component-specific functional checklist before accepting a change.');
  if (leftEnvironment.localPreview || rightEnvironment.localPreview) limitations.push('Local preview evidence does not verify live Shopify behavior, production requests, or production CWV.');
  const anyFail = checks.some(check => check.status === 'fail');
  const unresolved = checks.some(check => ['unknown', 'review'].includes(check.status));
  return result(true, anyFail ? 'regression-detected' : unresolved ? 'review-required' : 'invariants-preserved');
}
