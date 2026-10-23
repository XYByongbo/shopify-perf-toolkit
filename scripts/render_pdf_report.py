"""Render a source-bound audit JSON in the WOLFBOX reference report style."""
import argparse,json,os
from pathlib import Path
from collections import Counter
from xml.sax.saxutils import escape
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate,Paragraph,Spacer,Table,TableStyle,PageBreak,KeepTogether
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.enums import TA_CENTER

BLUE=colors.HexColor('#38659a'); RED=colors.HexColor('#c90000')
def render(data,output,font=None):
    if data.get("analysis") and data.get("quality"):
        from render_analytical_report import render_analytical
        return render_analytical(data,output,font)
    return render_legacy(data,output,font)

def render_legacy(data,output,font=None):
    font=font or os.environ.get('PERF_KIT_PDF_FONT')
    if not font:
        candidates=['/System/Library/Fonts/Supplemental/Arial Unicode.ttf','/usr/share/fonts/truetype/arphic/uming.ttc']
        font=next((p for p in candidates if Path(p).is_file()),None)
    if not font: raise ValueError('Set PERF_KIT_PDF_FONT to a CJK TrueType font file.')
    pdfmetrics.registerFont(TTFont('ReportCJK',font))
    body=ParagraphStyle('body',fontName='ReportCJK',fontSize=9.5,leading=15,wordWrap='CJK',spaceAfter=7)
    small=ParagraphStyle('small',parent=body,fontSize=7.2,leading=10,spaceAfter=2)
    h=ParagraphStyle('heading',parent=body,fontSize=15,leading=21,textColor=BLUE,spaceBefore=14,spaceAfter=10,keepWithNext=True)
    title=ParagraphStyle('title',parent=h,fontSize=21,leading=30,alignment=TA_CENTER,spaceAfter=20)
    def p(s,style=body):return Paragraph(escape(str(s)).replace('\n','<br/>'),style)
    story=[]
    def table(rows,widths=None):
        t=Table([[p(x,small) for x in row] for row in rows],colWidths=widths,repeatRows=1,hAlign='LEFT')
        t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#e9e9e9')),('GRID',(0,0),(-1,-1),.4,colors.HexColor('#999999')),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),6),('RIGHTPADDING',(0,0),(-1,-1),6),('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5)]));story.append(t);story.append(Spacer(1,9))
    story += [Spacer(1,20),p(data['title'],title),p('源码证据版 · '+data['createdAt'][:10],ParagraphStyle('center',parent=body,alignment=TA_CENTER)),Spacer(1,16)]
    table([['项目','本次检查信息'],['主题目录',data['project']],['取证源码',data.get('sourceRoot',data['project'])],['检查范围',f"{data['inventory']['files']} 个文件；{data['inventory']['inspectedFiles']} 个文件完成源码分析"],['源码指纹',data['sourceHash']],['基线状态',data['comparison']['status']],['扫描状态','完整' if data['complete'] else '存在未覆盖或待复核项']], [85,390])
    for note in data['limitations'][:3]:story.append(p(note))
    if data.get('context'):story.append(p(data['context']))
    story.append(p('目录',h))
    headings=['执行摘要','问题统计总览','分维度分析与整改优先级','外链与脚本依赖','性能前后对比','分阶段整改与回滚','问题定位附录']
    for i,name in enumerate(headings,1):story.append(p(f'{i}. {name}'))
    story.append(PageBreak())
    def section(i):story.append(p(f'{i+1}  {headings[i]}',h))
    section(0)
    counts=Counter(f['origin'] for f in data['findings'])
    story.append(p(f"本次记录 {len(data['findings'])} 条检查线索：源码规则 {counts['scan']} 条，检查器 {counts['check']} 条，资源依赖 {counts['resources']} 条，人工复核 {counts['review']} 条。不同来源可能重叠，以下数量不等同于已确认缺陷数。"))
    story.append(p('目标是改善实际页面加载与交互性能。代码风格、可维护性与性能收益分别判断；不通过删内容、关闭必要功能或阻断资源制造高分。'))
    section(1)
    table([['来源','规则','记录数','说明']]+[[origin,rule,n,'结构线索 / 需要实际页面验证'] for (origin,rule),n in sorted(Counter((f['origin'],f['ruleId'])for f in data['findings']).items())],[55,175,45,200])
    table([['目录','记录数']]+[[d,n]for d,n in Counter((f['file']or'未定位').split('/')[0]for f in data['findings']).most_common()],[350,125])
    section(2)
    reviewed=[f for f in data['findings']if f['origin']=='review']
    if not reviewed:story.append(p('尚未提供人工复核条目。静态规则不能自动判定 P0/P1，需核对运行路径、首屏状态及业务依赖。'))
    for f in reviewed:
        story.append(p(f"{f['id']} · {f['priority']} · {f['summary']}",h))
        story.append(p(f"{f['file']}:{f['line']} · {f['status']} · {f['sourceBinding']}"))
        for line in f['snippet']:
            text=line['text'];text=text if len(text)<=240 else text[:240]+' …（完整行见 JSON）'
            story.append(p(f"{line['line']}: {text}",small))
        story.append(p('执行方案：'+str(f.get('action')or'待制定')))
        story.append(p('验证要求：'+'；'.join(f.get('verification',[]))))
    section(3)
    s=data['resources']['summary'];story.append(p(f"识别 {s['resources']} 个唯一外链资源、{s['scripts']} 个脚本记录、{s['orderCandidates']} 条顺序/依赖候选。外链数不是实际请求数，顺序关系不是已确认的依赖错误。"))
    table([['资源域名','分类','引用位置']]+[[r.get('host',''),r.get('classification',''),'; '.join(f"{x['file']}:{x['line']}"for x in r['references'])]for r in data['resources']['resources']],[120,70,285])
    section(4)
    story.append(p('正式标准：每页每设备前后至少 5 次；移动最低 75 / 中位 80，桌面最低 85 / 中位 90。下表展示全部样本，缺测、警告或预览身份未确认均不能视为验收通过。'))
    rows=[['阶段 / 页面 / 设备','全部分数','中位数','LCP / TBT 中位(ms)','警告 / 失败']]
    for m in data['measurement']:rows.append([f"{m['phase']} / {m['page']} / {m['device']}",', '.join(str(round(x,1))for x in m['scores']),m['median'],f"{m['lcpMedianMs']} / {m['tbtMedianMs']}",f"{len(m['warnings'])} / {m.get('failedAttempts',0)}"])
    if len(rows)>1:table(rows,[135,110,45,140,45])
    else:story.append(p('本报告未接入实测；没有性能分数，也不推测收益。'))
    for m in data['measurement']:
        story.append(p(f"{m['phase']} {m['page']} {m['device']}：{m.get('purpose','unknown')} / {m.get('runStatus','unknown')}；源码同步与验收需另行核验。",small))
        for issue in m.get('issues',[]):story.append(p('证据问题：'+str(issue),small))
        for warning in m['warnings']:story.append(p(f"{m['phase']} {m['page']} {m['device']}: {warning}",small))
    section(5)
    table([['阶段','执行与验收'],['定位','根据问题编号定位文件、行号及源码哈希；核实已修改文件和其他聊天的写入范围。'],['修改','用 plan-site 生成差异与快照；应用前验证当前源码，漂移则重新审阅。保留主题配置、内容和业务功能。'],['验证','验证受影响功能与画面；同步未发布预览并核对版本后，再运行可比测速。'],['回滚','发生回归时使用原计划 rollback；保留补丁、回执和失败记录。'],['结论','确认修复、误报、未处理与未测分别列明；不把数量下降直接等同于分数提升。']],[70,405])
    section(6)
    story.append(p('每条记录有稳定编号、文件和行号。下方代码为本次源码摘录；历史记录哈希不匹配时仅用于定位，不代表原告警已验证。完整多行代码、原始消息及校正依据见 report.json。'))
    added=set(data['comparison']['added'])
    for f in data['findings']:
        style=ParagraphStyle('entry',parent=small,textColor=RED if f['id']in added else colors.black)
        code=next((x['text'].strip() for x in f['snippet']if x['line']==f['line']),'无有效源码位置')
        if len(code)>240:code=code[:240]+' …（完整行见 JSON）'
        block=[p(f"{f['id']} | {f['origin']} / {f['ruleId']} | {f['severity']} | {f['status']}",style),p(f"{f['file'] or '未定位'}:{f['line'] or '-'} | {f['sourceBinding']}",small),p(f['summary'],small),p(code,small)]
        if f.get('correction'):block.append(p('校正：'+f['correction'].get('reason',''),small))
        block.append(Spacer(1,8));story.append(KeepTogether(block))
    def footer(c,doc):
        c.setFont('ReportCJK',8);c.setFillColor(colors.grey);c.drawString(60,28,'Shopify 主题代码与性能评估 · 源码证据版');c.drawRightString(535,28,str(doc.page))
    output=Path(output)
    with output.open('xb')as stream:
        doc=SimpleDocTemplate(stream,pagesize=(595.3,841.9),rightMargin=60,leftMargin=60,topMargin=55,bottomMargin=48,title=data['title'],author='Shopify Perf Toolkit')
        doc.build(story,onFirstPage=footer,onLaterPages=footer)

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--input',required=True);ap.add_argument('--output',required=True);args=ap.parse_args()
    render(json.loads(Path(args.input).read_text()),args.output)
if __name__=='__main__':main()
