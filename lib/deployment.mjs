import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserExecutable, sourceSnapshot, sha256 } from './runtime-profile.mjs';
import { runProcess } from './bounded-process.mjs';

export function validateDeployment(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(k => !['project','store','themeId','timeoutMs'].includes(k))
      || typeof config.project !== 'string' || !path.isAbsolute(config.project) || !/^[\w-]+\.myshopify\.com$/.test(config.store) || !/^\d+$/.test(String(config.themeId))) throw new Error('Deployment verification requires absolute project, myshopify store and numeric themeId.');
  const timeoutMs = config.timeoutMs ?? 120000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) throw new Error('Invalid deployment timeout.');
  return { ...config, themeId: String(config.themeId), timeoutMs };
}

/** Read only: download source text into a new disposable directory, never push or pull over the user's theme. */
export async function verifyDeployment({ config, pages, dependencies = {} }) {
  config = validateDeployment(config);
  if (!Array.isArray(pages) || !pages.length || pages.some(p => !p.id || !/^https?:\/\//.test(p.url))) throw new Error('Deployment requires the explicit measured page matrix.');
  const started = Date.now(), snapshot = await sourceSnapshot(config.project);
  const result = { schemaVersion: 1, kind: 'deployment-proof', status: 'unverified', startedAt: new Date().toISOString(),
    project: snapshot.project, sourceHash: snapshot.hash, sourceManifest: snapshot.files, scope: 'theme-text-source',
    store: config.store, themeId: config.themeId, pages: [], method: 'shopify-cli-source-pull-and-browser-theme-id',
    limitations: ['Checks bracket measurement; they cannot rule out an intervening remote edit that was reverted.', 'App configuration, CDN transforms, merchant content and cache state are outside theme-text-source identity.'] };
  let remote, browser, timer;
  try {
    if (!snapshot.complete) throw new Error('Incomplete local source inventory.');
    remote = await mkdtemp(path.join(os.tmpdir(), 'perfkit-deployment-'));
    const command = process.env.PERF_KIT_SHOPIFY_CLI || 'shopify';
    const pulled = await (dependencies.runProcess ?? runProcess)(command, ['theme','pull','--store',config.store,'--theme',config.themeId,'--path',remote,
      '--only','**/*.liquid','--only','assets/*.js','--only','assets/*.mjs','--only','assets/*.css','--only','**/*.json','--no-color'],
    { timeoutMs: Math.max(1, config.timeoutMs - (Date.now() - started)), env: { CI: '1', SHOPIFY_CLI_NO_ANALYTICS: '1' } });
    if (pulled.code !== 0) throw Object.assign(new Error('Read-only Shopify source verification failed; complete CLI login and retry.'), { code: 'DEPLOYMENT_SOURCE_UNAVAILABLE' });
    const deployed = await sourceSnapshot(remote);
    result.remoteSourceHash = deployed.hash;
    const map = new Map(deployed.files.map(f => [f.file, f.sourceHash]));
    result.differences = snapshot.files.filter(f => map.get(f.file) !== f.sourceHash).map(f => f.file);
    result.extraRemoteFiles = deployed.files.filter(f => !snapshot.files.some(local => local.file === f.file)).map(f => f.file);
    if (!deployed.complete || result.differences.length || result.extraRemoteFiles.length) throw Object.assign(new Error('Remote theme text differs from the local candidate.'), { code: 'DEPLOYMENT_SOURCE_MISMATCH' });
    browser = await chromium.launch({ executablePath: await browserExecutable(), headless: true });
    timer = setTimeout(() => { void browser.close(); }, Math.max(1, config.timeoutMs - (Date.now() - started)));
    for (const item of pages) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const page = await context.newPage(), scripts = [];
      page.on('response', response => {
        if (['script','stylesheet'].includes(response.request().resourceType())) scripts.push((async () => {
          try { const redirects=[];for(let prior=response.request().redirectedFrom();prior;prior=prior.redirectedFrom())redirects.unshift(prior.url()); const body = await response.body(); return body.length <= 8 * 1024 * 1024 ? { url: response.url(), redirects, bodyHash: sha256(body) } : null; } catch { return null; }
        })());
      });
      await page.goto(item.url, { waitUntil: 'load', timeout: Math.min(30000, Math.max(1, config.timeoutMs - (Date.now() - started))) });
      const identity = await page.evaluate(() => ({ themeId: window.Shopify?.theme?.id?.toString() ?? null, store: window.Shopify?.shop ?? null }));
      const record = { id: item.id, url: item.url, finalUrl: page.url(), ...identity, assets: (await Promise.all(scripts)).filter(Boolean) };
      record.status = record.themeId === config.themeId && record.store === config.store ? 'verified' : 'mismatch';
      result.pages.push(record); await context.close();
    }
    const final = await sourceSnapshot(config.project);
    result.status = final.complete && final.hash === snapshot.hash && result.pages.every(p => p.status === 'verified') ? 'verified' : 'mismatch';
  } catch (error) { result.status = 'unverified'; result.error = { code: error.code ?? 'DEPLOYMENT_UNVERIFIED', message: error.message }; }
  finally { clearTimeout(timer); if (browser) await browser.close().catch(() => {}); if (remote) await rm(remote, { recursive: true, force: true }); }
  result.finishedAt = new Date().toISOString(); return result;
}

export function checkRunDeployment(evidence) {
  const pair = evidence.manifest.deployment, pages = evidence.manifest.config.pages;
  if (!pair?.before || !pair?.after) return { status: 'unverified', reason: 'Measurement is not bracketed by candidate deployment checks.' };
  const [before, after] = [pair.before, pair.after];
  const declared = evidence.manifest.config.deployment;
  for (const proof of [before, after]) {
    if (proof.kind !== 'deployment-proof' || proof.status !== 'verified' || proof.scope !== 'theme-text-source'
      || proof.method !== 'shopify-cli-source-pull-and-browser-theme-id' || !/^[a-f0-9]{64}$/.test(proof.sourceHash)
      || !declared || proof.project !== declared.project || proof.store !== declared.store || proof.themeId !== String(declared.themeId)
      || proof.remoteSourceHash !== proof.sourceHash || !Array.isArray(proof.sourceManifest) || sha256(JSON.stringify(proof.sourceManifest)) !== proof.sourceHash
      || !Array.isArray(proof.pages) || proof.pages.length !== pages.length || pages.some(p => !proof.pages.some(q => q.id === p.id && q.url === p.url && q.status === 'verified' && q.themeId === proof.themeId && q.store === proof.store))) return { status: 'unverified', reason: 'Incomplete or mismatched deployment proof.' };
  }
  if (before.sourceHash !== after.sourceHash || before.themeId !== after.themeId || before.store !== after.store) return { status: 'mismatch', reason: 'Theme source or identity changed during measurement.' };
  const times = evidence.groups.flatMap(g => g.records.map(r => Date.parse(r.report.fetchTime)));
  const bounds = [evidence.manifest.startedAt, before.startedAt, before.finishedAt, after.startedAt, after.finishedAt, evidence.manifest.finishedAt].map(Date.parse);
  if (bounds.some(x => !Number.isFinite(x)) || bounds.some((x,i) => i > 0 && x < bounds[i-1])
    || Math.min(...times) < Date.parse(before.finishedAt) || Math.max(...times) > Date.parse(after.startedAt)) return { status: 'unverified', reason: 'Deployment checks do not bracket report timestamps.' };
  return { status: 'verified', sourceHash: before.sourceHash, themeId: before.themeId, project: before.project, store: before.store };
}
