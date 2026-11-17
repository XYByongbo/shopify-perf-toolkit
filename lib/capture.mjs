import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { imageMaterialIdentity } from './compare.mjs';
import { mapCapture } from './mapping.mjs';

const fail = (message, code) => Object.assign(new Error(message), { code });

export function isLocalPreviewUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '0.0.0.0' || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch { return false; }
}

export function validateCaptureOptions(options = {}) {
  const { url, selector, output, viewport = { width: 390, height: 844 }, dpr = 1,
    waitMs = 1500, timeoutMs = 30000 } = options;
  let parsed;
  try { parsed = new URL(url); } catch { throw fail('A valid HTTP(S) URL is required.', 'INVALID_URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw fail('Only HTTP(S) URLs without embedded credentials are allowed.', 'INVALID_URL');
  }
  if (typeof selector !== 'string' || !selector.trim()) throw fail('A nonempty, unique component selector is required.', 'INVALID_SELECTOR');
  if (typeof output !== 'string' || !output.trim()) throw fail('A new output directory is required.', 'INVALID_OUTPUT');
  if (!viewport || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height)
    || viewport.width < 1 || viewport.height < 1 || viewport.width > 10000 || viewport.height > 10000) {
    throw fail('Viewport width and height must be integers between 1 and 10000.', 'INVALID_VIEWPORT');
  }
  if (!Number.isFinite(dpr) || dpr < 0.1 || dpr > 5) throw fail('DPR must be between 0.1 and 5.', 'INVALID_DPR');
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60000) throw fail('waitMs must be an integer between 0 and 60000.', 'INVALID_WAIT');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw fail('timeoutMs must be an integer between 1 and 120000.', 'INVALID_TIMEOUT');
  return { ...options, url: parsed.href, selector: selector.trim(), output: path.resolve(output), viewport, dpr, waitMs, timeoutMs };
}

// A zero from a cross-origin timing without Timing-Allow-Origin is NOT a zero-byte response.
export function resourceTimingRecord(entry, pageUrl) {
  let sameOrigin = false;
  try { sameOrigin = new URL(entry.name).origin === new URL(pageUrl).origin; } catch { /* non-HTTP resources */ }
  const exposed = sameOrigin || entry.responseStart > 0 || entry.requestStart > 0
    || entry.transferSize > 0 || entry.encodedBodySize > 0 || entry.decodedBodySize > 0;
  const bytes = key => exposed && Number.isFinite(entry[key]) && entry[key] >= 0 ? entry[key] : null;
  return {
    url: entry.name, initiatorType: entry.initiatorType ?? null,
    startTimeMs: Number.isFinite(entry.startTime) ? entry.startTime : null,
    durationMs: Number.isFinite(entry.duration) ? entry.duration : null,
    transferSize: bytes('transferSize'), encodedBodySize: bytes('encodedBodySize'),
    decodedBodySize: bytes('decodedBodySize'),
    sizeAvailability: exposed ? 'reported' : 'unavailable-cross-origin-or-no-timing',
    transferMeaning: 'HTTP response headers plus encoded response body; zero may indicate cache, not a zero-size image.',
    bodyMeaning: 'encodedBodySize is the response body before content decoding; decodedBodySize is after HTTP content decoding, not raster pixel memory.',
  };
}

export async function loadPlaywright() {
  const specified = process.env.PERF_KIT_PLAYWRIGHT_MODULE;
  if (specified && !path.isAbsolute(specified)) {
    throw fail('PERF_KIT_PLAYWRIGHT_MODULE must be an absolute path to an existing Playwright module entry file.', 'PLAYWRIGHT_UNAVAILABLE');
  }
  try {
    const loaded = specified ? await import(pathToFileURL(specified).href) : await import('playwright').catch(() => import('playwright-core'));
    const playwright = loaded.chromium ? loaded : loaded.default;
    if (!playwright?.chromium?.launch) throw new Error('chromium.launch is unavailable');
    return playwright;
  } catch (cause) {
    throw fail(`Playwright is unavailable. Point PERF_KIT_PLAYWRIGHT_MODULE to an existing absolute module entry file (and configure an existing Chromium executable if needed). No dependency was installed. ${cause.message}`, 'PLAYWRIGHT_UNAVAILABLE');
  }
}

