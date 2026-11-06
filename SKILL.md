---
name: shopify-perf-toolkit
description: Diagnose and optimize Shopify Liquid themes at site, image, or component scope. Use for performance bottlenecks, LCP media, JavaScript lifecycle, CSS and font delivery, App costs, source mapping, reviewable multi-file patches, rollback, real Lighthouse or PageSpeed Insights measurement, score acceptance, code quality and analytical PDF reports. Standalone source SEO repairs use shopify-seo-toolkit. Not theme redesign or automatic publishing.
---

# Shopify 主题性能优化

版本 **0.18.0（2026-11-06）**。从本技能目录执行 `node scripts/perfkit.mjs`，用绝对 `--project` 指向真实主题。Node 22.19+、Python 3.9+；工具依赖在本目录 `npm ci --ignore-scripts`，不安装到主题。主题 ZIP 先解压；没有真实主题/URL时完成隔离验证并明确店铺未测。

用户要求优化时，目标是完成可逆的主题代码修改并验证实际收益；审计和报告用于定位。只要求检查或建议时保持只读。没有安全可验证候选时给出具体受限原因与已排除方案，不以重复测分代替修改。

独立 SEO 源码/保存 HTML 审查使用 `shopify-seo-toolkit` 与 `seokit`，见 [拆分与兼容说明](references/seo-toolkit.md)。本入口保留旧 audit-quality、audit-html 与综合报告命令；旧批处理的退出语义不变。

## 按任务读取

只读取当前相关的资料，同一份有效证据与检查结果复用；普通小改不扩大为整站优化。

