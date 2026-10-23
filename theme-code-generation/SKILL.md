---
name: theme-code-generation
description: Create Shopify sections to production standards from the first draft, then validate them with Theme Check and project budgets. Use for daily section creation, design-to-Liquid implementation, adding section features, and refactoring long, nested, or duplicated Liquid, CSS, and JavaScript.
---

# Shopify 主题代码生成

本技能同时负责**生成时的生产规范**和**生成后的质量检查**。“做一个 Section”“把设计转成 Liquid”“给区块加功能”等请求直接进入生产流程，不等待已有代码或检查报告。

## 按任务选择入口

- **新建 Section、设计转代码、增加区块能力**：先读 [section-production.md](section-production.md)，按主题适配 → 数据与配置 → 结构 → 样式 → 必要交互逐步实现；同时读取共享规范的预算与语义边界。代码完成后进入检查。
- **重构已有代码、优化补丁**：读取 [theme-code-generation.md](theme-code-generation.md)，结合受影响的生产规范处理结构和复用。普通小改动不扩成全主题重构。
- **只读审查、检查报告**：读取共享规范的检查与交付部分，保持只读。

共享规范中的 OFF 为官方依据，PROJ 为本技能采用的项目约定；不要把项目预算称为平台限制。生产流程和检查流程共用一套预算，不维护两份冲突阈值。

## 生产过程中执行

1. 确认目标主题、需求和交付形式；存在 `.codegraph/` 时先用 CodeGraph 定位，否则搜索实际组件和接口。没有目标主题时按通用主题实现，并标明适配假设。
2. 写代码前确定文件职责、重复内容模型、设置清单、空状态和资源加载方式。已有信息足够时直接实施，不增加计划审批步骤。
3. 重复内容从第一版就按数据/blocks 循环输出；优先复用主题组件；不先复制多份 DOM，再等待检查器要求去重。
4. Liquid 保持浅层判断，CSS 按组件作用域组织，JS 仅用于必要交互并支持多实例与编辑器重载。按生产规范同步编写 schema 和绑定，避免最后补一大套无实际用途的配置。
5. 每完成一个职责单元就复核体量与依赖；接近共享预算时先简化或按职责拆分，再扩展功能。超限可记录合理例外，不通过压缩行数、删功能或机械拆文件达标。

## 完成后的验证

在完整目标主题或包含依赖的候选副本上运行 Theme Check，复核项目预算，再验证受影响的配置、空数据、布局与交互。检查器不可用、版本不支持或未运行时如实记录，并完成其余独立验证。

交付完整代码和实际依赖、检查结果、预算复核及未测项。纯 Section 生产不自动扩大为整站性能提分任务。

## 检查资源

- [Theme Check 配置模板](assets/theme-check.yml)：推荐规则集及显式项目阈值。先读取目标主题已有配置，再合并需要的条目；不要直接覆盖配置或移除现有检查。
- [工具包预检配置](assets/precheck.json)：可选，用于 shopify-perf-toolkit 的两规则预检；不代替完整 Theme Check。
- 文档中的长度和重复代码预算由操作者复核，v1 没有提供其自动检查器。不能仅凭 Theme Check 通过宣称全部项目规范通过。

## 与性能工具包配合

若调用环境有 shopify-perf-toolkit，在编写 `reviewed-replacement`、生成 `plan-site` / `plan-demand` / `plan-split` 候选前采用本规范，生成后复核实际候选结果。沿用原计划、源码指纹、回滚和性能验证要求；本技能不扩大 CLI 支持的文件类型。

工具包的 `precheck` 使用独立两规则配置，不读取主题 `.theme-check.yml`；使用本技能默认预算时显式传入 `assets/precheck.json`，目标主题另有预算时同步调整两处。`checks.input` 可以导入完整 Theme Check 报告，但导入本身不会启动检查器。

本目录可单独作为 skill 使用，不依赖父目录文档或性能工具包。放在工具包根目录时，通过根目录 `AGENTS.md` 和主 `SKILL.md` 接入工作流；这不等于已经安装到用户的全局技能目录。

若任务同时使用 section-snapper 等设计采集/还原技能，在其产出最终 Section 前应用本技能的生产规范。保留用户选定的忠实还原、单文件和预览交付要求；不能为结构预算擅自重设计或生成交付链路无法接收的依赖。
