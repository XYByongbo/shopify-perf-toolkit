---
name: shopify-seo-toolkit
description: Audit Shopify Liquid source and saved storefront or Section HTML for SEO metadata, canonical declarations, JSON-LD, crawlable-link and image-alt observations. Use for SEO checks and offline SEO reports; performance scoring and optimization use shopify-perf-toolkit.
---

# Shopify SEO 审查

版本 0.16.0。这是源码与保存 HTML 的只读审查工具。发行包从本目录运行 `node scripts/seokit.mjs`；本仓库开发时从仓库根目录运行同一脚本。Node 22.19+；HTML 审查还需要 Python 3.9+ 标准库。详细配置见 [SEO 使用说明](../../references/seo-toolkit.md)。

- 主题源码：`audit-source --project <绝对主题目录> --out <新JSON>`。沿用字面 snippet 引用和源码指纹；动态 JSON-LD、条件及 App 注入保留待渲染核对。
- 保存 HTML：`audit-html --input <绝对HTML文件> --out <新JSON>`。Section 片段加 `--fragment true`，不要求整页元数据。
- 同一任务多个输入：`batch --config <绝对配置文件> --out <新目录>`。只需要 project 或 renderedHtml，不要求测分基线。
- 结果：`report` 输出 HTML；`report-pdf` 需要 Python reportlab。先读 JSON 状态、覆盖问题及来源，再引用具体条目。

`audit-complete` 只表示当前离线规则执行完整且未发现条目；`acceptance=not-evaluated` 始终保留。源码存在声明、保存 HTML 正确、线上索引状态是不同证据。HTML 行号不映射为 Liquid 行号；文件哈希不证明部署身份。HTTP 响应、robots/sitemap、hreflang 互返、Rich Results 与排名验证尚未执行。

首版没有自动修复、在线抓取或发布命令。用户要求修复时先定位当前源码和归属，明确待验证变化，不能将离线检查结论标为修复验收。性能测量和提分任务使用性能工具包，SEO 告警不换算为性能分数。

报告保存到工具和主题目录之外的新任务目录。保留不完整、截断、未知及失败结果；批次失败时先复用已完成产物。命令退出 0 表示所覆盖检查无发现，3 表示待审/部分完成/停止，2 表示输入或执行失败。
