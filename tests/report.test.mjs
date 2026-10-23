import test from 'node:test';
import assert from 'node:assert/strict';
import {renderReport} from '../lib/report.mjs';
test('report treats captured content as text and redacts token URL and credential keys',()=>{
  const html=renderReport({schemaVersion:1,kind:'inspection',target:'<script>alert(1)</script>',token:'secret-value',environment:{url:'https://example.com/x?width=900&token=sensitive'},findings:[{summary:'<img src=x onerror=alert(1)>',ruleId:'IMG02'}]});
  assert(!html.includes('<script>'));assert(!html.includes('secret-value'));assert(!html.includes('token=sensitive'));assert(html.includes('width=900'));assert(html.includes('&lt;img'));assert(html.includes('Content-Security-Policy'));
});
test('unsupported schemas cannot be rendered as successful reports',()=>assert.throws(()=>renderReport({schemaVersion:99}),/schema/));

test('new report views retain mapping ambiguity, scan incompleteness, and scenario failures as escaped evidence', () => {
  const scan = renderReport({ schemaVersion: 1, kind: 'site-scan', complete: false, summary: { files: 2 }, inventory: { files: [{}, {}], assets: [] }, pages: [], dependencies: [], errors: [{ path: 'templates/index.json', message: 'invalid JSON' }] });
  assert.match(scan, /扫描未完成/);
  assert.match(scan, /invalid JSON/);
  const mapping = renderReport({ schemaVersion: 1, kind: 'mapping', mappings: [], ambiguous: [{ selector: '<img onerror="alert(1)">', reason: 'duplicate' }], unmapped: [] });
  assert.ok(!mapping.includes('<img onerror'));
  assert.match(mapping, /duplicate/);
  const scenarios = renderReport({ schemaVersion: 1, kind: 'scenarios', outcome: 'failed', runs: [{ name: 'first-click', viewport: { width: 390 }, outcome: 'failed', steps: [{ error: { message: '<script>bad</script>' } }] }] });
  assert.match(scenarios, /first-click/);
  assert.match(scenarios, /failed/);
  assert.ok(!scenarios.includes('<script>'));
});

test('site audit, verification and change plans preserve findings, failures and full plan evidence', () => {
  const audit = renderReport({ schemaVersion: 1, kind: 'site-audit', findings: [{ ruleId: 'LCP', status: 'candidate', file: 'layout/theme.liquid', line: 1, summary: 'Late image discovery' }] });
  assert.match(audit, /整站性能诊断/);
  assert.match(audit, /Late image discovery/);
  const verification = renderReport({ schemaVersion: 1, kind: 'site-verification', outcome: 'failed', checks: [{ id: 'target-score', status: 'fail', message: 'Mobile target missed' }] });
  assert.match(verification, /整站前后验证/);
  assert.match(verification, /Mobile target missed/);
  assert.match(verification, /failed/);
  const plan = renderReport({ schemaVersion: 1, kind: 'site-change-plan', changes: [{ file: 'assets/main.js', after: '<script>unsafe display content</script>' }] });
  assert.match(plan, /整站修改计划/);
  assert.match(plan, /assets\/main.js/);
  assert.match(plan, /&lt;script&gt;unsafe display content&lt;\/script&gt;/);
  assert.ok(!plan.includes('<script>'));
});

const visibleReport=html=>html.split('<details><summary>查看完整结构化证据')[0];

test('site verification displays per-device score ranges, explicit thresholds and exact status without rounding or null coercion',()=>{
  const html=visibleReport(renderReport({schemaVersion:1,kind:'site-verification',outcome:'targets-not-met',groups:[{},{}],checks:[
    {pageId:'home',device:'mobile',status:'fail',message:'Median missed target',details:{
      before:{metrics:{performance_score:{min:0,median:null,max:80}}},
      after:{metrics:{performance_score:{min:75,median:79.999999,max:95}}},
      thresholds:{minimum_each_after_run:75,target_after_median:80},
    }},
    {pageId:'product',device:'desktop',status:'invalid',message:'Missing original reports',details:{
      before:{metrics:{performance_score:{min:null,median:null,max:null}}},
      thresholds:{minimum_each_after_run:0,target_after_median:0},
    }},
  ]}));
  assert.match(html,/页面 \/ 设备组<b>2<\/b>/);
  assert.doesNotMatch(html,/图片使用对象/);
  assert.match(html,/<th>优化前最低<\/th>/);
  assert.match(html,/<th>优化后最高<\/th>/);
  assert.match(html,/<td>home<\/td><td>mobile<\/td><td>0<\/td><td>—<\/td><td>80<\/td><td>75<\/td><td>79\.999999<\/td><td>95<\/td><td>75<\/td><td>80<\/td><td>fail<\/td>/);
  assert.match(html,/<td>product<\/td><td>desktop<\/td>(?:<td>—<\/td>){6}<td>0<\/td><td>0<\/td><td>invalid<\/td>/);
  assert.match(html,/Missing original reports/);
  assert.doesNotMatch(html,/<td>null<\/td>|<td>NaN<\/td>/);
});

