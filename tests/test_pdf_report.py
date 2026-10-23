import unittest,tempfile,json
from pathlib import Path
try:
    import reportlab
    from pypdf import PdfReader
    from render_pdf_report import render
    AVAILABLE=True
except ImportError:
    AVAILABLE=False

@unittest.skipUnless(AVAILABLE,'Install reportlab and pypdf for PDF renderer validation')
class PdfReportTest(unittest.TestCase):
    def test_long_appendix_unicode_and_markup_stay_readable(self):
        data={'title':'主题代码评估 <not markup>','createdAt':'2026-10-16','project':'/theme','sourceHash':'a'*64,'complete':True,'inventory':{'files':2,'inspectedFiles':2},'comparison':{'status':'no-baseline','added':[]},'limitations':['候选不是已确认缺陷'],'context':'本地验证；线上未测','resources':{'summary':{'resources':0,'scripts':0,'orderCandidates':0},'resources':[]},'measurement':[],'findings':[{'id':f'ISS-{i}','origin':'scan','ruleId':'TEST','severity':'info','status':'candidate','file':'sections/a.liquid','line':i+1,'sourceBinding':'hash-matched','summary':'检查 <script> & 保留原始文本','snippet':[{'line':i+1,'text':'<div>{{ product.title }}</div>'}]}for i in range(90)]}
        with tempfile.TemporaryDirectory()as d:
            p=Path(d)/'report.pdf';render(data,p);reader=PdfReader(p);text=''.join(x.extract_text()for x in reader.pages)
            self.assertGreater(len(reader.pages),4);self.assertIn('ISS-89',text);self.assertIn('<script>',text);self.assertIn('本地验证',text)
            with self.assertRaises(FileExistsError):render(data,p)

    def test_analytical_report_has_reference_chapters_code_reason_and_coverage(self):
        from render_analytical_report import render_analytical
        f={'id':'ISS-reviewed','file':'snippets/a.liquid','line':2,'sourceBinding':'hash-matched','status':'source-reviewed-runtime-pending','origin':'review','ruleId':'REVIEW','severity':'warning','dimension':'seo','priority':'P1','summary':'名称与 URL 不一致 <script>','snippet':[{'line':2,'text':'{{ article.title | json }}'}],'evidence':{'reason':'触发条件：文章页面'},'action':'修正名称','verification':['解析输出']}
        data={'title':'分析型专项评估','createdAt':'2026-10-16','project':'/theme','sourceRoot':'/theme','sourceHash':'a'*64,'inventory':{'files':2,'inspectedFiles':2},'contract':{'version':3},'comparison':{'status':'no-baseline','added':[],'absent':[]},'resources':{'summary':{'resources':0,'scripts':0,'orderCandidates':0},'resources':[]},'measurement':[],'findings':[f],'analysis':[{'id':'seo','title':'SEO','count':1,'files':1,'current':1,'mechanism':'源码与实际输出分别验证','action':'核查','verification':'渲染','byRule':{'REVIEW':1}}], 'quality':{'issues':[],'observations':[],'metrics':{'javascript':[],'css':[],'schema':[]},'coverage':[{'reference':'SyntaxError','rules':['LiquidSyntaxError'],'status':'checker-not-current'}],'manualChecks':[{'area':'运行验证','required':'未执行'}],'officialSources':[]}}
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'analytical.pdf';render_analytical(data,p)
            text=''.join(x.extract_text() for x in PdfReader(p).pages)
            for phrase in ['执行摘要','SEO 专项分析','检查能力覆盖','触发条件：文章页面','ISS-reviewed','{{ article.title | json }}','没有新的']:
                self.assertIn(phrase,text)
            self.assertNotIn('当前检查器已启用',text)
            with self.assertRaises(FileExistsError):render_analytical(data,p)
