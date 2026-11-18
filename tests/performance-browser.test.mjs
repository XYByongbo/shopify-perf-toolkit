import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { Liquid } from 'liquidjs';
import { browserExecutable, profileRuntime } from '../lib/runtime-profile.mjs';
import { transformCode } from '../lib/code-strategies.mjs';
import { performanceStrategies } from '../lib/performance-strategies.mjs';
import { auditPerformance } from '../lib/performance-audit.mjs';
import {fixturePNG} from './helpers/fixture-image.mjs';
import {profileDomain} from '../lib/domain-profile.mjs';
import {verifyDeployment} from '../lib/deployment.mjs';

const enabled = process.env.PERF_KIT_BROWSER_TESTS === '1';
const proof = (source, kind) => ({ ...Object.fromEntries(performanceStrategies.find(s => s.kind === kind).evidenceRequired.map(k => [k, true])),
  sourceHash: createHash('sha256').update(source).digest('hex'), summary: 'Isolated browser fixture.' });
async function fixture(t, html, files = {}) {
  const root = await mkdtemp('/private/tmp/perfkit-p0-browser-'), project = path.join(root, 'theme');
  await mkdir(path.join(project, 'assets'), { recursive: true });
  await mkdir(path.join(project, 'sections'), { recursive: true });
  await writeFile(path.join(project, 'sections/main.liquid'), '<section>Fixture</section>');
  for (const [file, content] of Object.entries(files)) if (!Buffer.isBuffer(content)) await writeFile(path.join(project, file), content);
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const pathname = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('cache-control', 'no-store');
    if (pathname.endsWith('.svg')) {
      res.setHeader('content-type', 'image/svg+xml');
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="800"><rect width="1600" height="800" fill="steelblue"/><path d="M0 800L600 50L1200 800ZM600 800L1200 100L1600 800Z" fill="orange"/><circle cx="1300" cy="180" r="90" fill="white"/><text x="80" y="140" font-size="80">Performance fixture</text></svg>');
    } else if (files[pathname.slice(1)]) {
      const body = files[pathname.slice(1)];
      res.setHeader('content-type',Buffer.isBuffer(body)?'image/png':'text/css'); res.end(body);
    } else if (pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { root, project, requests, url: `http://127.0.0.1:${server.address().port}/` };
}
test('audit finding generates mobile and desktop configs consumed directly by the runtime CLI', { skip: !enabled, timeout: 90000 }, async t => {
  const source = `<section>
    <img src="/desktop.png" loading="lazy" class="hero--desktop" width="1600" height="800" alt="Desktop">
    <img src="/mobile.png" loading="lazy" class="hero--mobile" width="800" height="400" alt="Mobile">
  </section>`;
  const f = await fixture(t, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>img{width:100%;max-width:1100px;height:auto;display:block}.hero--mobile{display:none}
    @media(max-width:749px){.hero--mobile{display:block}.hero--desktop{display:none}}</style>
    <script>window.Shopify={theme:{id:123},shop:'fixture.myshopify.com'};</script>${source}`,
    {'desktop.png':fixturePNG(),'mobile.png':fixturePNG(600,300)});
  await writeFile(path.join(f.project,'sections/main.liquid'),source);
  const cli = fileURLToPath(new URL('../scripts/perfkit.mjs',import.meta.url));
  const run = (...args) => promisify(execFile)(process.execPath,[cli,...args],{timeout:35000});
  const auditPath = path.join(f.root,'audit.json');
  try {
    await run('audit-performance','--project',f.project,'--out',auditPath);
  } catch (error) {
    assert.equal(error.code,3,error.stderr);
  }
  const audit = JSON.parse(await readFile(auditPath,'utf8'));
  const finding = audit.findings.find(entry=>entry.ruleId==='PERF_DUAL_HERO');
  assert.ok(finding);
  const out = path.join(f.root,'sampling');
  await run('plan-sampling','--audit',auditPath,'--finding',finding.id,'--url',f.url,'--out',out);
  assert.equal(f.requests.length,0);
  const plan = JSON.parse(await readFile(path.join(out,'sampling.json'),'utf8'));
  assert.deepEqual(plan.selectors,['img.hero--desktop','img.hero--mobile']);
  assert.deepEqual(plan.captures.map(capture=>capture.device),['mobile','desktop']);
  for (const capture of plan.captures) {
    const options = ['--config',capture.config];
    await run('validate-config','--command','profile-runtime',...options);
    try {
      await run(plan.command,...options,'--out',capture.output);
    } catch (error) {
      assert.equal(error.code,3,error.stderr);
    }
    const profile = JSON.parse(await readFile(path.join(capture.output,'profile.json'),'utf8'));
    assert.equal(profile.status,'complete',JSON.stringify(profile.errors));
    assert.equal(profile.snapshot.hash,audit.sourceHash);
    const chosen = f.url+capture.device+'.png';
    assert.equal(profile.initial.lcp?.presentation?.currentSrc,chosen,JSON.stringify({requests:f.requests,targets:profile.domainTargets}));
    assert.equal(profile.lcp.status,'observed');
    assert.ok(profile.resources.some(resource=>resource.url===chosen && resource.type==='Image'));
    assert.deepEqual(profile.domainTargetCoverage.configuredSelectors.map(entry=>entry.count),[1,1]);
    assert.ok(profile.domainTargets.some(target=>target.isLCP && target.currentSrc===chosen));
  }
  const profiles = JSON.parse(await readFile(plan.profiles,'utf8'));
  assert.deepEqual(profiles,plan.captures.map(capture=>path.join(capture.output,'profile.json')));
  const replayedAuditPath = path.join(f.root,'after-sampling-audit.json');
  try {
    await run('audit-performance','--project',f.project,'--profiles',plan.profiles,'--out',replayedAuditPath);
  } catch (error) {
    assert.equal(error.code,3,error.stderr);
  }
  const replayed = JSON.parse(await readFile(replayedAuditPath,'utf8'));
  assert.equal(replayed.findings.filter(entry=>entry.id.startsWith('runtime:') && entry.ruleId==='PERF_IMAGE_TAG_LOADING').length,2);
  const boundOutput = path.join(f.root,'bound-sampling');
  await run('plan-sampling','--audit',auditPath,'--finding',finding.id,'--url',f.url+'?preview_theme_id=123',
    '--store','fixture.myshopify.com','--device','mobile','--out',boundOutput);
  const bound = JSON.parse(await readFile(path.join(boundOutput,'sampling.json'),'utf8'));
  assert.equal(bound.command,'profile-domain');
  const [boundCapture] = bound.captures;
  await run('validate-config','--command',bound.command,'--config',boundCapture.config);
  const boundInput = JSON.parse(await readFile(boundCapture.config,'utf8'));
  const boundProfile = await profileDomain({config:boundInput,output:boundCapture.output,dependencies:{
    verifyDeployment:args=>verifyDeployment({...args,dependencies:{runProcess:async(_command,argv)=>{
      await cp(f.project,argv[argv.indexOf('--path')+1],{recursive:true});
      return {code:0};
    }}}),
  }});
  assert.equal(boundProfile.domainProof.before.sourceHash,audit.sourceHash);
  assert.equal(boundProfile.domainProof.after.status,'verified');
  assert.equal(boundProfile.initial.lcp?.presentation?.currentSrc,f.url+'mobile.png');
  assert.deepEqual(boundProfile.config.targetSelectors,plan.selectors);

  const requestCount = f.requests.length;
  await writeFile(path.join(f.project,'sections/main.liquid'),source+'<!-- drift -->');
  await assert.rejects(run('profile-runtime','--config',plan.captures[0].config,'--out',path.join(out,'drift')),
    error=>error.code===2 && /Audited source changed before runtime capture/.test(error.stderr));
  await assert.rejects(profileDomain({config:boundInput,output:path.join(boundOutput,'drift'),dependencies:{
    verifyDeployment:()=>assert.fail('Stale audit must stop before checking deployment'),
  }}),/Audited source changed before domain capture/);
  assert.equal(f.requests.length,requestCount);
});

test('real Chrome: generated picture requests only the selected mobile/desktop source at DPR 1 and 2', { skip: !enabled, timeout: 60000 }, async t => {
  const desktop = "{{ section.settings.desktop | image_url: width: 1600 | image_tag: alt: 'Hero', class: 'hero--desktop' }}";
  const mobile = "{{ section.settings.mobile | image_url: width: 800 | image_tag: alt: 'Hero', class: 'hero--mobile' }}";
  const source = desktop + '\n' + mobile, kind = 'liquid-picture-pair';
  const transformed = transformCode({ source, target: 'sections/main.liquid', kind, evidence: proof(source, kind),
    parameters: { desktopStart: 0, mobileStart: source.indexOf(mobile), breakpoint: 749, desktopWidths: [800, 1600], mobileWidths: [400, 800], sizes: '100vw', className: 'hero' } });
  // These local filters model only the supported rendering contract, not the Shopify service.
  const engine = new Liquid();
  engine.registerFilter('image_url', (input, ...args) => input.url + '?width=' + args.find(a => a[0] === 'width')[1]);
  engine.registerFilter('image_tag', (url, ...args) => {
    const a = Object.fromEntries(args), widths = a.widths.split(',').map(Number);
    return `<img src="${url}" srcset="${widths.map(w => url.replace(/width=\d+/, 'width=' + w) + ' ' + w + 'w').join(',')}" sizes="${a.sizes}" width="1600" height="800" class="${a.class}" alt="${a.alt}" loading="${a.loading}" fetchpriority="${a.fetchpriority}">`;
  });
  const body = await engine.parseAndRender(transformed.after, { section: { settings: {
    desktop: { url: '/desktop.svg', width: 1600, height: 800 }, mobile: { url: '/mobile.svg', width: 800, height: 400 },
  } } });
  const f = await fixture(t, '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>img{width:100%;height:auto}</style>' + body);
  const browser = await chromium.launch({ executablePath: await browserExecutable(), headless: true }); t.after(() => browser.close());
  for (const width of [390, 1440]) for (const dpr of [1, 2]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: dpr });
    const page = await context.newPage(), start = f.requests.length;
    await page.goto(f.url); await page.locator('img').evaluate(img => img.decode());
    const requests = f.requests.slice(start).filter(r => r.includes('.svg'));
    assert.equal(requests.length, 1, JSON.stringify(requests));
    assert.ok(requests[0].startsWith(width < 750 ? '/mobile.svg' : '/desktop.svg'));
    assert.equal(await page.locator('img').getAttribute('fetchpriority'), 'high');
    assert.equal(await page.locator('img').getAttribute('alt'), 'Hero');
    await context.close();
  }
});
test('real Chrome: reveal motion is recorded, missing LCP stays explicit, and the patch exposes first paint', { skip: !enabled, timeout: 120000 }, async t => {
  const source = '.hero{opacity:0;animation:reveal 200ms 200ms forwards;width:100%;height:auto}@keyframes reveal{to{opacity:1}}';
  const html = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/main.css"><h1 class="hero">Performance fixture with visible headline content</h1>';
  const files = { 'assets/main.css': source }, f = await fixture(t, html, files);
  const profile = await profileRuntime({ config: { schemaVersion: 1, project: f.project, url: f.url, device: 'mobile', state: 'initial', settleMs: 700, actions: [] }, output: path.join(f.root, 'profile') });
  assert.equal(profile.status, 'complete', JSON.stringify(profile.errors));
  assert.ok(profile.initial.motion.some(e=>e.type==='animationstart'&&e.name==='reveal'));
  const audit = await auditPerformance({ project: f.project, profiles: [profile] });
  assert.ok(audit.findings.some(f => f.ruleId === 'PERF_LCP_REVEAL'));
  if (profile.initial.lcp) assert.ok(profile.initial.lcp.presentation.ancestors[0].animations.length > 0);
  else {
    assert.ok(audit.issues.some(i=>i.reason==='lcp-presentation-unavailable-recapture'));
    assert.ok(!audit.findings.some(f=>f.id.startsWith('runtime:')));
  }
  const kind = 'css-lcp-reveal', changed = transformCode({ source, target: 'assets/main.css', kind, parameters: { selector: '.hero' }, evidence: proof(source, kind) });
  files['assets/main.css']=changed.after;await writeFile(path.join(f.project,'assets/main.css'),changed.after);
  const after=await profileRuntime({config:{schemaVersion:1,project:f.project,url:f.url,device:'mobile',state:'initial',settleMs:700,actions:[]},output:path.join(f.root,'after')});
  assert.equal(after.status,'complete',JSON.stringify(after.errors));
  assert.equal(after.initial.lcp?.presentation?.tag,'H1',JSON.stringify(after.initial));
  assert.equal(after.initial.lcp.presentation.ancestors[0].opacity,'1');
  const browser = await chromium.launch({ executablePath: await browserExecutable(), headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<style>${changed.after}</style><img class="hero" alt="Fixture" width="400" height="200">`);
  const computed = await page.locator('img').evaluate(el => ({ opacity: getComputedStyle(el).opacity, animation: getComputedStyle(el).animationName }));
  assert.deepEqual(computed, { opacity: '1', animation: 'none' });
});


test('real Chrome: generated font fallback is requested and used for rendered glyphs', {skip:!enabled,timeout:30000}, async t=>{
  // This proves functional font wiring, not merchant CLS improvement. Metrics here are synthetic.
  const source='.heading { font-family: "Missing Web Font", sans-serif; font-size: 30px; }';
  const after=transformCode({source,target:'assets/main.css',kind:'css-font-fallback',parameters:{selector:'.heading',family:'Fixture Fallback',local:'Arial',sizeAdjust:100,ascentOverride:90,descentOverride:20,lineGapOverride:0},
    evidence:{sourceHash:createHash('sha256').update(source).digest('hex'),summary:'Synthetic font consumer fixture',fontMetricsMeasured:true}}).after;
  const browser=await chromium.launch({executablePath:await browserExecutable(),headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();await page.setContent('<style>'+after+'</style><h1 class="heading">Measured fallback text</h1>');
  await page.evaluate(()=>document.fonts.ready);
  const used=await page.evaluate(()=>({family:getComputedStyle(document.querySelector('.heading')).fontFamily,faces:[...document.fonts].map(f=>({family:f.family,status:f.status}))}));
  assert.match(used.family,/Missing Web Font.*Fixture Fallback.*sans-serif/);assert.ok(used.faces.some(f=>f.family.includes('Fixture Fallback')&&f.status==='loaded'));
  const cdp=await page.context().newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');
  const doc=await cdp.send('DOM.getDocument'),node=await cdp.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'.heading'});
  const fonts=await cdp.send('CSS.getPlatformFontsForNode',{nodeId:node.nodeId});assert.ok(fonts.fonts.some(f=>f.glyphCount>0&&/Arial/i.test(f.familyName)),JSON.stringify(fonts));
});