function installObservers() {
  window.__PERF_KIT_OBSERVATION__ = { lcp: null, cls: 0, clsSession: 0, clsStart: 0, clsLast: 0, errors: [], supported: [] };
  const state = window.__PERF_KIT_OBSERVATION__;
  for (const type of ['largest-contentful-paint', 'layout-shift', 'longtask']) {
    if (!PerformanceObserver.supportedEntryTypes?.includes(type)) continue;
    state.supported.push(type);
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (type === 'largest-contentful-paint') {
            state.lcp = { valueMs: entry.startTime, size: entry.size, url: entry.url || null,
              tagName: entry.element?.tagName?.toLowerCase() ?? null, elementId: entry.element?.id || null };
          } else if (type === 'layout-shift' && !entry.hadRecentInput) {
            if (!state.clsLast || entry.startTime - state.clsLast > 1000 || entry.startTime - state.clsStart > 5000) {
              state.clsStart = entry.startTime;
              state.clsSession = 0;
            }
            state.clsSession += entry.value;
            state.clsLast = entry.startTime;
            state.cls = Math.max(state.cls, state.clsSession);
          } else if (type === 'longtask') {
            state.longTaskCount = (state.longTaskCount || 0) + 1;
            state.longTaskDurationMs = (state.longTaskDurationMs || 0) + entry.duration;
          }
        }
      }).observe({ type, buffered: true });
    } catch (error) { state.errors.push(`${type}: ${error.message}`); }
  }
}

