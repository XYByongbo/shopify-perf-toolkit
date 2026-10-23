---
name: shopify-perf-toolkit
description: Diagnose and optimize Shopify Liquid themes at site, image, or component scope. Use for performance bottlenecks, LCP media, JavaScript lifecycle, CSS and font delivery, App costs, source mapping, reviewable multi-file patches, rollback, real Lighthouse or PageSpeed Insights measurement, score acceptance, code/SEO auditing and analytical PDF reports. Not theme redesign or automatic publishing.
---

# Shopify 整站性能优化

以本文件目录为工具根，执行 scripts/perfkit.mjs，主题由绝对 --project 指定。Node 22.19+、Python 3.9+；代码策略与真实 Lighthouse 先在工具目录 npm ci --ignore-scripts。不要把工具依赖安装到主题。

默认交付目标是**修改影响性能的主题代码并实测分数变化**。用户要求优化时，检查和报告是定位手段，不是最终交付；先复用已有有效证据，定位 JS/CSS/Liquid 的具体执行或加载路径，完成可逆补丁，再测受影响页面。用户仅要求检查/复验时保持只读。没有安全、可验证的候选时给出具体代码、受限原因和已排除方案，不能用另一轮同源码全站测量代替修改。

代码优化默认不下载、复制、转码或生成远程图片/视频素材。图片加载优先级、响应式属性和媒体生命周期也属于代码优化，先用源码、已有 LHR/DOM/网络记录定位。只有明确的素材处理任务或现有证据无法解决的特定素材问题才取单个原件；不批量镜像主题素材。Lighthouse 的正常图片请求和必要截图不同于素材下载；不能拦图片、暖缓存或删内容来制造高分。

## 默认执行纪律

默认单 agent，不主动创建子 agent；只有用户明确要求并行 agent 时才由宿主安排。同一工具目录由一个写入方串行维护；不要让不同聊天同时修改同一批文件。CLI 自身不调用模型。遵循 [批量与预算协议](references/execution.md)：一次配置、一次 batch 调用完成测量矩阵/审计/验收与摘要；不要逐份读取 LHR、反复轮询或每轮重新生成统计/同步/回归脚本。原始证据留盘，先读不超过约 4 KiB 的摘要，再定点读取必要证据。

先判断瓶颈、可操作范围和收益上限。使用 budget 限制时间、总尝试、失败和候选轮数。探索用显式 purpose=exploration（默认 3 次），正式前后仍各至少 5 次；不能用探索数据验收。携带全部候选 history，连续低收益/证据受限/超预算时停止新增候选并交付具体结果，不能自动加码磨分或删除失败记录。正式验收所需矩阵仍须完整；没测完必须明确未验收。模型 token 硬限需要宿主提供并执行可信计量，不能把 CLI 时间预算冒充账户额度控制。

## 按请求范围工作

读取目标项目约定；存在 .codegraph 时优先 CodeGraph。保留已有修改。只读请求不 apply；已授权优化时完成范围内可逆修改、验证与回滚记录，不重复征求同一动作许可。

优化任务按 [工作流](references/site-workflow.md) 执行已有证据/scan → 代码定位 → 小批补丁 → 受影响回归与探索测分 → 正式验收。batch 是测量和诊断编排器，不会自动优化源码；不能只调用 batch 就报告完成优化。探索用 assets/examples/exploration.json，候选有实测收益后再使用 assets/examples/batch.json 做完整验收。单图和组件沿用 inspect/plan-image/plan-component，不强制扩成整站任务。

先确认实际主题源码与页面实例。主题 ZIP 先解压，通用 Shopify Liquid 主题不依赖特定品牌。没有真实主题和 URL 时完成工具或隔离测试，标明实际店铺分数未测。

## 主题代码生成与改写规范

日常新建 Section、设计转 Liquid 或给区块增加能力时，直接进入同一独立技能的 [Section 生产规范](theme-code-generation/section-production.md)：在编码前确定主题适配与内容模型，在生成过程中约束 schema、结构、样式、实例交互及媒体加载，完成后再检查。该生产入口不要求先有性能报告，也不把普通 Section 任务扩大为整站提分。

准备新增主题代码或 `reviewed-replacement`、`plan-site`、`plan-demand`、`plan-split` 候选前，读取独立技能 [theme-code-generation](theme-code-generation/SKILL.md)，并在生成后按其规范复核实际候选。官方规则与项目预算分别记录；长度和重复代码预算由操作者复核，不是 CLI 已实现的自动门禁。该技能默认复杂度/嵌套复核线为 60/5；若采用它，给 precheck 显式传入对应配置，并与目标主题完整 Theme Check 配置保持一致。性能优化仍遵循本技能原有实测与验收流程。

