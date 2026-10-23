// Synthetic contract fixtures only; never store measurements or scoring evidence.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateScenarioConfig } from '../../lib/scenarios.mjs';

// Explicit synthetic full-regression contract; no browser execution is claimed.
export function regressionForRun(fixture, {steps = [{action:'assert-text',selector:'main',text:'Fixture'}]} = {}) {
  const proof = structuredClone(fixture.manifest.deployment.after);
  const start = Date.parse(fixture.manifest.finishedAt) + 1000;
  const at = offset => new Date(start + offset).toISOString();
  const config = validateScenarioConfig({schemaVersion:1,project:proof.project,expectedThemeId:proof.themeId,
    viewports:fixture.manifest.config.devices.map(name=>({name,width:name==='mobile'?390:1440,height:844})),
    scenarios:fixture.manifest.config.pages.map(p=>({name:p.id,url:p.url,steps}))});
  const scenarios = {kind:'scenarios',config,outcome:'passed',sourceHash:proof.sourceHash,sourceStable:true,
    createdAt:at(0),finishedAt:at(1000),errors:[],runs:config.scenarios.flatMap(s=>config.viewports.map(viewport=>({
      name:s.name,url:s.url,finalUrl:s.url,viewport,themeId:proof.themeId,store:proof.store,documentStable:true,
      outcome:'passed',constrained:false,errors:[],pageErrors:[],artifactErrors:[],blockedRequests:[],
      steps:s.steps.map(step=>({...step,outcome:'passed',elapsedMs:10}))}))) };
  return {kind:'optimization-regression',sourceHash:proof.sourceHash,scenarios,
    remote:{...proof,startedAt:at(2000),finishedAt:at(3000)}};
}

export async function siteRun(t, { devices = ['mobile', 'desktop'], pages = [{ id: 'home', url: 'https://shop.example.test/?preview_theme_id=1' }],
  engine = 'lighthouse', offset = 0, scores = {}, reports = 5, status = 'complete', augment } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'perfkit-site-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { schemaVersion: 1, engine, pages, devices, runs: 5, timeoutMs: 120000 };
  const manifest = { schemaVersion: 1, kind: 'site-measurement', engine, status, config, groups: [] };
  for (const page of pages) for (const device of devices) {
    const reportsDirectory = `groups/${page.id}/${device}/lhr`;
    await mkdir(path.join(root, reportsDirectory), { recursive: true });
    const group = { pageId: page.id, url: page.url, device, status, reportsDirectory, reports: [] };
    for (let index = 0; index < reports; index++) {
      const values = scores[device] ?? [80, 80, 80, 80, 80];
      const report = {
        gatherMode: 'navigation', lighthouseVersion: 'synthetic-contract-fixture',
        fetchTime: new Date(Date.UTC(2026, 9, 16, 0, offset + manifest.groups.length * 60 + index)).toISOString(),
        requestedUrl: page.url, finalDisplayedUrl: page.url,
        userAgent: 'Mozilla/5.0 HeadlessChrome/130.0.0.0 Safari/537.36 Synthetic contract fixture',
        configSettings: { formFactor: device, throttlingMethod: 'simulate', throttling: { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4 } },
        categories: { performance: { score: values[index % values.length] / 100 } }, runWarnings: [],
        audits: Object.fromEntries(Object.entries({ 'first-contentful-paint': 1000, 'largest-contentful-paint': 2000,
          'speed-index': 2200, 'total-blocking-time': 100, 'cumulative-layout-shift': 0.05 }).map(([id, numericValue]) => [id, { numericValue, score: 0.9, scoreDisplayMode: 'numeric' }])),
      };
      if (augment) augment(report, { page, device, index });
      const relative = `${reportsDirectory}/report-${index + 1}.json`;
      await writeFile(path.join(root, relative), JSON.stringify(report));
      group.reports.push(relative);
    }
    manifest.groups.push(group);
  }
  await writeFile(path.join(root, 'run.json'), JSON.stringify(manifest));
  return { root, manifest };
}

export const saveManifest = fixture => writeFile(path.join(fixture.root, 'run.json'), JSON.stringify(fixture.manifest));
export async function changeReport(fixture, mutate, groupIndex = 0, reportIndex = 0) {
  const file = path.join(fixture.root, fixture.manifest.groups[groupIndex].reports[reportIndex]);
  const report = JSON.parse(await readFile(file, 'utf8'));
  mutate(report);
  await writeFile(file, JSON.stringify(report));
}