function collectSnapshot(selector) {
  const root = document.querySelector(selector);
  const elements = query => [...(root.matches(query) ? [root] : []), ...root.querySelectorAll(query)];
  const idCounts = new Map();
  for (const element of document.querySelectorAll('[id]')) idCounts.set(element.id, (idCounts.get(element.id) ?? 0) + 1);
  const documentSelector = element => {
    const parts = [];
    for (let current = element; current; current = current.parentElement) {
      const siblings = current.parentElement ? [...current.parentElement.children].filter(item => item.tagName === current.tagName) : [current];
      parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`);
    }
    return parts.join(' > ');
  };
  const mappingDescriptor = element => {
    const section = element.closest('[id^="shopify-section-"]');
    const instanceId = section?.id.slice('shopify-section-'.length) ?? null;
    return {
      dom: { tagName: element.tagName.toLowerCase(), id: element.id || null, idCount: element.id ? idCounts.get(element.id) : null,
        documentSelector: documentSelector(element),
        attributes: Object.fromEntries([...element.attributes].filter(attribute => ['id', 'class', 'alt', 'role', 'aria-label'].includes(attribute.name)
          || (attribute.name.startsWith('data-') && !attribute.name.startsWith('data-perf-kit-'))).map(attribute => [attribute.name, attribute.value])) },
      sectionContext: section ? { id: section.id, instanceId,
        sectionKey: instanceId.includes('__') ? instanceId.slice(instanceId.lastIndexOf('__') + 2) : instanceId } : null,
    };
  };
  const allImages = [...document.querySelectorAll('img')];
  const normalized = value => (value || '').replace(/\s+/g, ' ').trim();
  const geometry = element => {
    const r = element.getBoundingClientRect();
    return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
  };
  const visibility = element => {
    const r = element.getBoundingClientRect();
    let visible = r.width > 0 && r.height > 0;
    for (let p = element; p; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) visible = false;
    }
    return { visible, inViewport: visible && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth };
  };
  const elementSelector = element => {
    if (element === root) return selector;
    const parts = [];
    for (let current = element; current && current !== root; current = current.parentElement) {
      const tag = current.tagName.toLowerCase();
      const siblings = [...current.parentElement.children].filter(s => s.tagName === current.tagName);
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
    }
    return `${selector} > ${parts.join(' > ')}`;
  };
  const imageEntries = elements('img').map(img => ({
    ...mappingDescriptor(img),
    selector: elementSelector(img), src: img.getAttribute('src'), currentSrc: img.currentSrc,
    srcset: img.getAttribute('srcset'), sizes: img.getAttribute('sizes'), alt: img.getAttribute('alt'),
    loading: img.getAttribute('loading'), fetchpriority: img.getAttribute('fetchpriority'),
    decoding: img.getAttribute('decoding'), widthAttribute: img.getAttribute('width'), heightAttribute: img.getAttribute('height'),
    box: geometry(img), naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
    complete: img.complete, ...visibility(img),
    sourceIdentity: ['data-perf-kit-source-index', 'data-perf-kit-source-hash', 'data-perf-kit-source-path'].some(name => img.hasAttribute(name))
      ? { sourceIndex: /^\d+$/.test(img.getAttribute('data-perf-kit-source-index') ?? '') ? Number(img.getAttribute('data-perf-kit-source-index')) : null,
        sourceHash: img.getAttribute('data-perf-kit-source-hash'), sourcePath: img.getAttribute('data-perf-kit-source-path'), provenance: 'explicit-dom-annotation-requires-source-validation' } : null,
    pictureSources: img.parentElement?.tagName === 'PICTURE'
      ? [...img.parentElement.querySelectorAll('source')].map(s => ({ srcset: s.getAttribute('srcset'), sizes: s.getAttribute('sizes'), media: s.getAttribute('media'), type: s.getAttribute('type') })) : [],
  }));
  return {
    component: {
      ...mappingDescriptor(root),
      selector, tagName: root.tagName.toLowerCase(), text: normalized(root.innerText ?? root.textContent),
      geometry: geometry(root), ...visibility(root),
      links: elements('a').map(a => ({ href: a.href, text: normalized(a.innerText), target: a.getAttribute('target'), rel: a.getAttribute('rel'), ariaLabel: a.getAttribute('aria-label') })),
      controls: elements('button,input,select,textarea,summary,[role="button"]').map(el => ({
        tagName: el.tagName.toLowerCase(), type: el.getAttribute('type'), name: el.getAttribute('name'),
        text: normalized(el.tagName === 'SELECT' ? el.textContent : el.innerText), ariaLabel: el.getAttribute('aria-label'),
        disabled: Boolean(el.disabled), checked: typeof el.checked === 'boolean' ? el.checked : null,
        value: el.type === 'password' ? null : ('value' in el ? el.value : null),
      })),
    },
    images: imageEntries,
    mappingInventory: { complete: allImages.length <= 5000, images: allImages.slice(0, 5000).map(mappingDescriptor) },
    media: elements('video,audio,iframe').map(el => ({
      selector: elementSelector(el), tagName: el.tagName.toLowerCase(), src: el.getAttribute('src'), currentSrc: el.currentSrc || null,
      sources: [...el.querySelectorAll('source')].map(s => ({ src: s.getAttribute('src'), type: s.getAttribute('type'), media: s.getAttribute('media') })),
      poster: el.getAttribute('poster'), preload: el.getAttribute('preload'), autoplay: Boolean(el.autoplay),
      controls: Boolean(el.controls), loop: Boolean(el.loop), muted: Boolean(el.muted), title: el.getAttribute('title'),
      loading: el.getAttribute('loading'), box: geometry(el), ...visibility(el),
    })),
    timingEntries: performance.getEntriesByType('resource').map(e => e.toJSON()),
    navigation: performance.getEntriesByType('navigation')[0]?.toJSON() ?? null,
    observation: window.__PERF_KIT_OBSERVATION__,
    localPreview: Boolean(window.__LOCAL_PREVIEW__), userAgent: navigator.userAgent,
    documentReadyState: document.readyState, observedUntilMs: performance.now(),
  };
}

export async function capturePage(options) {
  const config = validateCaptureOptions(options);
  const playwright = await loadPlaywright();
  await mkdir(path.dirname(config.output), { recursive: true });
  try { await mkdir(config.output, { recursive: false }); }
  catch (error) {
    if (error.code === 'EEXIST') throw fail(`Output directory already exists; refusing to overwrite: ${config.output}`, 'OUTPUT_EXISTS');
    throw error;
  }
  let browser;
  const started = performance.now();
  try {
    const executablePath = process.env.PERF_KIT_BROWSER_EXECUTABLE || process.env.PERF_KIT_CHROMIUM_EXECUTABLE || await (await import('./runtime-profile.mjs')).browserExecutable();
    if (executablePath && !path.isAbsolute(executablePath)) throw fail('PERF_KIT_BROWSER_EXECUTABLE must be an absolute path.', 'INVALID_BROWSER_PATH');
    try { browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); }
    catch (error) {
      if (/executable (?:does not|doesn't) exist/i.test(error.message)) {
        throw Object.assign(new Error(error.message, {cause:error}), {code:'BROWSER_UNAVAILABLE'});
      }
      throw error;
    }
    const context = await browser.newContext({ viewport: config.viewport, deviceScaleFactor: config.dpr,
      locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'no-preference',
      serviceWorkers: 'block', acceptDownloads: false });
    const page = await context.newPage();
    page.setDefaultTimeout(config.timeoutMs);
    const consoleErrors = [];
    const blockedRequests = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ type: 'console', message: message.text() }); });
    page.on('pageerror', error => consoleErrors.push({ type: 'pageerror', message: error.message }));
    await context.route('**/*', async route => {
      const request = route.request();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        blockedRequests.push({ method: request.method(), url: request.url(), resourceType: request.resourceType() });
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    if (typeof context.routeWebSocket === 'function') {
      await context.routeWebSocket('**/*', socket => {
        blockedRequests.push({ method: 'WEBSOCKET', url: socket.url(), resourceType: 'websocket' });
        socket.close();
      });
    }
    await page.addInitScript(installObservers);
    const response = await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
    if (response && response.status() >= 400) throw fail(`Navigation returned HTTP ${response.status()}.`, 'NAVIGATION_FAILED');
    let count;
    try { count = await page.evaluate(selector => document.querySelectorAll(selector).length, config.selector); }
    catch (error) { throw fail(`Invalid component selector: ${error.message}`, 'INVALID_SELECTOR'); }
    if (count !== 1) throw fail(`Component selector must match exactly one element; matched ${count}.`, 'SELECTOR_NOT_UNIQUE');
    await page.waitForTimeout(config.waitMs);
    // Count again because a hydrated component can duplicate or remove its initial markup.
    count = await page.evaluate(selector => document.querySelectorAll(selector).length, config.selector);
    if (count !== 1) throw fail(`Component selector matched ${count} elements after observation; expected one.`, 'SELECTOR_NOT_UNIQUE');
    const snapshot = await page.evaluate(collectSnapshot, config.selector);
    const finalUrl = page.url();
    const previewDetection = { pageMarker: snapshot.localPreview, loopbackUrl: isLocalPreviewUrl(config.url) || isLocalPreviewUrl(finalUrl) };
    snapshot.localPreview = previewDetection.pageMarker || previewDetection.loopbackUrl;
    const resources = snapshot.timingEntries.map(entry => resourceTimingRecord(entry, finalUrl));
    const images = snapshot.images.map(img => ({ ...img,
      materialIdentity: imageMaterialIdentity(img.currentSrc || img.src, finalUrl),
      resource: [...resources].reverse().find(resource => resource.url === img.currentSrc) ?? null }));
    const screenshots = {};
    const limitations = [
      'Single cold-context laboratory observation; not field Core Web Vitals or proof of an overall performance improvement.',
      'LCP and CLS are page-level provisional values within the stated observation window, not component-level scores.',
      'No user interaction was performed. Functional equivalence and INP are not measured.',
      'Non-GET/HEAD/OPTIONS requests, WebSocket connections (when supported by Playwright), and service workers are blocked. Features requiring them may not render equivalently.',
      'Routing disables the browser HTTP cache. No persistent cookies, login state, or existing browser storage are reused.',
      'Resource byte values are Resource Timing data; cross-origin values without timing permission may be unavailable.',
      'Background CSS images, pseudo-element images, and shadow DOM content are outside the v1 component image inventory.',
      'Screenshots are captured after the metrics snapshot and may include later animation or lazy-loading changes.',
    ];
    if (snapshot.localPreview) limitations.push('A local preview marker or loopback URL was detected. This observation cannot establish production CWV or live Shopify behavior.');
    const saveScreenshot = async (name, operation) => {
      try {
        const buffer = await operation();
        const filename = `${name}.png`;
        await writeFile(path.join(config.output, filename), buffer, { flag: 'wx' });
        screenshots[name] = { file: filename, sha256: createHash('sha256').update(buffer).digest('hex') };
      } catch (error) { limitations.push(`${name} screenshot unavailable: ${error.message}`); }
    };
    await saveScreenshot('page', () => page.screenshot({ fullPage: false, timeout: config.timeoutMs }));
    if (snapshot.component.visible) await saveScreenshot('component', () => page.locator(`css=${config.selector}`).screenshot({ timeout: config.timeoutMs }));
    else limitations.push('The target is not visibly rendered; component screenshot was not taken.');
    const observation = snapshot.observation;
    let result = {
      schemaVersion: 1, kind: 'capture', createdAt: new Date().toISOString(),
      project: config.project ?? null, target: config.target ?? config.selector,
      environment: { url: config.url, finalUrl, viewport: config.viewport, dpr: config.dpr,
        browser: 'chromium', browserVersion: browser.version(), userAgent: snapshot.userAgent,
        locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'no-preference',
        cache: 'disabled-by-routing', storage: 'fresh-context', serviceWorkers: 'blocked',
        requestPolicy: 'GET-HEAD-OPTIONS-only', webSockets: typeof context.routeWebSocket === 'function' ? 'blocked' : 'uncontrolled-unsupported', localPreview: snapshot.localPreview, previewDetection,
        requestedWaitMs: config.waitMs, observedUntilMs: snapshot.observedUntilMs,
        documentReadyState: snapshot.documentReadyState,
      },
      component: snapshot.component, images, mappingInventory: snapshot.mappingInventory, media: snapshot.media, resources,
      metrics: {
        scope: 'page', observationWindowMs: snapshot.observedUntilMs,
        lcp: observation?.supported.includes('largest-contentful-paint') ? observation.lcp : null,
        cls: observation?.supported.includes('layout-shift') ? observation.cls : null,
        longTaskCount: observation?.supported.includes('longtask') ? observation.longTaskCount ?? 0 : null,
        longTaskDurationMs: observation?.supported.includes('longtask') ? observation.longTaskDurationMs ?? 0 : null,
        domContentLoadedMs: snapshot.navigation?.domContentLoadedEventEnd ?? null,
        loadEventEndMs: snapshot.navigation?.loadEventEnd > 0 ? snapshot.navigation.loadEventEnd : null,
        inp: null,
      },
      consoleErrors, blockedRequests, screenshots, limitations: [...limitations, ...(observation?.errors ?? [])],
      elapsedMs: performance.now() - started,
    };
    if (config.project) {
      const association = await mapCapture({ project: config.project, capture: result, ...(config.target ? { target: config.target } : {}) });
      result = association.linkedCapture;
      await writeFile(path.join(config.output, 'mapping.json'), `${JSON.stringify(association, null, 2)}\n`, { flag: 'wx' });
    }
    await writeFile(path.join(config.output, 'capture.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    return result;
  } catch (error) {
    await writeFile(path.join(config.output, 'capture-error.json'), `${JSON.stringify({ schemaVersion: 1, kind: 'capture-error', code: error.code ?? 'CAPTURE_FAILED', message: error.message, url: config.url, selector: config.selector }, null, 2)}\n`, { flag: 'wx' }).catch(() => {});
    throw error;
  } finally { if (browser) await browser.close(); }
}
