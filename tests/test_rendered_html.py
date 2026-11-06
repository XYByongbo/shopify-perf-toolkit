"""Behavioral regression checks for the bundled offline helper, not agent eval scores."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/audit_rendered_html.py'
SPEC = importlib.util.spec_from_file_location('audit_rendered_html', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def document(body='', head=''):
    return '''<!doctype html><html lang="en"><head>
    <title>Product</title><meta name="description" content="Accurate description">
    <link rel="canonical" href="https://example.com/products/a">''' + head + '''</head>
    <body><h1>Product</h1>''' + body + '</body></html>'


def codes(result):
    return {finding['code'] for finding in result['findings']}


class RenderedAuditTests(unittest.TestCase):
    def test_complete_document(self):
        result = MODULE.audit(document('<img src="a.jpg" alt="Product" width="800" height="400">'))
        self.assertTrue(result['success'])
        self.assertEqual(result['findings'], [])
        self.assertNotIn('lcp', result)

    def test_multiline_and_empty_decorative_alt(self):
        result = MODULE.audit("<img\n src='a.jpg'\n alt=''\n width='200' height='100'>", fragment=True)
        self.assertEqual(result['findings'], [])

    def test_svg_title_is_not_page_title(self):
        result = MODULE.audit(document('<svg aria-labelledby="icon-title"><title id="icon-title">Icon</title></svg>'))
        self.assertEqual(result['findings'], [])

    def test_large_reports_are_bounded_but_counts_complete(self):
        result = MODULE.audit('<img>\n' * 100, True)
        self.assertEqual(result['error_count'], 100)
        self.assertEqual(result['warning_count'], 200)
        self.assertEqual(len(result['findings']), 200)
        self.assertTrue(result['findings_truncated'])

    def test_fragment_omits_page_requirements(self):
        result = MODULE.audit('<section><h2>Content</h2></section>', fragment=True)
        self.assertEqual(result['findings'], [])

    def test_fragment_rejects_page_metadata(self):
        result = MODULE.audit('<title>A</title><link rel="canonical" href="/a">', fragment=True)
        self.assertEqual(result['error_count'], 2)
        self.assertIn('fragment-page-metadata', codes(result))

    def test_duplicates_and_line_locations(self):
        result = MODULE.audit('<div id="a"></div>\n<div id="a"></div>', fragment=True)
        duplicate = next(f for f in result['findings'] if f['code'] == 'duplicate-id')
        self.assertEqual(duplicate['line'], 2)
        self.assertFalse(result['success'])

    def test_inert_content_is_not_live_dom(self):
        result = MODULE.audit(document('''<!-- <img id="x"> -->
        <template><div id="x"></div><template><img id="x"></template></template>
        <noscript><img id="x" src="fallback.jpg"></noscript>
        <div id="x"></div>'''))
        self.assertEqual(result['inventory']['images'], 0)
        self.assertEqual(result['findings'], [])

    def test_lazy_is_only_lcp_failure_with_evidence(self):
        html = '<img id="hero" src="a.jpg" alt="A" width="800" height="400" loading="lazy">'
        ordinary = MODULE.audit(html, fragment=True)
        measured = MODULE.audit(html, fragment=True, lcp_id='hero')
        self.assertTrue(ordinary['success'])
        self.assertIn('lcp-lazy', codes(measured))
        self.assertFalse(measured['success'])

    def test_invalid_lcp_target(self):
        for html in ('<div id="hero"></div>', '<div></div>', '<img id="hero"><img id="hero">'):
            with self.subTest(html=html):
                self.assertIn('lcp-target-invalid', codes(MODULE.audit(html, True, 'hero')))

    def test_image_diagnostics_are_hypotheses(self):
        result = MODULE.audit('<img src="a.jpg" srcset="a.jpg 800w" fetchpriority="high" loading="lazy">', True)
        self.assertTrue(result['success'])
        self.assertTrue({'image-alt-missing', 'image-dimensions-review', 'image-priority-conflict', 'responsive-sizes-missing'} <= codes(result))

    def test_auto_sizes_needs_lazy(self):
        result = MODULE.audit('<img src="a.jpg" sizes="auto, 100vw" loading="eager">', True)
        self.assertIn('eager-auto-sizes', codes(result))
        result = MODULE.audit('<img src="a.jpg" sizes="auto" loading="lazy">', True)
        self.assertNotIn('eager-auto-sizes', codes(result))

    def test_script_types_and_boolean_attributes(self):
        html = '''<script src="classic.js"></script><script src="deferred.js" defer></script>
        <script src="module.js" type="module"></script><script src="async.js" async></script>
        <script type="application/ld+json">{"@type":"Product","name":"A"}</script>'''
        result = MODULE.audit(html, True)
        self.assertEqual(sum(f['code'] == 'parser-blocking-script' for f in result['findings']), 1)

    def test_valid_product_group_and_id_references(self):
        value = {'@graph': [{'@id': '#group', '@type': 'ProductGroup', 'hasVariant': [
            {'@id': '#red', '@type': 'Product', 'name': 'Red', 'isVariantOf': {'@id': '#group'}},
            {'@id': '#blue', '@type': ['Product'], 'name': 'Blue', 'isVariantOf': {'@id': '#group'}}]}]}
        result = MODULE.audit('<script type="application/ld+json">' + json.dumps(value) + '</script>', True)
        self.assertEqual(result['findings'], [])
        self.assertEqual(result['inventory']['jsonld_types']['Product'], 2)

    def test_repeated_card_stylesheets_are_review_only(self):
        html = '\n'.join('<link rel="stylesheet" href="/assets/card.css?v=1">' for _ in range(12))
        result = MODULE.audit(html, True)
        findings = [f for f in result['findings'] if f['code'] == 'duplicate-stylesheet-review']
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]['line'], 2)
        self.assertEqual(findings[0]['severity'], 'warning')
        self.assertIn('12 matching', findings[0]['message'])
        self.assertTrue(result['success'])
        self.assertEqual(result['inventory']['stylesheet_links'], 12)
        self.assertEqual(result['inventory']['stylesheet_unique_hrefs'], 1)
        self.assertEqual(result['inventory']['duplicate_stylesheet_groups'], 1)
        self.assertNotIn('inp', result)

    def test_different_stylesheet_conditions_are_not_duplicates(self):
        html = '''<link rel="stylesheet" href="/a.css">
        <link rel="stylesheet" href="/a.css" media="print">
        <link rel="stylesheet" href="/a.css" disabled>
        <link rel="alternate stylesheet" href="/a.css" title="Dark">
        <link rel="stylesheet" href="/a.css" integrity="sha256-example">
        <link rel="stylesheet" href="/a.css" onload="this.media='all'">'''
        result = MODULE.audit(html, True)
        self.assertEqual(result['inventory']['stylesheet_links'], 6)
        self.assertEqual(result['inventory']['stylesheet_unique_hrefs'], 1)
        self.assertEqual(result['inventory']['duplicate_stylesheet_groups'], 0)

    def test_stylesheet_versions_and_preloads_remain_distinct(self):
        html = '''<link rel="stylesheet" href="/a.css?v=1">
        <link rel="stylesheet" href="/a.css?v=2">
        <link rel="preload" as="style" href="/a.css?v=1">'''
        result = MODULE.audit(html, True)
        self.assertEqual(result['inventory']['stylesheet_links'], 2)
        self.assertEqual(result['inventory']['stylesheet_unique_hrefs'], 2)
        self.assertNotIn('duplicate-stylesheet-review', codes(result))

    def test_stylesheet_rel_order_case_and_unique_ids(self):
        html = '''<link id="one" rel="alternate stylesheet" title="Dark" href="/a.css">
        <link id="two" rel="STYLESHEET alternate" title="Dark" href="/a.css">'''
        result = MODULE.audit(html, True)
        self.assertEqual(result['inventory']['duplicate_stylesheet_groups'], 1)
        self.assertNotIn('duplicate-id', codes(result))

    def test_inert_and_missing_href_stylesheets_do_not_create_duplicates(self):
        html = '''<link rel="stylesheet" href="/a.css">
        <template><link rel="stylesheet" href="/a.css"></template>
        <noscript><link rel="stylesheet" href="/a.css"></noscript>
        <!-- <link rel="stylesheet" href="/a.css"> -->
        <link rel="stylesheet"><link rel="stylesheet" href="">'''
        result = MODULE.audit(html, True)
        self.assertEqual(result['inventory']['stylesheet_links'], 3)
        self.assertEqual(result['inventory']['stylesheet_unique_hrefs'], 1)
        self.assertNotIn('duplicate-stylesheet-review', codes(result))

    def test_repeated_entity_definition_is_review_not_deletion(self):
        html = '<script type="application/ld+json">{"@id":"#p","@type":"Product"}</script>' * 2
        result = MODULE.audit(html, True)
        self.assertTrue(result['success'])
        self.assertIn('jsonld-entity-review', codes(result))

    def test_invalid_json_and_duplicate_members(self):
        for value in ('{"name":}', '{"price":NaN}', '{"name":"A","name":"B"}', '"scalar"', '{"a":1,}'):
            with self.subTest(value=value):
                result = MODULE.audit('<script type="application/ld+json">' + value + '</script>', True)
                self.assertIn('jsonld-invalid', codes(result))
                self.assertFalse(result['success'])

    def test_script_terminator_in_unescaped_content_is_detected(self):
        result = MODULE.audit('<script type="application/ld+json">{"name":"</script>"}</script>', True)
        self.assertIn('jsonld-invalid', codes(result))

    def test_unclosed_jsonld(self):
        result = MODULE.audit('<script type="application/ld+json">{"name":"A"}', True)
        self.assertIn('jsonld-unclosed', codes(result))

    def test_head_ownership_and_empty_fields(self):
        result = MODULE.audit(document('<link rel="canonical" href="">'))
        self.assertTrue({'canonical-count', 'metadata-outside-head', 'canonical-empty'} <= codes(result))

    def test_cli_exit_codes_and_read_only_behavior(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            good = root / 'good.html'
            bad = root / 'bad.html'
            liquid = root / 'raw.liquid'
            good.write_text(document(), encoding='utf-8')
            bad.write_text('<div id="a"></div><div id="a"></div>', encoding='utf-8')
            liquid.write_text('{{ product.title }}', encoding='utf-8')
            before = {p.name: p.read_bytes() for p in root.iterdir()}
            for path, arguments, expected in ((good, [], 0), (bad, ['--fragment'], 1), (liquid, [], 2), (root / 'missing.html', [], 2)):
                with self.subTest(path=path):
                    run = subprocess.run([sys.executable, str(SCRIPT), str(path), *arguments], capture_output=True, text=True)
                    self.assertEqual(run.returncode, expected, run.stderr)
                    self.assertIsInstance(json.loads(run.stdout), dict)
            self.assertEqual(before, {p.name: p.read_bytes() for p in root.iterdir()})


if __name__ == '__main__':
    unittest.main(verbosity=2)
