import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { publicAddress } from './public-address.mjs';

function shown(value) {
  const url = new URL(value); url.username = ''; url.password = ''; url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (!/^(v|width|height|format|crop|quality|dl|raw)$/.test(key)) url.searchParams.set(key, '[redacted]');
  return url.href;
}
export async function resolvePublicTarget(value, resolver = lookup) {
  const url = new URL(value), hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Unsupported URL.');
  if (!hostname.includes('.') && !isIP(hostname)) throw new Error('Non-public hostname.');
  if (/(?:^|\.)(?:localhost|local|internal|test|invalid)\.?$/i.test(hostname)) throw new Error('Non-public hostname.');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolver(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Non-public address.');
  return { url, address: addresses[0] };
}
export function requestHead(target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const transport = target.url.protocol === 'https:' ? https : http;
    const req = transport.request(target.url, { method: 'HEAD', agent: false, maxHeaderSize: 16384,
      headers: { 'user-agent': 'Shopify-Perf-Toolkit/0.5 link-header-check', accept: '*/*' },
      // Pin the already-validated address; a second DNS resolution cannot rebind it.
      lookup: (_host, options, callback) => options?.all ? callback(null, [target.address]) : callback(null, target.address.address, target.address.family),
    }, response => {
      const result = { statusCode: response.statusCode, location: response.headers.location, contentType: response.headers['content-type'] ?? null, cacheControl: response.headers['cache-control'] ?? null };
      response.destroy(); resolve(result);
    });
    const timer = setTimeout(() => req.destroy(new Error('Timed out.')), timeoutMs);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end();
  });
}
/** Injectable transport is for deterministic tests; CLI always uses validated DNS + pinned HEAD. */
export async function probeLink(value, { resolver = lookup, request = requestHead, timeoutMs = 5000, maxRedirects = 3 } = {}) {
  const deadline = Date.now() + timeoutMs, chain = [];
  let url = value;
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let timer;
      const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error('Timeout.');
      try {
        const result = await Promise.race([
          (async () => { const target = await resolvePublicTarget(url, resolver); if (Date.now() >= deadline) throw new Error('Timeout.'); return request(target, deadline - Date.now()); })(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timeout.')), remaining); }),
        ]);
        chain.push({ url: shown(url), statusCode: result.statusCode });
        if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
          if (!result.location || hop === maxRedirects) return { status: 'review-required', reason: 'Missing redirect location or redirect limit.', chain };
          url = new URL(result.location, url).href; continue;
        }
        return { status: result.statusCode >= 200 && result.statusCode < 300 ? 'reachable-headers' : 'review-required', ...result, location: undefined, chain,
          reason: [403, 405, 429].includes(result.statusCode) ? 'HEAD denied, unsupported or rate-limited; this does not prove a broken browser resource.' : 'Header observation only; verify actual browser loading.' };
      } finally { clearTimeout(timer); }
    }
  } catch { return { status: 'unverified', reason: 'URL/DNS rejected, request failed or timed out. No browser availability verdict.', chain }; }
}
