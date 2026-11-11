---
name: shopify-seo-toolkit
description: Audit and repair Shopify Liquid source SEO metadata, canonical, JSON-LD, crawlable links and image alt. Use for code-only SEO fixes with reversible writes and source verification; saved HTML reports remain optional. Performance scoring uses shopify-perf-toolkit.
---

# Shopify SEO 源码优化

版本 0.20.0。用户要求优化时，完成实际源码修改与复核，不只交报告。输入为绝对主题目录；源码流程不要求 URL、浏览器或 Python。发行包从本目录运行 `node scripts/seokit.mjs`，先 `npm ci --ignore-scripts`；仓库开发从仓库根运行。Node 22.19+。

先读目标项目指令和 [主题代码规范](../../theme-code-generation/SKILL.md)，保护已有修改。按 [源码修复流程](../../references/source-repair-workflow.md) 执行：

1. audit-source 定位当前源码问题、引用及覆盖状态。用户只要求检查时保持只读。
2. 用户要求修复时，plan 生成元数据候选；读取 diff，确认当前主题结构和数据来源，再 apply → verify；也可 fix 一次完成自动候选、写入及复核。
3. remaining 中有可确定的问题时，继续阅读相关源码，编写候选配置，使用 plan/fix --config。alt/JSON-LD/链接依照已有业务数据修复，不能虚构图片含义、商品、价格、评价或链接目标。不是仅给建议后停止。
4. 缺失业务数据或扫描不完整时明确具体阻塞；不可将动态值或未测分支宣称正确。检查失败时按 receipt 回滚，冲突时保留外部改动。
5. 交付修改文件、diff、执行记录、source-fix-verified 的选定目标及剩余问题。此状态仅为源码规则验收；动态渲染、功能、抓取、索引、排名未验证。

plan/apply/verify/rollback 使用新 JSON 输出路径；fix 使用新目录。报告和回滚资料保存到工具、主题仓库之外。一次仅一个写入方；不要并行运行两个工具修改同一主题。

旧 audit-html、batch、report、report-pdf 保留可选只读诊断，见 [SEO 配置](../../references/seo-toolkit.md)。保存 HTML 行号不映射为 Liquid 行号。audit 结果的 acceptance 始终 not-evaluated；修复结果单独验证。源码声明不证明线上效果，也不能换算为性能分数。

退出码：0 表示该操作完成（审查无发现）；3 表示待审、部分修复或未通过源码验证；2 表示输入/执行失败。fix 出现 failed-rolled-back 或 rollback-conflict 时读取记录，不得报成功。性能与提分使用 shopify-perf-toolkit。
