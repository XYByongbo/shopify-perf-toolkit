import {reportActions} from './report-actions.mjs';
import {escapeHTML as esc} from './core/report-format.mjs';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function sanitize(v) {
  if(Array.isArray(v)) return v.map(sanitize);
  if(v&&typeof v==='object') return Object.fromEntries(Object.entries(v).map(([k,x])=>[/token|cookie|authorization|password|secret/i.test(k)?k:k,/token|cookie|authorization|password|secret/i.test(k)?'[redacted]':sanitize(x)]));
  if(typeof v==='string') return v.replace(/https?:\/\/[^\s<>"'`]+/gi,value=>{try {const u=new URL(value);u.username='';u.password='';for(const k of [...u.searchParams.keys()])if(/token|key|secret|signature|password|code|email/i.test(k))u.searchParams.set(k,'[redacted]');return u.href;}catch{return value;}});
  return v;
}
function table(headers,rows) {return `<div class="table"><table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(x=>`<td>${esc(x!==null&&typeof x==='object'?JSON.stringify(x):x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;}
const numeric=value=>typeof value==='number'&&Number.isFinite(value)?String(value):'—';
const median=stat=>numeric(stat?.median);
const sourceLabel=source=>source?.status==='candidate'?`${source.file??'待定位'}（仅候选）`:source?.file?`${source.file}（${source.status??'待确认'}）`:'未关联 / 待定位';
function summaryCards(d,findings,images) {
  const status=['验收状态',d.outcome??(d.complete===false?'扫描未完成':d.kind==='site-change-plan'?'待审核':'待验证')];
  if(d.kind==='theme-diff') return [['修改文件',d.summary.modified],['新增 / 删除',`${d.summary.added} / ${d.summary.deleted}`],['性能收益','未实测']];
  if(d.kind==='theme-precheck') return [['复杂度超限',d.summary?.complexity],['嵌套超限',d.summary?.nesting],['预检状态',d.complete?'完成（不等于无告警）':'未完成']];
  if(d.kind==='rendered-html-audit') return [['HTML 错误',d.summary.errors],['待复核',d.summary.warnings],['分析范围',d.scope]];
  if(d.kind==='check-import') return [['报告条目',findings.length],['校正注记',d.summary?.corrections??0],['基线门禁',d.comparison?.gate??'not-evaluated']];
  if(d.kind==='resource-audit') return [['外链资源',d.resources?.length??0],['脚本',d.scripts?.length??0],['分析状态',d.complete?'静态分析完成':'分析不完整']];
  if(d.kind==='site-verification') return [['页面 / 设备组',d.groups?.length??d.summary?.groups??(d.checks??[]).filter(check=>check.pageId&&check.device).length],['达到目标的组',d.summary?.passed??(d.checks??[]).filter(check=>check.status==='pass').length],status];
  if(d.kind==='site-audit') return [['页面 / 设备组',d.groups?.length??0],['问题候选',findings.length],status];
  if(d.kind==='site-change-plan') return [['目标文件',new Set((d.changes??[]).map(change=>change.target??change.file).filter(Boolean)).size],['修改项',d.changes?.length??0],status];
  return [[d.kind==='site-scan'?'扫描文件':d.kind==='mapping'?'关联对象':d.kind==='scenarios'?'场景运行':'图片使用对象',d.inventory?.files?.length??d.mappings?.length??d.runs?.length??images.length],['问题候选',findings.length],status];
}
function integritySections(d) {
  if(d.runtimeIntegrity?.status==='not-assessed')return '<h2>LCP 身份与重复加载检查</h2><p class="note">未提供 integrityProfiles，新完整性门禁未检测。旧流程验收不能解释为已完成本检测。</p>';
  const reports=d.kind==='runtime-integrity'?[d]:d.kind==='runtime-profile'&&d.integrity?[d.integrity]:d.intelligence?.runtimeIntegrity??d.runtimeIntegrity?.reports??[];
  if(!reports.length)return '';
  return '<h2>LCP 身份与重复加载检查</h2>'+table(['页面','LCP 状态','指标使用','请求检查','初始化事件','完整性'],reports.map(r=>[r.input?.page,r.lcpStatus,r.metricUse,r.requestStatus,r.eventStatus,r.complete]))
    +table(['规则','结论','证据'],reports.flatMap(r=>(r.findings??[]).map(f=>[f.ruleId,f.summary,f.evidence])))
    +'<h2>检测范围与缺失证据</h2>'+table(['页面','范围','未完成项'],reports.map(r=>[r.input?.page,r.scope,r.issues]))
    +'<p class="note">LCP 可见性采于 observer 回调与采集结束，不等于逐帧绘制状态。重复请求不证明重复下载或执行；旧报告缺字段需重新采集。无异常仅适用于已记录窗口，不是正式性能验收。</p>';
}

function governanceSections(d){
  const parts=[];
  if(d.checkResults||d.kind==='performance-audit'||d.kind==='pageotter-import'){
    const actions=reportActions(d);
    parts.push('<h2>处理清单</h2>'+table(['要修','待确认','未测'],[[actions.counts.fix,actions.counts.review,actions.counts.notRun]]));
    for(const [id,title] of [['fix','要修'],['review','待确认'],['notRun','未测']])if(actions.groups[id].length)parts.push('<h3>'+title+'</h3>'+table(['问题','规范编号','位置','原因 / 下一步'],actions.groups[id].map(r=>[r.summary,r.ruleIds,r.location,r.reason])));
    for(const [id,title] of [['passed','已通过（所述范围）'],['notApplicable','不适用']])if(actions.groups[id].length)parts.push('<details><summary>'+title+'</summary>'+table(['检查','原因'],actions.groups[id].map(r=>[r.summary,r.reason]))+'</details>');
    parts.push('<p class="note">按任务 / 检查行计数；候选需确认，外部观察需复现，未测不计为通过。</p>');
  }
  if(d.acceptancePolicy)parts.push('<h2>验收策略</h2>'+table(['策略','分数门禁','结论范围'],[[d.acceptancePolicy.id,d.acceptancePolicy.scoreGate,d.scope]]));
  if(d.kind==='pageotter-import')parts.push('<h2>PageOtter 页面身份与对比</h2>'+table(['页面','主题 / 角色','类型','语言 / 币种','视口'],[[d.identity.url,d.identity.themeId+' / '+d.identity.themeRole,d.identity.pageType,d.identity.language+' / '+d.identity.currency,d.identity.viewport]])+table(['对比状态','新增','仍存在','已修复','无法比较'],[[d.comparison.status,d.comparison.added,d.comparison.existing,d.comparison.resolved,d.comparison.incomparable]]));
  if(d.standards?.id)parts.push('<h2>规范参考版本</h2>'+table(['规范','版本','状态','执行方式','指纹'],[[d.standards.id,d.standards.version,d.standards.status,d.standards.enforcement,d.standards.sha256]])+'<p class="note">规范编号表示相关规则；映射不代表整条规则已检测或通过。待评审规范未自动成为发布门禁。</p>');
  if(d.provenance)parts.push('<h2>交付版本与执行门禁</h2>'+table(['包版本','源码指纹','策略状态'],[[d.provenance.toolkit?.version,d.provenance.toolkit?.sourceHash,d.provenance.status]]));
  if(d.gates)parts.push(table(['门禁','已启用','已执行','结果'],d.gates.map(g=>[g.id,g.enabled,g.executed,g.status])));
  if(d.checkResults)parts.push('<h2>检查结果（四态）</h2>'+table(['检查','结果','已执行','原因'],d.checkResults.map(c=>[c.id,c.status,c.executed,c.reason]))+'<p class="note">检查结果与发布决定分开；必需证据 NOT RUN 仍阻止验收，N/A 必须有明确的不适用理由。</p>');
  if(d.kind==='adapter-registry-resolution')parts.push('<h2>主题适配结果</h2>'+table(['适配器','结果','拒绝原因'],(d.resolutions??[]).map(r=>[`${r.adapter?.id}@${r.adapter?.version}`,r.status,r.reasons])));
  if(d.kind==='window-budget')parts.push('<h2>窗口资源预算</h2><p>'+esc(d.metric)+'</p>'+table(['页面/设备','窗口','传输字节','请求','完整','通过','问题'],d.details.map(r=>[`${r.url}/${r.device}`,r.window,r.transferBytes,r.requests,r.complete,r.pass,r.issues])));
  if(d.kind==='engineering-policy-audit')parts.push('<h2>增量工程规则</h2>'+table(['文件','规则','实际','复核线','新增/恶化','例外'],d.findings.map(f=>[f.file,f.rule,f.value,f.limit,f.introducedOrWorsened,f.exception]))+'<p>'+esc(d.notAssessed.join(' '))+'</p>');
  if(d.kind==='business-verification')parts.push('<h2>外部业务观察</h2>'+table(['场景','通过','原因','原始文件'],d.checks.map(c=>[c.id,c.pass,c.reason,c.artifact])));
  if(d.kind==='field-monitor')parts.push('<h2>现场汇总监测</h2>'+table(['轮次','来源','状态','告警','错误'],d.cycles.flatMap(c=>c.records.map(r=>[c.cycle,r.sourceId,r.status,r.alerts,r.error]))));
  if(d.kind==='field-trend')parts.push('<h2>现场趋势（不作因果归因）</h2>'+table(['分组','状态','限制','差值'],d.groups.map(g=>[g.key,g.status,g.reasons,g.deltas])));
  return parts.join('\n');
}
function intelligenceSections(d) {
  const i=d.intelligence;if(!i)return '';
  return '<h2>资源与字体执行证据</h2>'+table(['页面','设备','实际请求','唯一 URL','健康状态'],(i.resources?.captures??[]).map(c=>[c.page,c.device,c.requestCount,c.uniqueUrlCount,c.health?.status]))
    +table(['页面','资源','请求数','CPU self ms','下一步'],(i.resources?.captures??[]).flatMap(c=>(c.resourceGroups??[]).map(g=>[c.page,g.url,g.requestCount,g.cpuSelfMs,c.requests.find(r=>r.resourceGroupId===g.id)?.next])))
    +table(['字体源码','参数位置','生成入口','验证要求'],(i.fonts?.reviewTasks??[]).map(f=>[f.file,f.offset,f.route,f.required]))
    +'<h2>源码归属与结构依赖</h2>'+table(['文件','归属状态','生成器线索','下一步'],(i.ownership??[]).filter(f=>f.generators?.length||f.owner).map(f=>[f.file,f.status,f.generators,f.action]))
    +table(['文件','顶层设置','解析状态','别名','动态访问'],(i.structure??[]).filter(f=>f.topLevelSettings||f.parseStatus==='schema-review-required').map(f=>[f.file,f.topLevelSettings,f.parseStatus,f.aliases,f.dynamic]))
    +(d.workflow?'<h2>工作流待补证据</h2>'+table(['阶段','源码 / 资源','下一步','证据要求'],(d.workflow.reviewTasks??[]).map(t=>[t.stage,t.file??t.url,t.action,t.required??'实际成本、使用与源码绑定'])):'')
    +'<h2>观察基线与豁免覆盖</h2>'+table(['字段','证据'],Object.entries({observation:d.observationChanges??null,waivers:i.waivers??null}));
}
function extendedSections(d) {
  if(d.kind==='theme-diff') return '<h2>主题文件差异</h2>'+table(['文件','状态','类型','前 / 后字节','JSON 字段变化'],d.changes.map(c=>[c.file,c.status,c.kind,`${c.beforeBytes} / ${c.afterBytes}`,c.fields?.length??'—']))+'<h2>字段差异</h2>'+table(['文件','JSON Pointer','变化','之前','之后'],d.changes.flatMap(c=>(c.fields??[]).map(f=>[c.file,f.jsonPointer,f.change,f.before,f.after])))+'<h2>未完成项</h2>'+table(['位置','原因'],d.issues.map(i=>[i.file??i.path,i.reason??i.message]));
  if(d.kind==='rendered-html-audit') return '<h2>渲染后 HTML 审查</h2><p class="note">只读保存的 HTML；不会渲染 Liquid、执行 JS 或连接店铺。输入指纹不证明源码及部署身份，检查通过不等于性能或购买功能验收。</p>'
    +table(['输入文件','SHA-256','字节','调用方提供的 LCP ID'],[[d.input?.file,d.input?.sha256,d.input?.bytes,d.input?.callerLcpId]])
    +table(['规则','级别','HTML 行','问题'],(d.findings??[]).map(f=>[f.code,f.severity,f.line,f.summary]))
    +table(['对象','数量'],Object.entries(d.inventory??{}))
    +(d.findings_truncated?'<p class="note">问题详情仅展示前 200 项，汇总数量保留全部问题。</p>':'');
  if(d.kind==='improvement-session') return '<h2>优化会话</h2>'+table(['状态','下一步','已测试轮数','保留补丁'],[[d.status,d.next,d.history?.length,d.retained?.length]])
    +'<h2>全部实验历史</h2>'+table(['方法','假设','结果','补丁指纹'],(d.history??[]).map(h=>[h.method,h.rationale,h.outcome,h.fingerprint]));
  if(d.kind==='recovery-diagnosis') return '<h2>实测丢分与剩余目标</h2>'+table(['页面','设备','评分分布','低于目标','指标丢分'],(d.groups??[]).map(g=>[g.pageId,g.device,g.score,g.belowTarget,g.metrics]))
    +'<h2>可执行优化范围</h2>'+table(['状态','可执行候选','能力边界'],[[d.executionCoverage?.status,d.executionCoverage?.supportedCandidates,d.executionCoverage?.reason]])
    +'<h2>下一轮候选</h2>'+table(['源码','指标','已测试方法','下一步'],(d.candidates??[]).map(c=>[`${c.file}:${c.line}`,c.metric,c.tested,c.next]))
    +'<h2>重新诊断任务</h2>'+table(['页面 / 设备','问题','需要的证据','实现入口','官方依据'],(d.investigations??[]).map(i=>[`${i.pageId} / ${i.device}`,i.question,i.evidence,i.implementation,i.source]));
  if(d.kind==='performance-audit') return '<h2>Shopify P0 / P1 规则覆盖</h2>'
    +table(['规则','规范编号','实施批次','静态分析','运行证据','候选数'],(d.coverage??[]).map(r=>[r.id,r.standardRuleIds??[],r.phase,r.static,r.runtime,r.findings]))
    +'<h2>未完成项</h2>'+table(['文件 / 采样','原因'],(d.issues??[]).map(i=>[i.file??i.profileIndex,i.reason]))
    +'<p class="note">候选不代表已确认瓶颈。image_tag 分支、共享实例、真实 LCP 和流式响应需要对应的运行证据；审阅标志不自动填写。</p>';
  if(d.kind==='theme-precheck') return '<h2>Liquid 前期预检</h2><p class="note">官方告警属于维护性问题，不代表页面耗时。建议未经人工复核；不会自动简化条件或拆分 snippet。</p>'
    +table(['检查器','CLI','阈值'],[[d.checker?.checkerVersion,d.checker?.cliVersion,d.thresholds]])
    +table(['规则','文件','行','实际值','阈值','嵌套路径','建议','影响范围'],(d.findings??[]).map(f=>[f.ruleId,f.file,f.line,f.actual,f.threshold,(f.nestingPath??[]).map(p=>`${p.line}: ${p.tag}`).join(' → '),[f.review?.recommendation,...(f.review?.hints??[]).map(h=>h.reason)].join('\n'),{directCallers:f.review?.impact?.directCallers,pageflyCandidates:f.review?.impact?.pageflyCandidates,generatedMarker:f.review?.impact?.generatedMarker}]))
    +'<h2>未完成或需复核项</h2>'+table(['文件','原因','说明'],(d.issues??[]).map(i=>[i.file,i.reason,i.detail]))
    +'<h2>范围与限制</h2>'+table(['说明'],(d.limitations??[]).map(x=>[x]));
  if(d.kind==='field-evidence')return '<h2>真实用户数据（p75）</h2>'+table(['页面范围','设备','地区','样本数','状态','指标','证据限制'],(d.groups??[]).map(g=>[g.url+' · '+g.scope,g.device,g.country,g.samples,g.status,g.metrics,g.issues]))+'<p class="note">聚合线上数据用于选题；不证明本地源码身份、补丁因果收益或实验室验收。</p>';
  if(d.kind==='stylesheet-audit')return '<h2>原生样式裁剪兼容性</h2>'+table(['文件','stylesheet 数量','作用域类'],(d.files??[]).map(f=>[f.file,f.stylesheetCount,f.classes]))+'<h2>待复核依赖</h2>'+table(['文件','行','类名','定义文件'],(d.findings??[]).map(f=>[f.file,f.line,f.className,f.providers]))+'<h2>未解析项</h2>'+table(['文件','原因'],(d.unresolved??[]).map(u=>[u.file??u.from,u.reason]));
  if(d.kind==='app-attribution')return '<h2>资源归属与请求</h2>'+table(['资源','归属','状态','请求耗时 ms'],(d.resources??[]).map(r=>[r.url,r.owner?.name,r.owner?.status,r.requestMs]))+'<h2>分阶段 CPU self time</h2>'+table(['页面','设备','状态','阶段','归属','self ms'],(d.groups??[]).map(g=>[g.url,g.device,g.state,g.phase,g.owner?.name??g.resource,g.selfMs]));
  if(d.kind==='bottleneck-diagnosis')return '<h2>目标与优先候选</h2>'+table(['目标','线上证据状态'],[[d.goal,d.fieldStatus]])+table(['文件','行','指标','观测成本 ms','优先依据','建议策略'],(d.candidates??[]).map(c=>[c.file,c.line,c.metric,c.costMs,c.priority,c.recommendedStrategy]))+'<h2>阶段与交互</h2>'+table(['页面','设备','状态','阶段筛查','交互'],(d.phases??[]).map(p=>[p.url,p.device,p.state,p.gaps,p.interactions]))+(d.apps?extendedSections(d.apps):'')+(d.stylesheets?extendedSections(d.stylesheets):'');
  if(d.kind==='ci-verification')return '<h2>CI 门禁</h2>'+table(['结果','目标','基线提交','候选提交','完整优化验收'],[[d.outcome,d.goal,d.revisions?.before,d.revisions?.after,d.optimization]])+table(['检查','通过'],(d.checks??[]).map(c=>[c.id,c.pass]))+(d.scores?extendedSections(d.scores):'');
  if(d.kind==='interaction-verification')return '<h2>声明交互的独立样本</h2>'+table(['目标','优化前','优化后','收益 ms','噪声/最低收益门槛','结果'],[[d.goal,d.before,d.after,d.gain,d.floor,d.outcome]])+'<p class="note">实验室 Event Timing 结果，不是线上 INP，也不是完整优化验收。</p>';
  if(d.kind==='check-import') return '<h2>报告导入与校正</h2><p class="note">原告警完整保留；校正注记不自动屏蔽错误。汇总 PDF 不是源码验证；告警减少不等于性能提升。</p>'
    +table(['规则','原严重度','分类','位置','数量','校正状态','依据','源码绑定'],(d.findings??[]).map(f=>[f.ruleId,f.originalSeverity,f.category,[f.file,f.line].filter(Boolean).join(':'),f.count,f.correction?.status,f.correction?.reason,f.sourceBinding]))
    +'<h2>基线对比</h2>'+table(['字段','结果'],Object.entries(d.comparison??{}));
  if(d.kind==='resource-audit') return '<h2>外链资源</h2>'
    +table(['域名','URL','分类','引用位置','联网检查'],(d.resources??[]).map(r=>[r.host,r.url,r.classification,(r.references??[]).map(ref=>`${ref.file}:${ref.line}`).join(' · '),[r.network?.status,r.network?.contentType,r.network?.reason].filter(Boolean).join(' · ')]))
    +'<h2>脚本加载与依赖候选</h2>'+table(['文件','行','来源','加载方式','本地资源'],(d.scripts??[]).map(s=>[s.file,s.line,s.source,s.mode,s.assetStatus]))
    +'<h2>顺序关系（不等于已证实依赖）</h2>'+table(['前置脚本','后续内联脚本','依据'],(d.relationships??[]).map(r=>[r.from,r.to,r.reason]))
    +'<h2>未解析项</h2>'+table(['文件','行','原因'],[...(d.unresolved??[]),...(d.errors??[])].map(r=>[r.file,r.line,r.reason??r.message]));

  if(d.kind==='site-verification') return '<h2>每页 / 设备评分</h2><p class="muted">性能分数为 0–100。按原始数值展示；— 表示缺少证据。状态沿用评分检查结果，不在报告中重新判定。最低门槛适用于每次优化后运行，中位门槛适用于优化后中位数。</p>'
    +table(['页面','设备','优化前最低','优化前中位','优化前最高','优化后最低','优化后中位','优化后最高','每次最低门槛','中位门槛','状态'],(d.checks??[]).map(check=>{
      const before=check.details?.before?.metrics?.performance_score,after=check.details?.after?.metrics?.performance_score;
      return [check.pageId??check.id??'证据检查',check.device,...['min','median','max'].map(key=>numeric(before?.[key])),...['min','median','max'].map(key=>numeric(after?.[key])),numeric(check.details?.thresholds?.minimum_each_after_run),numeric(check.details?.thresholds?.target_after_median),check.status];
    }))+'<h2>检查说明</h2>'+table(['页面 / 检查','设备','地址','说明','需要复核'],(d.checks??[]).map(check=>[check.pageId??check.id,check.device,check.url,check.message??check.detail??check.reason,check.details?.review_reasons??[]]));
  if(d.kind==='site-audit') return '<h2>每页 / 设备实测指标</h2><p class="muted">各项展示可用原始报告的中位数；分数为 0–100，LCP / TBT 单位为毫秒，CLS 无单位。— 表示未测或无有效值，不代表 0 或通过。</p>'
    +table(['页面','设备','报告数','性能分数','LCP (ms)','TBT (ms)','CLS','证据状态'],(d.groups??[]).map(group=>[group.pageId,group.device,group.reports?.length??group.metrics?.performance?.n??'—',median(group.metrics?.performance),median(group.metrics?.lcpMs),median(group.metrics?.tbtMs),median(group.metrics?.cls),group.status]))
    +'<h2>运行瓶颈与预估收益</h2><p class="note">预估收益可能重叠，不可相加，也不是实际提升保证。字节估值可能仅为最大资源行；具体依据见表格和完整证据。</p>'
    +table(['优先级','页面 / 设备','审计项','预估中位节省 (ms)','预估中位节省 (bytes)','源码候选','估值依据'],(d.findings??[]).filter(finding=>finding.estimate).map(finding=>[finding.priority,[finding.pageId,finding.device].filter(Boolean).join(' / '),finding.summary??finding.ruleId,median(finding.estimate?.milliseconds),median(finding.estimate?.bytes),(finding.sourceCandidates??[]).map(source=>`${sourceLabel(source)}：${source.url??''}`).join('\n')||finding.file||'待定位',finding.estimate?.basis]))
    +'<h2>资源与源码关联候选</h2><p class="muted">文件名关联只表示候选，不证明部署源码身份。第三方资源保持未关联；修改前需核对实际来源。</p>'
    +table(['页面','设备','资源 URL','来源候选','关联依据','观测传输字节'],(d.resources??[]).map(resource=>[resource.pageId,resource.device,resource.url,sourceLabel(resource.source),resource.source?.reason,[...new Set((resource.evidence??[]).map(entry=>entry.transferSize).filter(value=>typeof value==='number'&&Number.isFinite(value)))].map(numeric).join(', ')||'—']));
  if(d.kind==='site-change-plan') return '<h2>待审核修改</h2><p class="muted">展开每项查看完整差异。差异只作为转义后的文本展示；执行结果、功能、视觉和性能仍需验证。</p>'
    +table(['目标','类型','修改理由','证据摘要'],(d.changes??[]).map(change=>[change.target??change.file,change.recipeKind??change.operation,change.reason??change.description,change.evidence?.summary]))
    +(d.changes??[]).map(change=>`<details class="change-diff"><summary>${esc(change.target??change.file)} · ${esc(change.recipeKind??change.operation??'待确认类型')} · 查看 diff</summary><pre>${esc(typeof change.diff==='string'?change.diff:'未提供 diff；请查看完整结构化证据中的修改前后文本。')}</pre></details>`).join('');
  if(d.kind==='site-scan') return '<h2>扫描摘要</h2>'+table(['项目','结果'],Object.entries(d.summary??{}))
    +'<h2>优先调查</h2>'+table(['优先级','文件','候选','需要验证'],(d.candidates??[]).map(c=>[c.priority,c.file,c.summary,c.verification]))
    +'<h2>代表页面</h2>'+table(['模板','类型','地址 / 待补充','状态'],(d.pages??[]).map(p=>[p.template,p.type,p.url??'需提供真实地址',p.states??p.state??p.reason]))
    +'<h2>依赖关系</h2>'+table(['来源','目标','类型','状态'],(d.dependencies??[]).map(e=>[e.from,e.to,e.type,e.status]))
    +'<h2>资源文件（原始字节）</h2>'+table(['文件','字节','摘要'],(d.inventory?.assets??[]).map(f=>[f.path,f.rawBytes,f.sha256]))
    +(d.errors?.length||d.skipped?.length?'<h2>未完成项</h2>'+table(['文件','原因'],[...(d.errors??[]),...(d.skipped??[])].map(e=>[e.path??e.file??e.target,e.message??e.reason??e])):'');
  if(d.kind==='mapping') return '<h2>源码关联</h2>'+table(['页面元素','源码','源索引','依据 / 置信度'],(d.mappings??[]).map(m=>[m.selector??m.domSelector,m.sourcePath??m.target,m.sourceIndex,m.confidence??m.method??m]))
    +'<h2>组件上下文</h2>'+table(['实例','源码','状态'],(d.components??[]).map(c=>[c.id,c.sourcePath??c.target,c.status]))
    +'<h2>歧义与未关联</h2>'+table(['类型','证据'],[...(d.ambiguous??[]).map(m=>['歧义',m]),...(d.unmapped??[]).map(m=>['未关联',m])]);
  if(d.kind==='scenarios') return '<h2>场景与设备</h2>'+table(['场景','设备','结果','步骤'],(d.runs??[]).map(r=>[r.scenario??r.name,r.viewport,r.outcome,r.steps??r.checks]))
    +'<p class="muted">截图与失败证据位于场景输出目录。通过仅覆盖配置中的断言；写请求被拦截的功能不属于完整业务验收。</p>';
  return '';
}
export function renderReport(input) {
  if(!input||typeof input!=='object'||input.schemaVersion!==1)throw new Error('Unsupported report schema');
  const d=sanitize(input),findings=d.findings??[],checks=d.checks??[],images=d.images??[];
  const title={'runtime-integrity':'LCP 身份与重复加载检查','runtime-profile':'浏览器诊断与完整性检查','theme-diff':'主题快照差异','rendered-html-audit':'渲染后 HTML 审查','performance-audit':'Shopify P0/P1 性能规则审计','theme-precheck':'Liquid 前期结构预检','check-import':'规范报告接入与校正','resource-audit':'外链与脚本依赖分析','quality-audit':'代码、SEO 与性能扩展分析',inspection:'源码诊断',capture:'浏览器采集',comparison:'前后验证','site-scan':'整站源码扫描','site-audit':'整站性能诊断','site-verification':'整站前后验证','site-change-plan':'整站修改计划',mapping:'源码与页面关联',scenarios:'自动化场景验收'}[d.kind]??'优化任务';
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:"><title>Shopify 性能工具包 · ${title}</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f5f7;color:#17212c;font:15px/1.65 system-ui,sans-serif}main{max-width:1140px;margin:auto;padding:36px 20px}h1{font-size:30px;line-height:1.3}h2{font-size:20px;margin-top:32px}.eyebrow{color:#316956;font-weight:700}.note{border-left:4px solid #ad7532;background:#fff6e5;padding:14px 18px}.stats{display:flex;gap:16px;flex-wrap:wrap}.card{background:white;padding:18px 22px;border:1px solid #e0e5e9;border-radius:10px;flex:1;min-width:180px}.card b{display:block;font-size:26px}.table{overflow-x:auto;background:#fff;border:1px solid #e0e5e9;border-radius:10px}table{width:100%;border-collapse:collapse}td,th{vertical-align:top;text-align:left;padding:12px;border-bottom:1px solid #e5e9ed;overflow-wrap:anywhere;min-width:100px}th{background:#eef2f5}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.55 monospace;background:white;border:1px solid #e0e5e9;padding:16px}details{margin-top:24px}summary{cursor:pointer;font-weight:600}.muted{color:#5b6976}li{margin:8px 0}@media(max-width:500px){main{padding:22px 14px}h1{font-size:24px}}
</style><main><div class="eyebrow">SHOPIFY PERF TOOLKIT · ${esc(version)}</div><h1>${title} · ${esc(d.component?.name??d.target??d.component?.selector??d.outcome??'检查结果')}</h1><p class="muted">${esc(d.environment?.url??d.project??'本地证据')}<br>${esc(d.createdAt??d.environment?.capturedAt??'')}</p><p class="note">本报告区分静态候选、有限窗口运行观察与正式验收。未测不代表通过；图片字节降低不等于整页 LCP 改善。没有自动发布或真实用户 INP 结论。</p><div class="stats">${summaryCards(d,findings,images).map(([label,value])=>`<div class="card">${esc(label)}<b>${esc(value)}</b></div>`).join('')}</div>
${extendedSections(d)}
${governanceSections(d)}
${integritySections(d)}
${intelligenceSections(d)}
${d.intelligence?.embedded?.length?'<h2>JSON 内嵌代码</h2>'+table(['文件 / 字段','语言','配置状态','业务逻辑候选','运行状态'],d.intelligence.embedded.map(r=>[r.file+'#'+r.jsonPointer,r.language,r.configurationState,r.businessLogicCandidate,r.runtime])):''}
${(d.supplemental??[]).map(entry=>`<h2>补充证据 · ${esc(entry.kind)} · ${esc(entry.status)}</h2><p class="note">${esc(entry.note)}</p>${extendedSections(entry.report)}${integritySections(entry.report)}${intelligenceSections(entry.report)}`).join('')}

${findings.length&&d.kind!=='rendered-html-audit'?'<h2>具体任务</h2>'+table(['规则','规范编号','证据级别','位置','问题','需要验证'],findings.map(f=>[f.ruleId,f.standardRuleIds??[],f.status,f.jsonPointer?`${f.file}#${f.jsonPointer}（字段内行 ${f.embeddedLine??'—'}；${f.configurationState??'unknown'}）`:[f.target??f.file,f.line].filter(x=>x!=null).join(':'),f.summary,f.verification])):''}
${images.length?'<h2>单张图片</h2>'+table(['索引或定位器','实际资源或表达式','尺寸与选源','加载','补丁资格'],images.map((i,n)=>[i.index??i.selector??n,i.currentSrc??i.sourceExpression??i.src,{box:i.box,naturalWidth:i.naturalWidth,srcset:i.srcset??i.attributes?.srcset,sizes:i.sizes??i.attributes?.sizes},i.loading??i.attributes?.loading,i.eligibleForPatch===undefined?'需场景判断':`${i.eligibleForPatch} ${i.reason??''}`])):''}
${checks.length&&d.kind!=='site-verification'?'<h2>验证结果</h2>'+table(['检查','结果','说明'],checks.map(c=>[c.name??c.id??c.check,c.status??c.passed,c.detail??c.message??c.reason??c])):''}
${d.coverage?.length?'<h2>规则覆盖</h2>'+table(['规则','状态','范围'],d.coverage.map(c=>[c.ruleId??c.reference,c.status,c.reason??c.note])):''}
<h2>验证边界</h2><ul>${(d.limitations??['该结果需要宿主功能与视觉复核。']).map(x=>`<li>${esc(x)}</li>`).join('')}</ul><details><summary>查看完整结构化证据</summary><pre>${esc(JSON.stringify(d,null,2))}</pre></details></main></html>`;
}