test('site audit exposes metric medians, resource candidates and non-additive estimates while preserving missing values and redaction',()=>{
  const html=visibleReport(renderReport({schemaVersion:1,kind:'site-audit',outcome:'partial',groups:[
    {pageId:'home',device:'mobile',status:'failed',reports:['one.json'],metrics:{performance:{median:0},lcpMs:{median:null},tbtMs:{median:0},cls:{median:null}}},
  ],findings:[{ruleId:'render-blocking-insight',priority:'P1',pageId:'home',device:'mobile',summary:'Blocking <script>',
    estimate:{milliseconds:{median:0},bytes:{median:null},basis:'Largest resource row, not a total'},
    sourceCandidates:[{status:'candidate',file:'assets/theme.js',url:'https://example.test/assets/theme.js?token=private-estimate'}],
  }],resources:[
    {pageId:'home',device:'mobile',url:'https://example.test/assets/theme.js?token=private-resource',source:{status:'candidate',file:'assets/theme.js',reason:'Filename candidate only'},evidence:[{transferSize:0}]},
    {pageId:'home',device:'mobile',url:'https://external.test/theme.js',source:{status:'unmapped',reason:'External origin'},evidence:[{transferSize:null}]},
  ]}));
  assert.match(html,/页面 \/ 设备组<b>1<\/b>/);
  assert.doesNotMatch(html,/图片使用对象/);
  assert.match(html,/<td>home<\/td><td>mobile<\/td><td>1<\/td><td>0<\/td><td>—<\/td><td>0<\/td><td>—<\/td><td>failed<\/td>/);
  assert.match(html,/<td>Blocking &lt;script&gt;<\/td><td>0<\/td><td>—<\/td>/);
  assert.match(html,/不可相加/);
  assert.match(html,/Largest resource row, not a total/);
  assert.match(html,/assets\/theme\.js（仅候选）/);
  assert.match(html,/未关联 \/ 待定位/);
  assert.match(html,/<td>External origin<\/td><td>—<\/td>/);
  assert.doesNotMatch(html,/private-resource|private-estimate|<script>/);
});

test('site change plans show folded escaped diffs with embedded credential URLs redacted',()=>{
  const input={schemaVersion:1,kind:'site-change-plan',changes:[{
    target:'assets/theme.js',recipeKind:'reviewed-replacement',reason:'Reviewed <script> source',evidence:{summary:'Exact source review',password:'private-password'},
    diff:'--- a/assets/theme.js\n+++ b/assets/theme.js\n- old\n+ <script src="https://user:private-credential@example.test/a.js?token=private-diff&width=900"></script>\n',
  }]};
  const complete=renderReport(input),html=visibleReport(complete);
  assert.match(html,/目标文件<b>1<\/b>/);
  assert.doesNotMatch(html,/图片使用对象/);
  assert.match(html,/待审核/);
  assert.match(html,/<details class="change-diff"><summary>assets\/theme\.js · reviewed-replacement · 查看 diff<\/summary><pre>/);
  assert.match(html,/--- a\/assets\/theme\.js/);
  assert.match(html,/\+ &lt;script src=&quot;/);
  assert.match(html,/width=900/);
  assert.doesNotMatch(complete,/<script>|private-password|private-credential|private-diff/);
  assert.doesNotMatch(html,/<details[^>]* open/);
  assert.match(input.changes[0].diff,/private-diff/,'rendering must not modify authoritative plan source');
});
