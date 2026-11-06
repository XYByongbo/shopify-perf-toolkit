#!/usr/bin/env python3
"""Offline rendered-HTML triage; never a Liquid compiler or a CWV measurement.

Adapted from Addy Osmani's web-quality-skills HTML audit workflow (MIT).
Copyright (c) 2026 Addy Osmani. See ../licenses/ADDY-MIT.txt.
Python parser and Shopify checks: copyright (c) 2026 Skill contributors, MIT.
Adapted from shopify-theme-skills commit 63744f0eaf4716ad8a7b1e8aa31b3c27728fcaa2.
Toolkit integration and input fingerprints: see ../THIRD_PARTY_NOTICES.md.
No network, subprocesses, mutations, or third-party dependencies.
"""

import argparse
import hashlib
from collections import Counter, defaultdict
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys


class RenderedHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.nodes = []
        self.jsonld = []
        self.title_text = []
        self.ignored = []
        self.in_head = False
        self.in_title = False
        self.script = None
        self.doctype = False
        self.svg_depth = 0

    def handle_decl(self, decl):
        if decl.lower() == 'doctype html':
            self.doctype = True

    def handle_starttag(self, tag, attrs):
        if self.ignored:
            if tag in {'template', 'noscript'}:
                self.ignored.append(tag)
            return
        if tag in {'template', 'noscript'}:
            self.ignored.append(tag)
            return
        if tag == 'head':
            self.in_head = True
        if tag == 'svg':
            self.svg_depth += 1
        node = {'tag': tag, 'attrs': dict(attrs), 'line': self.getpos()[0], 'head': self.in_head, 'svg': self.svg_depth > 0}
        self.nodes.append(node)
        if tag == 'title' and not self.svg_depth:
            self.in_title = True
        if tag == 'script' and (node['attrs'].get('type') or '').lower().strip() == 'application/ld+json':
            self.script = {'line': node['line'], 'text': ''}

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.ignored:
            if tag == self.ignored[-1]:
                self.ignored.pop()
            return
        if tag == 'head':
            self.in_head = False
        if tag == 'title':
            self.in_title = False
        if tag == 'script' and self.script is not None:
            self.jsonld.append(self.script)
            self.script = None
        if tag == 'svg':
            self.svg_depth = max(0, self.svg_depth - 1)

    def handle_data(self, data):
        if self.ignored:
            return
        if self.script is not None:
            self.script['text'] += data
        elif self.in_title:
            self.title_text.append(data)


def reject_constant(value):
    raise ValueError('Non-JSON numeric constant: ' + value)


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON member: ' + key)
        result[key] = value
    return result


SEO_CODES = {
    'duplicate-id', 'fragment-page-metadata', 'doctype-missing', 'lang-missing',
    'title-count', 'canonical-count', 'description-count', 'metadata-outside-head',
    'title-empty', 'canonical-empty', 'description-empty', 'heading-review',
    'image-alt-missing', 'image-source-missing', 'jsonld-invalid',
    'jsonld-unclosed', 'jsonld-entity-review',
}