| 当前任务 | 进入的材料与工具 |
| --- | --- |
| 新建 Section、设计转 Liquid、增加区块能力 | [theme-code-generation](theme-code-generation/SKILL.md) → 生产规范；沿用目标品牌/主题，不默认导入 WOLFBOX 设计规范 |
| 单图/组件诊断与局部补丁 | [修改契约](references/changes.md)、[代码策略](references/code-strategies.md)；inspect / plan-image / plan-component |
| 整站性能优化或提分 | [工作流](references/site-workflow.md)、[执行预算](references/execution.md)、[实测引擎](references/performance-engine.md)；scan → 定位 → 补丁 → 探索 → 正式验收 |
| 已有运行证据、JS/CSS 按需加载 | [单补丁执行](references/demand-engine.md)；source-graph / diagnose-performance / plan-demand / experiment |
| LCP、布局偏移、Liquid、第三方 App | [专项优化](references/domain-optimization.md)；LCP 再读 [debug-optimize-lcp](integrations/skills/debug-optimize-lcp/SKILL.md)，只核对所需官方诊断工具 |
| 查询、隐藏 DOM、Section Rendering、首屏 Liquid | [扩展方法](references/extended-optimization.md)、[专项执行细则](references/task-workflows.md#证据驱动修改) |
| 搜索、变体、Quick-add、加购/购物车 | [购物交互场景](references/interaction-scenarios.md)、[交互与线上证据](references/evidence-driven-architecture.md)；按影响范围选择场景，沿用原正式交互门禁 |
| 独立 SEO 审查与 SEO 报告 | [SEO 工具](references/seo-toolkit.md)；使用 shopify-seo-toolkit / seokit |
| 两主题差异、整改报告复核、JSON 内嵌业务代码 | [整改证据](references/theme-evidence.md)；theme-diff / audit-quality，区分当前状态、历史原因与性能收益 |
| 综合代码审查（含旧 SEO 规则）、Theme Check、外链与脚本依赖 | [规范报告](references/code-quality.md)、[前期预检](references/precheck.md)、[官方性能规则](references/shopify-performance-rules.md)；audit-quality / check-performance / audit-resources |
| 已保存的最终页面/Section HTML、表单/焦点快照 | [渲染后 HTML 与快照](references/rendered-html.md)；audit-html；batch 的 renderedHtml 仅消费显式输入 |
| PDF 评估报告 | [PDF 契约](references/pdf-report.md)、[报告细则](references/task-workflows.md#pdf-评估报告)；report-pdf，绑定当前源码问题和实际验证 |
| 无收益、低于目标或恢复执行 | [可恢复会话](references/improvement-workflow.md)、[恢复执行器](references/recovery-cycle.md)；improve / improve-cycle，不重复收集已固定的正式样本 |
| 官方方法、资源/字体升级、归属及历史兼容 | [官方方法库](references/shopify-knowledge.md)、[功能升级](references/toolkit-evolution.md)、[专项执行细则](references/task-workflows.md)；按主题检索对应小节 |

全部参数见 [命令参考](references/commands.md)。`batch` 编排测量与诊断，不会自动优化源码；`status=complete` 也不等于优化验收。HTML/源码检查、规范告警和真实收益分别报告，不能用检查通过代替性能结论。

内置方法不能覆盖当前瓶颈时，按 [自定义实现流程](references/source-repair-workflow.md) 执行 request-implementation，阅读请求中的源码并编写候选，plan-custom 审阅后以 improve prepare 的 implementation 接回原会话。不能因为没有内置策略就只输出建议；缺少实测证据或预算时说明具体阻塞。候选检查清单不是通过证据，仍须实际预览和实验。

## 共同执行边界

读取目标项目指令，保留已有修改；存在 `.codegraph/` 时先 CodeGraph。默认单 agent、一个写入方串行维护同一工具目录，CLI 不调用模型。按 [执行预算](references/execution.md) 一次配置、一次 batch 编排矩阵，先读不超过约 4 KiB 摘要，再定点读取原始证据；不反复全量读 LHR 或重写回归脚本。

先判断瓶颈、实际成本、可操作范围和收益上限。绑定当前源码/调用路径，静态 finding 只是候选；URL、同名文件或 DOM 图片 index 不能证明 Liquid 源码位置。不要把待填证据自动写成 true，也不要重写哈希绕过校验。具体方法的证据边界保留在对应引用中。

修改主题代码前采用 [代码生成规范](theme-code-generation/SKILL.md)，生成后复核实际候选。官方规则和项目预算分开；文档行数/重复预算不冒充已实现的 CLI 门禁。独立 precheck 不继承主题全部规则配置，参数须与目标约定核对；不能通过禁用规则获得通过。

保留素材、文案、布局、画质、schema/商家配置、`content_for_header`、多语言、可访问性、购买及必要统计。默认性能优化不批量下载/复制/转码远程素材，不删业务功能、拦图片、暖缓存或挑最好样本制造分数；坏图恢复不计性能收益。媒体优先级须有真实位置与 LCP 证据，共享 sizes 须适用于实际配置。

每轮验证一个诊断假设，可由多个文件构成。计划包含 diff、快照与指纹；应用前检查差异和验证要求，哈希不证明语义安全。apply/rollback 保留源码冲突保护；逐文件写入失败可能部分完成，必须读取 receipt。作用域加载、关键 CSS、脚本和资源替换沿用现有生成器边界及实际依赖审阅。字体保留身份；资源替换正式验证仍要求逐页面/设备的部署绑定 GET、SHA-256、MIME、唯一节点和等价证据。

本地补丁后显式同步到已授权候选预览，独立确认远端身份再复测；不自动 push/publish 或移除 App。无收益或回归则修复/回滚，保留完整 history、失败证据和预算；连续低收益/证据受限/耗尽预算时停止新增候选，缺测明确未验收。有收益但低于原目标时按恢复流程作为中间基线继续，不下调门槛冒充完成。

## 实测验收与交付

- 探索显式 `purpose=exploration`（默认 3 次），不能充当正式验收。正式每页每设备前后各至少 **5 次独立报告**，锁定引擎/版本/状态/完整配置，保留全部有效样本与失败记录。默认移动最低 75/中位 80，桌面最低 85/中位 90，见 [评分契约](references/score-acceptance.md)。
- 新优化任务的两侧测量启用 deployment；测量前后核验远端文本源码、店铺/主题/页面身份。最终使用 `verify-optimization` 同时检查收益、关键指标无退步、部署身份、功能与内容视觉；`verify-site` 或 CI 达标不等于完成优化。95→80 不因仍过门槛而接受。
- 默认 goal=score。显式 loading/interaction 仍通过原导航分数及全部保护；interaction 需要独立、串行、不重叠的实际动作/Event Timing，匹配页面/设备/店铺/主题/源码与紧随动作的 UI 断言。单次点击、TBT、CPU 或瞬时 observer 不证明 INP/线上 p75。
- 按 [验证协议](references/verification.md) 和 [验收清单](references/acceptance.md) 选择受影响检查。capture/scenarios 拦截写请求，不能证明真实加购、统计、支付；缺少条件标记 NOT RUN。version 2 快照增加表单/焦点状态，不替代业务断言、视觉与正式采样；旧证据不补造新字段。
- 交付实际改动、计划/receipt、报告、功能/画面证据、未测范围及补丁保留/回滚状态。合成测试、静态告警减少、字节下降或单次高分都不能写成真实主题达标。

报告、截图、主题快照、回滚资料和发行 ZIP 保存到工具/主题仓库外的任务目录，显式指定输出路径。工具仓库保留实现、测试、必要文档和模板；示例配置在 assets/examples。专项参数与兼容约束已迁到 [专项执行细则](references/task-workflows.md)，只读取本次相关段落。
