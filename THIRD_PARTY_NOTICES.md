# Third-party material added in 0.15.0

`scripts/audit_rendered_html.py` is adapted from
[`shopify-theme-skills`](https://gitlab.tanlink.com.cn/fe-skills/shopify-theme-skills/-/blob/63744f0eaf4716ad8a7b1e8aa31b3c27728fcaa2/skills/shopify-section-seo-performance/scripts/audit_rendered_html.py),
commit `63744f0eaf4716ad8a7b1e8aa31b3c27728fcaa2`.
Its Python parser and Shopify checks are copyright (c) 2026 Skill contributors,
under the [original-material MIT license](licenses/SHOPIFY-THEME-SKILLS-MIT.txt).
It in turn adapts Addy Osmani's `web-quality-skills` HTML audit workflow;
copyright (c) 2026 Addy Osmani, [MIT](licenses/ADDY-MIT.txt).
`tests/test_rendered_html.py` is adapted from that suite's `tests/test_audit.py`
under the same original-material license. Toolkit modifications add bounded
byte reads, input fingerprints and CLI/batch integration.

Checkpoint state coverage and the shopping interaction checklist were informed
by the same suite's `assets/diagnostics/section-checkpoints.mjs` and
`references/interaction-verification.md`. The existing toolkit checkpoint and
verification engine were extended in place; no second controller, measurement
engine or Shopify theme implementation was imported. The checklist links to
the source and restates the relevant cases for this toolkit's actual tools.

These notices apply only to the material listed here. Existing bundled
integrations retain their own notices. No license for the rest of this
repository is inferred from these MIT files. No WOLFBOX brand specification
or Shopify Dawn/skeleton source code was imported in this update.