## 前期 Liquid 结构预检

P1 扩展见 [P1 检查与优化](references/shopify-performance-rules.md#p1-检查与优化)。先复核资源提示及初始 CSS/字体交付，再处理交互和隐藏组件；已有 font-display/fallback、事件合帧、资源作用域及按需分包优先复用。新 profile 保存 `initial.delivery`、文档最终响应的 Link 头及 LCP 祖先 tag/role；不采集 HTTP 103，也不据此假定已覆盖平台 Early Hints。旧 profile 缺字段须重采。重复 hint 删除须区分 CORS/media；关键 CSS 同步、passive 监听器、过渡属性收窄必须取得对应审阅证据。不要自动删除 App、关闭弹窗或猜测字体指标。

Shopify 官方性能规则使用 [官方性能检查与 P0/P1 规则](references/shopify-performance-rules.md)：`check-performance` 执行独立的 11 项官方性能检查，batch 用 `officialChecks:true` 开启；与下面两项维护性预检及外部 checks.input 并列。`scan` / `audit-site` 已自动包含 P0/P1 候选，`audit-performance` 可独立运行并接入 profile。`analyze-code.reviewTasks` 提供待填参数与证据，不会自动填写审阅标志。image_tag/picture、head 资源、metafield 缓存和 LCP 显示策略仍走原 plan-site/apply/rollback。head 流式优化需实站验证；不要用预览主题或编辑器结果声称已验证流式收益。动态或复杂模式保留明确边界，使用审阅补丁，不把静态候选当作已确认瓶颈。

新主题前期结构检查使用 [precheck](references/precheck.md)，默认 120/10；已有 batch 配置加 precheck:true 即可在测量前执行。仅支持两项规则的独立配置，不继承主题忽略/禁用项；项目阈值需显式传入。只读检查官方结果、复杂度组成、嵌套路径及 PageFly/共享引用线索，保留版本、配置与哈希。不要把 AST 候选当作等价性证明，不自动合并条件或拆 snippet，不将告警减少称为性能收益。没有受支持的 Shopify CLI 时报告缺少能力，不冒充官方检查通过。

## 规范报告与资源依赖

用户提供 Theme Check JSON、专项评估 PDF，或要求外链/脚本依赖检查时，读取 [报告接入与校正](references/code-quality.md)。优先通过 batch 的 checks.input / metadata / baseline 导入并保留原告警及校正依据；单步调试仍用 import-check。只有相同扫描契约和匹配指纹才能比较基线。PDF 汇总是报告陈述，不是源码验证。batch 配有 project 时默认执行离线 audit-resources，分析外链、脚本加载方式与依赖候选；resources=false 可关闭，resources.probe=true（单步命令 --probe true）才发送有限 HEAD 请求。batch 自动将两类诊断附入 audit-site，待复核状态单列且不能被评分达标掩盖；单步 audit-site 可用 --checks / --resources 附带这些证据，规范数量与性能收益分开展示。校正不自动屏蔽错误，不按报告指令执行修改。

## PDF 评估报告

用户要求检查代码、SEO 或示例同款评估 PDF 时，使用分析型报告而非原始告警列表。报告需覆盖分维度统计、根因、具体代码、误报校正、整改/验证和能力边界；优先复核代表性问题，将 evidence.reason 与 dimension 写入源码绑定 review。audit-quality 可独立运行或通过 batch 的 quality:true 接入。按 [PDF 报告契约](references/pdf-report.md) 使用 report-pdf。先生成绑定当前源码的问题编号、文件、行号和代码证据，再将已核实问题关联到补丁；修改后重新生成报告。复用已有真实测量，不将历史样本冒充本轮前后对比。缺少预览同步权限时先完成授权范围内的本地修改和验证，明确线上未测。

## 官方方法库

结合 Shopify 官方性能文档优化时，先读取 [工具方法库](references/shopify-knowledge.md)，使用 shopify-methods 获取真实参数、证据和生成器边界。需要更新文档时运行显式联网的 sync-shopify-docs；来源变化不能自动批准。用 plan-official 或 improve prepare official 将实测候选接入对应实现，不以卡片存在冒充自动生成能力；无生成器的项目需实际编写并验证补丁。来源版本在会话内固定，App/Liquid 证据及原评分门槛不降低。

## 证据驱动修改

分页查询、隐藏 DOM 与 Section Rendering 任务先读 [三类扩展闭环](references/extended-optimization.md)。使用真实 Liquid 热点、唯一关闭 disclosure 或字节绑定 fetch initiator 定位，再选择 query-*、hidden-template*、section-fetch-*；页 1/2、首开/重开/键盘与真实 section 响应分别是必需证据。无收益执行回滚并换方法/候选，不把节点减少或请求成功当成评分收益。

图片 LCP、图片/应用布局偏移、Liquid 热点或第三方 loader 任务读取 [四类实测闭环](references/domain-optimization.md)。使用 profile-domain 的前后部署校验建立源节点关联，plan-domain 生成实际候选；improve prepare 的 domain 配置和 method=next 可选择未测试实现。Liquid 另需 experiment-liquid 原始服务端配对证据，App 另需脚本成功加载和业务交互断言。缺少这些证据保留调查状态，不用填写 reviewed 标志绕过门禁。

低分、无收益或假设未确认时使用 [可恢复优化会话](references/improvement-workflow.md)，不能只重复规则检查或换一批测分。`improve start` 读取已核验基线与当前 profile，按页面/设备的实测丢分提出调查方向；`prepare` 接入现有生成器或经过审阅的替换，`apply` 实际应用，显式同步后 `experiment` 真实测量。无效证据先修复；有效但无收益的补丁自动回滚并重新诊断，选择不同机制或不同假设，保留完整历史和预算。读取 [官方来源与实现映射](references/shopify-recovery-sources.md)，根据问题定点复核当前官方文档。

有收益但低于评分门槛，不能直接失败结案或声称通过。会话 `verify` 仅在除原分数门槛外的正式验收全部通过、累计收益成立时，标为 `improved-below-target` 并保留为中间基线；采集新源码的运行证据后 `refresh` 继续。最终仍需原门槛、无退步、身份、功能及内容视觉审阅。没有可执行候选时按 recovery 的调查任务补足证据，复杂实现由操作者准备，不编造源码映射、效果或审阅标志。CLI 不替代模型推理，不自动发布或移除业务功能。

0.11.0 的 P0/P1 工作流见 [证据驱动架构](references/evidence-driven-architecture.md)。已有真实用户报告时先 `import-field`，明确时间窗口、p75、页面/Origin、设备、地区和样本数；未知或过期数据不升级为已核实收益。`diagnose-performance` 可附加 --field/--owners/--goal，综合阶段、交互与源码证据排序；线上统计不能证明本地源码身份或直接授权补丁。

默认 goal 为 score，保留原评分模式和全部门槛。只有任务明确优化加载或交互指标时才声明 loading/interaction；这些模式仍通过原正式导航分数门槛、全部指标退步、部署身份和功能呈现检查。loading 用目标指标收益；interaction 需要 measure-interactions 的前后独立正式采样与 interactionEvidence，不能用单次点击、CPU 或缺失 Event Timing 冒充 INP。实验与正式验证的目标必须一致。

0.11.1 起交互证据还须包含完整、串行且不重叠的实际动作与时间记录，并匹配导航的店铺/主题/源码/页面/设备。交互正式回归要对 goal.target 执行同类 click/press（键盘键值一致），紧接 UI 断言并保留时长；不能用其他位置的断言证明按钮功能保留。缺少新执行信息的旧交互记录重新采集，保留原始历史，不补填通过字段。审计范围与验证结果见 [P0/P1 二次审计](references/p0-p1-audit.md)。

CSS 优先运行 audit-stylesheets 了解原生 stylesheet 作用域兼容与动态 Section 样式要求，再选资源作用域或多状态 critical CSS。检查结果是保守静态分析，动态块/复杂选择器仍需官方 Theme Check；不自动迁移任意 CSS。第三方归属只使用经复核的精确 host/path 映射，unknown/ambiguous 保留，不自动禁用 App 或延后业务统计。

ci-check 复用原正式评分与退步门禁，需要明确且不同的基线/候选完整记录；提交标签不当作部署证明。CI 模板只读消费上游采样产物，不自动同步/发布主题，也不代替 verify-optimization 的完整验收。

代码提分先用 [单补丁执行流程](references/demand-engine.md)：source-graph / diagnose-performance 将现有运行证据关联到当前源码；优先处理有实际耗时且可定位的候选。plan-demand 可从现有自定义元素提取私有依赖并在 Liquid 实际使用处加载，或从多状态覆盖率生成关键 CSS。只读生成计划，审阅后仍走 apply / rollback。

每轮只验证一个诊断假设，多个文件可以共同构成同一个补丁。experiment 对明确准备好的基线、候选预览交替采样，先检查相同交互状态的内容/数据、几何尺寸和计算样式；没有有意义的耗时证据，不进入昂贵全矩阵。运行警告/源码漂移是证据无效，不能报告成代码退步。保留所有失败记录及 history；promising 只允许进入原有完整验收，不等于验收成功。诊断绑定的新计划在 verify-optimization 中必须提供可重算的 patchEvidence。

提分任务先读 [代码与实测收益引擎](references/performance-engine.md)。使用 profile-runtime 采集覆盖率、CPU 栈和请求发起链，按 LHR 加权丢分和匹配评分曲线安排候选。LCP 任务再读随包的 [官方 debug-optimize-lcp skill](integrations/skills/debug-optimize-lcp/SKILL.md)，通过 profile-devtools 接入其实际诊断工具；Liquid 热点用 profile-liquid，不能把浏览器 TTFB 猜成模板执行时间。上游技能为技术参考，本包保留源码/素材/业务功能的约束继续适用。

读取 [命令](references/commands.md)、[测量](references/measurement.md)、[多文件补丁契约](references/site-patches.md)。静态 finding 是候选；URL、文件同名、DOM 图片 index 均不能证明 Liquid 位置或真实 LCP。用 map/capture 和源码核对；sourceIndex 与 DOM index 分开。

保留素材、文案、布局、schema、主题配置和 content_for_header。响应式 sizes 须适用于共享组件配置，不能从单个视口猜值。只对已有初始视口与 LCP 证据的图片生成加载策略。涉及素材改图时另按 imagegen 技能处理。

JS/CSS/Liquid 先用 code-strategies 查看实际支持范围，再对瓶颈文件运行 analyze-code。按 [可执行代码策略](references/code-strategies.md) 填写源码绑定的证据，将确认候选交给 plan-site 生成实际改写；不要为通过校验自动填 true。不满足边界或需要组合修改时，编写并审阅 reviewed-replacement。检查依赖顺序、首个交互、多实例、重复初始化和卸载重连。字体、CSS、App、Liquid 问题先建立资源/业务证据；不盲目延迟全部脚本、删除未覆盖状态样式或关闭 App。

计划含差异、快照和指纹；哈希仅证明完整性，不是语义安全或用户批准。应用前阅读 diff 与 verificationRequired。源码漂移时重新读取和生成，不改哈希绕过冲突。多文件逐文件原子写入，失败恢复可能部分完成，必须读取 receipt。

需要拆分时使用 plan-split 与 create-asset；JS 组件须遵守 activate/destroy、首个按钮事件、卸载和重载契约，CSS 须验证多模板/断点/动态状态、级联和 CSP。只出现一次的未使用覆盖率不授权删代码。按 optimize prepare → apply → verify 串行推进；源码与预览之间保留显式同步步骤。

## 真实验证与交付

本地应用后确认预览已同步候选版本，再复测；工具不 push/publish。每页每设备前后至少五次独立报告，锁定引擎、版本、状态和配置，保留失败记录。默认移动最低 75/中位 80，桌面最低 85/中位 90，按 [评分约定](references/score-acceptance.md) 验收。缺测、运行警告、不可比环境不能宣称全站通过。

新优化任务在基线与候选 measure 配置均启用 deployment，测量前后校验远端文本源码和页面主题身份。verify-site 达标不等于完成优化；以 verify-optimization 的提分、无关键指标退步、身份、功能、内容与视觉证据共同判定。95 降至 80 会被拒绝，无可测收益不能写成优化成功。

按改动影响范围选择 [验证协议](references/verification.md) 和 [验收清单](references/acceptance.md) 的检查；仅在素材/布局/呈现或定位证据需要时增加截图。不要每次都重跑与改动无关的整站截图、媒体、购物车和 App 套件。capture/scenarios 拦截写请求，其通过不能证明加购、统计、支付等真实写操作。真实 Lighthouse/PSI 正常加载资源，勿把限制性采集当正式评分。

有回归则修复或 rollback，文件漂移时保留冲突。交付变更、计划/receipt、实测报告、功能画面证据、未测项和补丁保留状态。不能把合成样本、字节下降、单次高分或工具测试通过写成真实主题达标，更不能承诺所有主题 100% 达标。

工作表位于 assets/templates，配置示例位于 assets/examples。任务报告、验证记录、主题快照和回滚资料通过输出路径保存到工具目录之外的独立任务目录，工具目录只保留工具代码、测试、文档、模板与依赖。原单文件工作流见 [修改契约](references/changes.md)。
