# 项目工作指令

## Shopify 主题代码生成与改写

在本项目工作流中生成、重构或编写 Shopify 主题 Liquid、CSS、JavaScript 补丁时，先读取 [theme-code-generation/SKILL.md](theme-code-generation/SKILL.md)，再按其规范生成与复核候选。包括 `reviewed-replacement`、`plan-site`、`plan-demand` 和 `plan-split` 的候选准备与结果审阅。

日常“新建 Section”“设计转 Liquid”“给区块加功能”也直接触发该技能的生产入口：先按 [Section 生产规范](theme-code-generation/section-production.md)确定内容模型、配置、结构、样式和必要交互，从第一版遵守标准，再执行共享规范的后置检查；不等待出现告警才应用规范。

该规范针对主题代码；普通工具实现、文档编辑和只读报告不强制套用主题行数预算。官方规则与项目约定分开报告，保留目标主题已有配置和用户指定范围。

## 代码定位

目标仓库存在 `.codegraph/` 时，在代码搜索和阅读前优先使用 CodeGraph；没有索引时使用常规文件工具，不自行建立索引。