def audit(source, fragment=False, lcp_id=None, profile='all'):
    if profile not in {'all', 'seo'}:
        raise ValueError('Unknown HTML rule profile')
    page = RenderedHTML()
    page.feed(source)
    page.close()
    findings = []

    def add(code, severity, line, message):
        findings.append({'code': code, 'severity': severity, 'line': line, 'message': message})

    nodes = page.nodes
    tags = defaultdict(list)
    ids = defaultdict(list)
    for node in nodes:
        tags[node['tag']].append(node)
        value = node['attrs'].get('id')
        if value:
            ids[value].append(node)
    for value, matches in ids.items():
        if len(matches) > 1:
            add('duplicate-id', 'error', matches[1]['line'], f'ID {value!r} occurs {len(matches)} times; scope IDs by instance.')

    canonical = [n for n in tags['link'] if 'canonical' in (n['attrs'].get('rel') or '').lower().split()]
    descriptions = [n for n in tags['meta'] if (n['attrs'].get('name') or '').lower() == 'description']
    titles = [n for n in tags['title'] if not n['svg']]
    metadata = titles + canonical + descriptions
    if fragment:
        for node in metadata:
            add('fragment-page-metadata', 'error', node['line'], 'Page title/description/canonical belongs to the layout head, not a repeated fragment.')
    else:
        if not page.doctype:
            add('doctype-missing', 'warning', 1, 'No HTML5 doctype found; confirm this is the full storefront document.')
        if not tags['html'] or not (tags['html'][0]['attrs'].get('lang') or '').strip():
            add('lang-missing', 'warning', 1, 'Document lang is missing; inspect the layout.')
        for code, matches, severity in [('title', titles, 'error'), ('canonical', canonical, 'error'), ('description', descriptions, 'warning')]:
            if len(matches) != 1:
                add(code + '-count', severity, matches[0]['line'] if matches else 1, f'Expected one {code}; found {len(matches)}. Inspect the page-level owner.')
        for node in metadata:
            if not node['head']:
                add('metadata-outside-head', 'error', node['line'], 'Page metadata was found outside an explicit head element.')
        if titles and not ''.join(page.title_text).strip():
            add('title-empty', 'error', titles[0]['line'], 'Page title is empty.')
        for node in canonical:
            if not (node['attrs'].get('href') or '').strip():
                add('canonical-empty', 'error', node['line'], 'Canonical href is empty.')
        for node in descriptions:
            if not (node['attrs'].get('content') or '').strip():
                add('description-empty', 'warning', node['line'], 'Meta description is empty; inspect page_description and its owner.')
        if len(tags['h1']) != 1:
            add('heading-review', 'warning', tags['h1'][0]['line'] if tags['h1'] else 1, f'Found {len(tags["h1"])} h1 elements; review page hierarchy. This is not a Google ranking rule.')

    high_images = []
    for node in tags['img']:
        attrs, line = node['attrs'], node['line']
        if 'alt' not in attrs:
            add('image-alt-missing', 'warning', line, 'Missing alt; use meaningful text or an intentional empty alt for decoration.')
        if not all(re.fullmatch(r'[1-9][0-9]*', attrs.get(key) or '') for key in ('width', 'height')):
            add('image-dimensions-review', 'warning', line, 'No positive width/height pair; verify CSS reserves the correct aspect ratio before calling this CLS.')
        if not any((attrs.get(key) or '').strip() for key in ('src', 'srcset')):
            add('image-source-missing', 'error', line, 'No usable src/srcset; render essential images in initial HTML.')
        loading = (attrs.get('loading') or '').lower()
        priority = (attrs.get('fetchpriority') or '').lower()
        if priority == 'high':
            high_images.append(node)
            if loading == 'lazy':
                add('image-priority-conflict', 'warning', line, 'lazy plus high priority: verify placement; high does not cancel lazy loading.')
        sizes = (attrs.get('sizes') or '').strip().lower()
        if re.match(r'^auto(?:\s*,|$)', sizes) and loading != 'lazy':
            add('eager-auto-sizes', 'warning', line, 'sizes=auto requires lazy loading; provide explicit sizes for eager/LCP images.')
        if re.search(r'\b[0-9]+w\b', attrs.get('srcset') or '') and not sizes:
            add('responsive-sizes-missing', 'warning', line, 'Width-descriptor srcset has no sizes; the default 100vw may overfetch for cards.')
    if len(high_images) > 1:
        add('multiple-high-priority-images', 'warning', high_images[1]['line'], f'{len(high_images)} images request high priority; inspect viewport/trace before changing them.')
    if lcp_id:
        candidates = ids.get(lcp_id, [])
        if len(candidates) != 1 or candidates[0]['tag'] != 'img':
            add('lcp-target-invalid', 'error', 1, f'Expected exactly one img with ID {lcp_id!r}; choose the image ID identified in a trace.')
        elif (candidates[0]['attrs'].get('loading') or '').lower() == 'lazy':
            add('lcp-lazy', 'error', candidates[0]['line'], 'Caller-identified LCP image is lazy-loaded.')

    for node in tags['script']:
        attrs = node['attrs']
        script_type = (attrs.get('type') or '').lower().strip()
        if attrs.get('src') and script_type in {'', 'text/javascript', 'application/javascript'} and 'async' not in attrs and 'defer' not in attrs:
            add('parser-blocking-script', 'warning', node['line'], 'Classic external script lacks async/defer; inspect execution-order requirements before deferring.')

    # Repeated stylesheet links can cost style work even when the URL is cached.
    # Be conservative: preserve query versions and every attribute except id.
    # Different media, alternate titles, disabled state, integrity or handlers
    # are not treated as interchangeable. This is a review, never a dedupe fix.
    stylesheets = []
    stylesheet_groups = defaultdict(list)
    stylesheet_hrefs = set()
    for node in tags['link']:
        attrs = node['attrs']
        rel = sorted(set((attrs.get('rel') or '').lower().split()))
        if 'stylesheet' not in rel:
            continue
        stylesheets.append(node)
        href = (attrs.get('href') or '').strip()
        if not href:
            continue
        stylesheet_hrefs.add(href)
        signature = {key: value for key, value in attrs.items() if key != 'id'}
        signature.update(href=href, rel=' '.join(rel))
        if 'disabled' in signature:
            signature['disabled'] = ''
        stylesheet_groups[tuple(sorted(signature.items()))].append(node)
    duplicate_stylesheet_groups = 0
    for matches in stylesheet_groups.values():
        if len(matches) > 1:
            duplicate_stylesheet_groups += 1
            href = (matches[0]['attrs'].get('href') or '').strip()
            add('duplicate-stylesheet-review', 'warning', matches[1]['line'],
                f'{href!r} appears in {len(matches)} matching stylesheet links. '
                'Cached downloads do not eliminate stylesheet application work. '
                'Inspect shared ownership, cascade order and dynamic insertion before consolidating; '
                'this does not measure INP or duplicate network bytes.')

    entity_ids = defaultdict(list)
    entity_types = Counter()

    def inspect_json(value, line):
        if isinstance(value, list):
            for item in value:
                inspect_json(item, line)
        elif isinstance(value, dict):
            raw_type = value.get('@type', [])
            types = raw_type if isinstance(raw_type, list) else [raw_type]
            entity_types.update(t for t in types if isinstance(t, str))
            entity_id = value.get('@id')
            # A reference containing only @id is not another entity definition.
            if isinstance(entity_id, str) and len(value) > 1:
                entity_ids[entity_id].append(line)
            for item in value.values():
                inspect_json(item, line)

    for block in page.jsonld:
        try:
            value = json.loads(block['text'], parse_constant=reject_constant, object_pairs_hook=unique_keys)
            if not isinstance(value, (dict, list)):
                raise ValueError('JSON-LD root must be an object or array')
            inspect_json(value, block['line'])
        except (ValueError, RecursionError) as error:
            add('jsonld-invalid', 'error', block['line'], str(error))
    if page.script is not None:
        add('jsonld-unclosed', 'error', page.script['line'], 'JSON-LD script is not closed.')
    for entity_id, lines in entity_ids.items():
        if len(lines) > 1:
            add('jsonld-entity-review', 'warning', lines[1], f'{entity_id!r} has {len(lines)} definitions. Inspect theme/app ownership and conflicting properties; references and compatible graph fragments can be valid.')

    if profile == 'seo':
        findings = [f for f in findings if f['code'] in SEO_CODES]
    counts = Counter(f['severity'] for f in findings)
    return {
        'analysis': 'offline-rendered-html',
        'scope': 'fragment' if fragment else 'document',
        'success': counts['error'] == 0,
        'error_count': counts['error'],
        'warning_count': counts['warning'],
        'findings': findings[:200],
        'findings_truncated': len(findings) > 200,
        'inventory': {
            'images': len(tags['img']),
            'jsonld_scripts': len(page.jsonld),
            'jsonld_types': dict(entity_types),
            'stylesheet_links': len(stylesheets),
            'stylesheet_unique_hrefs': len(stylesheet_hrefs),
            'duplicate_stylesheet_groups': duplicate_stylesheet_groups,
        },
        'limitations': 'Static triage only. No Liquid rendering, browser layout, JS execution, network, CWV measurement, schema eligibility, or ranking validation. No findings does not prove correctness.'
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('html', type=Path, help='UTF-8 rendered .html/.htm file (not a Liquid template)')
    parser.add_argument('--profile', choices=['all', 'seo'], default='all')
    parser.add_argument('--fragment', action='store_true', help='Audit a rendered section/block fragment, not a full page')
    parser.add_argument('--lcp-id', help='ID of an img already identified as LCP in browser evidence')
    args = parser.parse_args()
    try:
        if args.html.suffix.lower() not in {'.html', '.htm'}:
            raise ValueError('Input must be rendered .html/.htm, not Liquid source.')
        with args.html.open('rb') as handle:
            content = handle.read(20 * 1024 * 1024 + 1)
        if len(content) > 20 * 1024 * 1024:
            raise ValueError('Input exceeds 20 MiB; pass one storefront document or fragment.')
        result = audit(content.decode('utf-8-sig'), args.fragment, args.lcp_id, args.profile)
        result['input'] = {'file': str(args.html.resolve()), 'sha256': hashlib.sha256(content).hexdigest(),
                           'bytes': len(content), 'callerLcpId': args.lcp_id}
    except (OSError, UnicodeError, ValueError, RecursionError) as error:
        print(json.dumps({'success': False, 'error': str(error)}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['success'] else 1


if __name__ == '__main__':
    sys.exit(main())
