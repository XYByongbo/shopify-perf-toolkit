"""Render an already validated offline SEO audit. Optional reportlab dependency."""
import json
import sys
from xml.sax.saxutils import escape
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont


def render(data, output):
    if data.get('kind') != 'seo-audit' or data.get('acceptance') != 'not-evaluated':
        raise ValueError('Expected offline SEO audit; use seokit report-pdf for contract validation.')
    pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
    style = ParagraphStyle('body', fontName='STSong-Light', fontSize=10, leading=16, wordWrap='CJK')
    title = ParagraphStyle('title', parent=style, fontSize=18, leading=26, spaceAfter=12)
    story = [Paragraph('Shopify SEO 审查', title)]
    def paragraph(value):
        story.extend([Paragraph(escape(str(value)), style), Spacer(1, 6)])
    paragraph(f"范围：{data['scope']}；状态：{data['status']}；SEO 验收：未执行")
    paragraph(f"来源：{data['sourceAssociation']}；问题数：{data['summary']['findings']}")
    if data.get('findingsTruncated'):
        paragraph('详情已截断，不能视为完整审查。')
    for item in data['findings']:
        paragraph(f"{item['ruleId']} [{item['severity']}] {item['file']}:{item['line']}")
        paragraph(item['summary'])
    for label, key in [('源码观察', 'observations'), ('覆盖问题', 'issues')]:
        story.append(Paragraph(label, title))
        for item in data[key]:
            paragraph(json.dumps(item, ensure_ascii=False))
    story.append(Paragraph('适用边界', title))
    for line in data['limitations']:
        paragraph(line)
    with open(output, 'xb') as stream:
        SimpleDocTemplate(stream, title='Shopify SEO Audit').build(story)


if __name__ == '__main__':
    with open(sys.argv[1], encoding='utf-8') as source:
        render(json.load(source), sys.argv[2])
