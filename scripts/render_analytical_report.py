"""Analytical report: reference structure, evidence-led Chinese narrative, separate index."""
import os,json
from pathlib import Path
from collections import Counter
from xml.sax.saxutils import escape
from reportlab.platypus import SimpleDocTemplate,Paragraph,Spacer,Table,TableStyle,PageBreak,KeepTogether
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
BLUE=colors.HexColor('#315f91');RED=colors.HexColor('#ad2525')
ORIGIN={'check':'Theme Check','scan':'基础源码扫描','resources':'资源分析','quality':'扩展代码分析','review':'人工源码复核'}
STATUS={'checker-enabled':'当前检查器已启用','local-static':'工具本地静态规则','checker-not-current':'未接入当前检查证据','checker-config-unverified':'规则配置待确认','source-present':'存在源码实现','render-required':'需渲染验证','not-applicable-by-default':'默认不作为公开页检查'}

def render_analytical(data,output,font=None):
    font=font or os.environ.get('PERF_KIT_PDF_FONT') or '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'
    pdfmetrics.registerFont(TTFont('ReportCJK',font))
    body=ParagraphStyle('body',fontName='ReportCJK',fontSize=10,leading=16,wordWrap='CJK',spaceAfter=8)
    small=ParagraphStyle('small',parent=body,fontSize=8,leading=12,spaceAfter=3)
    code=ParagraphStyle('code',parent=small,fontSize=7.6,leading=11,backColor=colors.HexColor('#f3f5f7'),borderPadding=5,spaceAfter=9)
    heading=ParagraphStyle('heading',parent=body,fontSize=17,leading=24,textColor=BLUE,spaceBefore=14,spaceAfter=12,keepWithNext=True)
    sub=ParagraphStyle('sub',parent=heading,fontSize=12,leading=18,spaceBefore=10,spaceAfter=7)
    title=ParagraphStyle('title',parent=heading,fontSize=23,leading=34,alignment=1,spaceAfter=22)
    red=ParagraphStyle('red',parent=body,textColor=RED)
    def p(s,st=body):return Paragraph(escape(str(s)).replace('\n','<br/>'),st)
    story=[]
    def text(s,st=body):story.append(p(s,st))
    def table(rows,widths):
        t=Table([[p(v,small)for v in row]for row in rows],colWidths=widths,repeatRows=1,hAlign='LEFT')
        t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#e8ebef')),('GRID',(0,0),(-1,-1),.4,colors.HexColor('#a6adb6')),('VALIGN',(0,0),(-1,-1),'TOP'),('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6),('LEFTPADDING',(0,0),(-1,-1),6),('RIGHTPADDING',(0,0),(-1,-1),6)]))
        story.extend([t,Spacer(1,9)])
    def section(n,name,page=False):
        if page:story.append(PageBreak())
        text(f'{n}  {name}',heading)
    def example(f):
        text(f"{f['id']}  |  {f['file']}:{f['line']}",sub)
        text(f['summary'])
        text(f"证据：{ORIGIN.get(f['origin'],f['origin'])} / {f['ruleId']}；{f['sourceBinding']}；{f['status']}。",small)
        lines=f.get('snippet',[])
        # Focus on exact offense line, preserve neighborhood only when compact.
        excerpt=[]
        for l in lines:
            if len(l['text'])>240:
                if l['line']==f['line']:excerpt.append(str(l['line'])+': '+l['text'][:240]+' …（完整行见 JSON）')
            else:excerpt.append(str(l['line'])+': '+l['text'])
        if excerpt:text('\n'.join(excerpt),code)
        ev=f.get('evidence')or{}
        if isinstance(ev,dict)and ev.get('reason'):text('根因与触发条件：'+ev['reason'])
        if isinstance(ev,dict)and ev.get('path'):text('静态调用链：'+' → '.join(ev['path']),small)
        if f.get('correction'):text('误报校正：'+f['correction'].get('reason','需结合上下文复核'),small)
        if f.get('action'):text('整改：'+str(f['action']))
        if f.get('verification'):text('验证：'+'；'.join(f['verification']),small)
    q=data['quality'];findings=data['findings'];byid={f['id']:f for f in findings};analysis=data['analysis']
    counts=Counter(f['origin']for f in findings);dirs=Counter((f['file']or'未定位').split('/')[0]for f in findings)
    story.append(Spacer(1,18));text(data['title'],title);text('专项评估 · 源码分析版 · '+data['createdAt'][:10],ParagraphStyle('center',parent=body,alignment=1))
    table([['项目','本次取证'],['主题',Path(data['project']).name],['源码目录',data['sourceRoot']],['规模',f"{data['inventory']['files']} 个文件；基础扫描分析 {data['inventory']['inspectedFiles']} 个文件"],['检查器',(data.get('contract',{}).get('checks')or{}).get('toolVersion','未接入')],['源码 SHA-256',data['sourceHash']],['证据范围','本地代码、检查器导入、外链与静态依赖；不下载素材'],['覆盖边界',f"扩展解析有 {len(q['issues'])} 个区域待渲染/补充；线上验收另列"]],[83,392])
    text('阅读说明：本报告沿用参考文档的评估结构，新增 SEO。记录数量不等于独立缺陷数；检查器严重度不直接等于业务风险。未测项目不会显示“通过”。',red)
    if data.get('context'):text(data['context'])
    text('目录',sub)
    names=['执行摘要','问题统计总览与基线口径','分维度代码质量深度分析','隐性代码问题与资源依赖','SEO 专项分析','风险分级与整改路线','回归、回滚与性能对比','工程流程与预期收益','检查能力覆盖与待验证项','附录：规则与问题映射']
    for i,name in enumerate(names,1):text(f'{i}. {name}',small)
    section(1,names[0],page=True);text(f"本次读取 {data['inventory']['files']} 个主题文件，形成 {len(findings)} 条证据记录，涉及 {len(set(f['file']for f in findings if f['file']))} 个文件。Theme Check {counts['check']} 条，扩展分析 {counts['quality']} 条，基础扫描 {counts['scan']} 条，外链分析 {counts['resources']} 条，人工复核 {counts['review']} 条。")
    text('这些来源可能重复指向同一处代码。下文按维度解释问题机制，按文件与代码摘录给出可执行整改入口；不会套用参考主题的 4820 条或直接承诺性能提分。')
    text('核心判断',sub)
    for d in sorted(analysis,key=lambda d:d['count'],reverse=True)[:5]:text(f"{d['title']}：{d['count']} 条记录 / {d['files']} 个文件。{d['mechanism']}")
    if counts['review']:text('优先阅读人工源码复核项；它们说明当前主题的具体根因和建议。源码复核仍不能替代真实页面运行验收。')
    text('SEO 不按“未检测到 = 不存在”推断：布局会追踪字面 render/include 引用，保留已存在的标签与动态 JSON-LD。平台注入、响应头和真实页面索引结果留待线上核验。')
    section(2,names[1],page=True);table([['规范维度','记录数','涉及文件','当前哈希匹配']]+[[d['title'],d['count'],d['files'],d['current']]for d in analysis],[250,65,75,85])
    table([['目录','记录数','口径']]+[[d,n,'可重叠来源的证据记录']for d,n in dirs.most_common()],[120,75,280])
    table([['来源','原始级别','数量']]+[[ORIGIN.get(o,o),s,n]for (o,s),n in sorted(Counter((f['origin'],f['severity'])for f in findings).items())],[200,150,125])
    text('基线对照',sub);text('本次报告契约：'+str(data['contract']['version'])+'；状态：'+data['comparison']['status']+'。新分析规则与旧报告不同，不能把新增条目当作主题退化；只有相同契约和同一项目才比较记录增减。')
    text(f"当前基线新增 {len(data['comparison']['added'])} 条、消失 {len(data['comparison']['absent'])} 条。消失可能来自行号移动或范围变化，不等于修复完成。")
    section(3,names[2],page=False)
    for i,d in enumerate([x for x in analysis if x['id']!='seo'],1):
        if i>1:story.append(Spacer(1,10))
        text(f"3.{i}  {d['title']}（{d['count']} 条 / {d['files']} 个文件）",sub)
        text('判断依据与影响：'+d['mechanism'])
        if d['byRule']:table([['规则','记录数']]+[[r,n]for r,n in sorted(d['byRule'].items(),key=lambda x:-x[1])],[375,100])
        else:text('本轮没有该维度告警。仅表示接入的规则未产生记录，不代表所有运行状态均已验证。')
        group=[f for f in findings if f['dimension']==d['id']and f['sourceBinding']=='hash-matched'];chosen=[];seen=set()
        for f in sorted(group,key=lambda f:0 if f['origin']=='review' else 1 if f['origin']=='quality' else 2 if f['origin']=='check' else 3):
            if f['ruleId']not in seen:chosen.append(f);seen.add(f['ruleId'])
            if len(chosen)>=2:break
        for f in chosen:example(f)
        text('根因排查与整改原则：'+d['action']);text('回归要求：'+d['verification'])
    section(4,names[3]);text('4.1 全局资源与脚本依赖',sub)
    ss=data['resources']['summary'];text(f"发现 {ss['resources']} 个唯一外链、{ss['scripts']} 条脚本记录、{ss['orderCandidates']} 条顺序/依赖候选。数量是源码引用口径，不是浏览器请求数；顺序候选不证明竞态。")
    byhost=Counter(r.get('host','动态')for r in data['resources']['resources']);table([['域名','唯一资源数']]+[[h,n]for h,n in byhost.most_common()],[375,100])
    obs=[o for o in q['observations']if o['check']=='layout-resource'];table([['布局位置','资源与边界']]+[[f"{o['file']}:{o['line']}",o['detail']]for o in obs],[155,320])
    text('布局中的 importmap 只声明模块地址，不代表立即加载。是否应拆分 theme.js 或全局 CSS，必须用实际模板、调用方和覆盖率确认；不能按“大文件”直接删除模块。')
    text('4.2 JS / CSS / Schema 的补充分析',sub)
    j=q['metrics']['javascript'];c=q['metrics']['css'];text(f"已解析 JS 区域 {len(j)} 个；观察到监听注册 {sum(x['listeners']for x in j)} 处、Observer 构造 {sum(x['observers']for x in j)} 处、计时器调用 {sum(x['timers']for x in j)} 处、动态 import {sum(x['dynamicImports']for x in j)} 处。数量只定位审查热点，不是泄漏数量。")
    table([['CSS 文件/区域','规则','相同声明候选','全局元素规则']]+[[f"{x['file']}:{x['line']}",x['rules'],x['duplicates'],x['global']]for x in sorted(c,key=lambda x:-x['rules'])[:6]],[260,60,85,70])
    table([['Schema 文件','settings 数（含 block）','blocks 数']]+[[x['file'],x['settings'],x['blocks']]for x in sorted(q['metrics']['schema'],key=lambda x:-x['settings'])[:5]],[290,110,75])
    text('相同 setting ID/type 序列可能代表故意保持兼容，不视为逻辑复制的充分证据。冗余 CSS 仍受层叠顺序影响；跨组件样式、资源失败兜底和第三方可信度需要运行验证。')
    section(5,names[4]);seo=next(x for x in analysis if x['id']=='seo');text(f"SEO 相关候选 {seo['count']} 条。以下同时呈现已有实现，防止只报问题而重复补代码。")
    items=[o for o in q['observations']if o['check']in ['title','description','canonical','lang','social','structured-data','robots','hreflang']];unique=[];seen=set()
    for o in items:
        key=(o['file'],o['line'],o['check'])
        if key not in seen:seen.add(key);unique.append(o)
    aggregated={}
    for o in unique:
        key=(o['file'],o['check'],o['status']);aggregated.setdefault(key,[]).append(o)
    table([['检查项','文件与行','判断']]+[[check,f"{file}:"+', '.join(str(o['line'])for o in group[:4])+(' …'if len(group)>4 else ''),STATUS.get(status,status)+f"（{len(group)} 处）"+'；'+group[0]['detail']]for (file,check,status),group in aggregated.items()],[70,165,240])
    for f in [f for f in findings if f['dimension']=='seo'and f['origin']=='review'][:3]:example(f)
    text('上线前逐 URL 验证：标题与描述是否为空或重复、canonical 是否指向预期 URL、可索引页是否误加 noindex、JSON-LD 是否对应当前商品/文章、语言链接是否互返、站内链接是否可抓取。源码里未出现 robots.txt 或 sitemap 文件不等于 Shopify 没有生成它们。')
    section(6,names[5]);table([['等级','成立条件','处理方式'],['P0','已证实关键页面不可用、阻断下单或错误索引策略；需要具体运行证据','最小修复并验证真实触发路径；本轮不由 warning/error 自动升级'],['P1','源码确认的性能/SEO 候选，运行影响仍需量化','优先小批验证；保留素材、内容、设置与业务逻辑'],['P2','格式、命名、结构整理与维护成本','独立排期，避免把格式改动混入提分补丁']],[50,235,190])
    reviews=[f for f in findings if f['origin']=='review']
    if reviews:table([['优先级','问题与位置','整改入口']]+[[f['priority'],f"{f['summary']}\n{f['file']}:{f['line']}",f.get('action')or'见对应维度']for f in reviews],[50,245,180])
    table([['阶段','执行单元','完成标准'],['一：核实','检查引用/变量上下文与 SEO 动态输出；复核源码候选','每项标记确认、误报或待测；关联 ISS 编号'],['二：小批修改','先选可验证的资源/生命周期/SEO 修正；生成计划与回滚快照','diff 经审阅，验证方案具体到触发分支'],['三：预览回归','同步未发布主题；验证编辑器、移动/桌面、购物流程及 SEO 输出','保留所有失败；不得以静态规则消失替代功能验证'],['四：正式评分','对实际部署运行同配置前后测量','满足原有全部样本与最低分/中位数门槛']],[80,205,190])
    text('工作量口径：先按独立调用链和组件估算，不能用告警数量乘固定时间。当前缺少部署与运行证据，暂不编造“几天修完”或费用。')
    section(7,names[6]);text('报告到执行的闭环：问题编号 → 文件/行号/源码哈希 → recipe.evidence → plan-site 差异/快照 → apply 回执 → 功能回归 → 实测 → 更新报告。自动检测不等于可自动安全修复。')
    text('支持的现有代码策略包含有边界的 JS 帧合并、CSS 处理和 Liquid 循环优化；超出策略范围时用人工审阅的 replacement。发现源码漂移就重新审阅，不能改哈希强行应用。')
    text('回归覆盖：关键 URL 的初始状态与首个交互，购物车空/非空、变体切换、多组件实例、section 卸载重连、空配置、失败资源、响应式布局和 SEO 最终输出。应用计划保存 config/settings_data.json 的相关影响边界，保留用户原有修改。')
    text('性能前后对照',sub)
    if data['measurement']:
        table([['阶段/页面/设备','全部分数','中位 / 最低','LCP / TBT(ms)','警告/失败']]+[[f"{m['phase']}/{m['page']}/{m['device']}",','.join(str(round(s,1))for s in m['scores']),f"{m['median']}/{m['min']}",f"{m['lcpMedianMs']}/{m['tbtMedianMs']}",f"{len(m['warnings'])}/{m['failedAttempts']}"]for m in data['measurement']],[120,120,70,105,60])
        for m in data['measurement']:
            text(f"{m['phase']}/{m['page']}/{m['device']}：{m['purpose']}；{m['runStatus']}；证据问题 {m['issues']}；警告 {m['warnings']}",small)
    else:text('本报告未接入可比的本轮测量结果。因此没有新的 Lighthouse 性能分、SEO 分或提分结论；本地检查通过也不能代替线上验收。',red)
    text('保留原验收标准：每页每设备前后至少 5 次；移动最低 75 / 中位 80，桌面最低 85 / 中位 90。缺测、运行警告和不可比环境均不能判定通过。')
    section(8,names[7]);table([['流程','落地能力/产物','防止的问题'],['提交前检查','真实 Theme Check + audit-quality + audit-resources；保留工具版本/规则配置','新语法误报、遗漏外部依赖'],['证据复用','sourceHash 与冻结快照；历史报告同契约比较','旧代码结果冒充新版本验收'],['单写入方','同一批主题文件串行维护，应用前核对现有修改','两个聊天互相覆盖'],['分层验收','静态问题、功能、视觉、SEO 与性能分分别记状态','告警下降被误写成分数提升'],['回滚与归档','保存计划、原始源码、apply/rollback receipt 和失败记录','优化后不可恢复或只保留高分样本']],[90,245,140])
    text('预期收益以机制说明：修复真实引用/翻译错误改善内容完整性；减少确认的阻塞和重复执行有机会改善加载与交互；规范标题/canonical/结构化数据改善搜索引擎理解。具体毫秒、分数和排名必须实测，不能从源码计数推算。')
    text('格式、行数和嵌套层级减少主要降低维护成本。保留已有语义和业务行为优先，不以“零告警”为唯一目标。')
    section(9,names[8]);text('示例中的规则按当前实现映射。旧规则改名或不再由现代检查器提供时，用明确标注的工具规则补充；它们不是旧版计数的完全复刻。')
    table([['示例规则/规则组','本轮能力','状态']]+[[c['reference'],' / '.join(c['rules']),STATUS.get(c['status'],c['status'])]for c in q['coverage']],[165,200,110])
    text('扩展检查范围',sub)
    table([['能力','实际执行方式','边界'],['SEO','布局字面引用闭包；元数据、JSON-LD、语言、链接与标题结构的源码观察','动态值/最终唯一性/robots 与 sitemap 需线上'],['JS / CSS','Acorn AST 生命周期及注册统计；PostCSS 重复规则、字体与作用域分析','父类/外部 helper 清理与真实层叠要运行核实'],['隐藏架构','有界 snippet 路径、setting ID/type 复用、全局资源引用统计','不会将路径深/大文件/重复接口自动定为性能缺陷'],['可访问性与边界','原生 alt、空按钮、dialog 名称、缩放、HTTP 资源线索','读屏、焦点、动态可访问名称和第三方信任需人工']],[90,225,160])
    text(f"解析边界：{len(q['issues'])} 个区域未完成扩展语义解析；基础 Theme Check 与源码扫描结果仍保留。",red)
    table([['原因','区域数']]+[[r,n]for r,n in Counter(i['reason']for i in q['issues']).most_common()],[375,100])
    for m in q['manualChecks']:text(m['area']+'：'+m['required'])
    section(10,names[9]);text('完整定位数据见同目录 report.json：所有 ISS 编号、源文件、行/列、哈希、代码上下文、原始告警、校正依据与验证要求均保留。PDF 正文精选代表性代码；附录按规则归并，避免把大量原始英文告警当作分析正文。')
    groups={}
    for f in findings:groups.setdefault((f['origin'],f['ruleId']),[]).append(f)
    table([['来源/规则','数','代表位置/问题编号']]+[[ORIGIN.get(o,o)+' / '+r,len(g),f"{g[0]['file']}:{g[0]['line']}\n{g[0]['id']}"]for (o,r),g in sorted(groups.items())],[215,35,225])
    text('误报校正原则',sub)
    for s in ['structured_data 是原生过滤器；不能按示例把它归为 App 自定义过滤器。','content_for blocks 需要支持它的解析器；不能禁用无关规则代替修复误报。','图片缺尺寸需核实 CSS 是否已预留空间；不能直接宣称 CLS 已恶化。','script 加 defer/async 需要依赖和首个交互验证；不能全部统一延迟。','过时过滤器与深层嵌套不是自动 P0；现代分页阈值以实际检查器配置为准。']:text(s)
    text('规范来源',sub)
    for s in q['officialSources']:text(s['title']+'\n'+s['url'],small)
    def footer(c,doc):
        c.setFont('ReportCJK',8);c.setFillColor(colors.grey);c.drawString(60,28,'主题代码 · SEO · 性能专项评估');c.drawRightString(535,28,str(doc.page))
    with Path(output).open('xb')as stream:
        SimpleDocTemplate(stream,pagesize=(595.3,841.9),rightMargin=60,leftMargin=60,topMargin=48,bottomMargin=48,title=data['title'],author='Shopify Perf Toolkit').build(story,onFirstPage=footer,onLaterPages=footer)
