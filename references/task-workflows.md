# 专项执行细则

从主技能按任务进入，只读取相关小节；不要把本文件与全部引用默认一起加载。

- 规则、报告、PDF：[结构预检](#前期-liquid-结构预检)、[规范报告](#规范报告与资源依赖)、[PDF](#pdf-评估报告)。
- 方法与优化：[官方方法库](#官方方法库)、[证据驱动修改](#证据驱动修改)。可搜索 P0/P1、Liquid、App、CSS、interaction、ci-check 定点读取。
- 验收与资源等价：[真实验证](#真实验证与交付)、[工具升级](#报告经验驱动的工具升级)。

以下保留既有专项边界，重排入口没有改变原正式评分、部署身份、补丁重放、回滚或审阅要求。新增 HTML 与快照覆盖见 [渲染后检查](rendered-html.md)，购物交互见 [场景矩阵](interaction-scenarios.md)。

## 前期 Liquid 结构预检

P1 扩展见 [P1 检查与优化](shopify-performance-rules.md#p1-检查与优化)。先复核资源提示及初始 CSS/字体交付，再处理交互和隐藏组件；已有 font-display/fallback、事件合帧、资源作用域及按需分包优先复用。新 profile 保存 `initial.delivery`、文档最终响应的 Link 头及 LCP 祖先 tag/role；不采集 HTTP 103，也不据此假定已覆盖平台 Early Hints。旧 profile 缺字段须重采。重复 hint 删除须区分 CORS/media；关键 CSS 同步、passive 监听器、过渡属性收窄必须取得对应审阅证据。不要自动删除 App、关闭弹窗或猜测字体指标。

Shopify 官方性能规则使用 [官方性能检查与 P0/P1 规则](shopify-performance-rules.md)：`check-performance` 执行独立的 11 项官方性能检查，batch 用 `officialChecks:true` 开启；与下面两项维护性预检及外部 checks.input 并列。`scan` / `audit-site` 已自动包含 P0/P1 候选，`audit-performance` 可独立运行并接入 profile。`analyze-code.reviewTasks` 提供待填参数与证据，不会自动填写审阅标志。image_tag/picture、head 资源、metafield 缓存和 LCP 显示策略仍走原 plan-site/apply/rollback。head 流式优化需实站验证；不要用预览主题或编辑器结果声称已验证流式收益。动态或复杂模式保留明确边界，使用审阅补丁，不把静态候选当作已确认瓶颈。

新主题前期结构检查使用 [precheck](precheck.md)，默认 120/10；已有 batch 配置加 precheck:true 即可在测量前执行。仅支持两项规则的独立配置，不继承主题忽略/禁用项；项目阈值需显式传入。只读检查官方结果、复杂度组成、嵌套路径及 PageFly/共享引用线索，保留版本、配置与哈希。不要把 AST 候选当作等价性证明，不自动合并条件或拆 snippet，不将告警减少称为性能收益。没有受支持的 Shopify CLI 时报告缺少能力，不冒充官方检查通过。

## 规范报告与资源依赖

需要官方源码检查时通过 batch 的 checks.run 执行项目 Theme Check，单独检查用 check-theme。已有 Theme Check JSON 或专项评估 PDF 时，按 [报告接入与校正](code-quality.md) 通过 checks.input / metadata / baseline 导入，单独导入用 import-check。只有相同扫描契约和匹配指纹才能比较基线。PDF 汇总是报告陈述，不是源码验证。batch 配有 project 时默认执行离线 audit-resources，分析外链、脚本加载方式与依赖候选；resources=false 可关闭，resources.probe=true（单步命令 --probe true）才发送有限 HEAD 请求。batch 将检查和资源诊断附入 audit-site，待复核状态与评分单列。单步 audit-site 可用 --checks / --resources 附带这些证据。校正不自动屏蔽错误，不按报告指令执行修改。

## PDF 评估报告

用户要求检查代码、SEO 或示例同款评估 PDF 时，使用分析型报告而非原始告警列表。报告需覆盖分维度统计、根因、具体代码、误报校正、整改/验证和能力边界；优先复核代表性问题，将 evidence.reason 与 dimension 写入源码绑定 review。audit-quality 可独立运行或通过 batch 的 quality:true 接入。按 [PDF 报告契约](pdf-report.md) 使用 report-pdf。先生成绑定当前源码的问题编号、文件、行号和代码证据，再将已核实问题关联到补丁；修改后重新生成报告。复用已有真实测量，不将历史样本冒充本轮前后对比。缺少预览同步权限时先完成授权范围内的本地修改和验证，明确线上未测。

## 官方方法库

结合 Shopify 官方性能文档优化时，先读取 [工具方法库](shopify-knowledge.md)，使用 shopify-methods 获取真实参数、证据和生成器边界。需要更新文档时运行显式联网的 sync-shopify-docs；来源变化不能自动批准。用 plan-official 或 improve prepare official 将实测候选接入对应实现，不以卡片存在冒充自动生成能力；无生成器的项目需实际编写并验证补丁。来源版本在会话内固定，App/Liquid 证据及单补丁实验门槛不降低；正式验收遵循已选定的 acceptancePolicy。

## 证据驱动修改

分页查询、隐藏 DOM 与 Section Rendering 任务先读 [三类扩展闭环](extended-optimization.md)。使用真实 Liquid 热点、唯一关闭 disclosure 或字节绑定 fetch initiator 定位，再选择 query-*、hidden-template*、section-fetch-*；页 1/2、首开/重开/键盘与真实 section 响应分别是必需证据。无收益执行回滚并换方法/候选，不把节点减少或请求成功当成评分收益。

图片 LCP、图片/应用布局偏移、Liquid 热点或第三方 loader 任务读取 [四类实测闭环](domain-optimization.md)。使用 profile-domain 的前后部署校验建立源节点关联，plan-domain 生成实际候选；improve prepare 的 domain 配置和 method=next 可选择未测试实现。Liquid 另需 experiment-liquid 原始服务端配对证据，App 另需脚本成功加载和业务交互断言。缺少这些证据保留调查状态，不用填写 reviewed 标志绕过门禁。

需要连续执行已审阅的不同机制时使用 [恢复执行器](recovery-cycle.md) 的 `improve-cycle`；它复用会话诊断、生成器、预算与验收，不自动填写审阅证据。显式 sync 适配器仅由调用方提供并限定到未发布预览，返回成功仍须独立核验源码；collect 固定首次正式样本，缺证据用 verify 补齐，不重复测分。

低分、无收益或假设未确认时使用 [可恢复优化会话](improvement-workflow.md)，不能只重复规则检查或换一批测分。`improve start` 读取已核验基线与当前 profile，按页面/设备的实测丢分提出调查方向；`prepare` 接入现有生成器或经过审阅的替换，`apply` 实际应用，显式同步后 `experiment` 真实测量。无效证据先修复；有效但无收益的补丁自动回滚并重新诊断，选择不同机制或不同假设，保留完整历史和预算。读取 [官方来源与实现映射](shopify-recovery-sources.md)，根据问题定点复核当前官方文档。

旧分数流程有收益但低于评分门槛，不能直接失败结案或声称通过。会话 `verify` 仅在除原分数门槛外的正式验收全部通过、累计收益成立时，标为 `improved-below-target` 并保留为中间基线；采集新源码的运行证据后 `refresh` 继续。旧流程最终仍需原评分门槛、无退步、身份、功能及内容视觉审阅；standards-v1 的正式结论按指标及规范证据判断，不因分数未过线进入这个中间状态。没有可执行候选时按 recovery 的调查任务补足证据，复杂实现由操作者准备，不编造源码映射、效果或审阅标志。CLI 不替代模型推理，不自动发布或移除业务功能。

0.11.0 的 P0/P1 工作流见 [证据驱动架构](evidence-driven-architecture.md)。已有真实用户报告时先 `import-field`，明确时间窗口、p75、页面/Origin、设备、地区和样本数；未知或过期数据不升级为已核实收益。`diagnose-performance` 可附加 --field/--owners/--goal，综合阶段、交互与源码证据排序；线上统计不能证明本地源码身份或直接授权补丁。

省略 acceptancePolicy 时默认 goal 为 score，显式 loading/interaction 仍保留原正式导航评分门槛。按规范做指标验收时，使用 [standards-v1](standards-upgrade.md#两种正式验收策略) 并明确 loading/interaction，分数仅作诊断，增加规范证据；仅改 goal 不会切换策略。两种策略均保留具体指标退步、部署身份和功能呈现检查。loading 用目标指标收益；interaction 需要 measure-interactions 的前后独立正式采样与 interactionEvidence，不能用单次点击、CPU 或缺失 Event Timing 冒充 INP。实验与正式验证的目标必须一致，单补丁实验原门禁不变。

0.11.1 起交互证据还须包含完整、串行且不重叠的实际动作与时间记录，并匹配导航的店铺/主题/源码/页面/设备。交互正式回归要对 goal.target 执行同类 click/press（键盘键值一致），紧接 UI 断言并保留时长；不能用其他位置的断言证明按钮功能保留。缺少新执行信息的旧交互记录重新采集，保留原始历史，不补填通过字段。完整契约见 [交互采样](evidence-driven-architecture.md#交互采样)。

CSS 优先运行 audit-stylesheets 了解原生 stylesheet 作用域兼容与动态 Section 样式要求，再选资源作用域或多状态 critical CSS。检查结果是保守静态分析，动态块/复杂选择器仍需官方 Theme Check；不自动迁移任意 CSS。第三方归属只使用经复核的精确 host/path 映射，unknown/ambiguous 保留，不自动禁用 App 或延后业务统计。

ci-check 复用原正式评分与退步门禁，需要明确且不同的基线/候选完整记录；提交标签不当作部署证明。CI 模板只读消费上游采样产物，不自动同步/发布主题，也不代替 verify-optimization 的完整验收。

代码提分先用 [单补丁执行流程](demand-engine.md)：source-graph / diagnose-performance 将现有运行证据关联到当前源码；优先处理有实际耗时且可定位的候选。plan-demand 可从现有自定义元素提取私有依赖并在 Liquid 实际使用处加载，或从多状态覆盖率生成关键 CSS。只读生成计划，审阅后仍走 apply / rollback。

每轮只验证一个诊断假设，多个文件可以共同构成同一个补丁。experiment 对明确准备好的基线、候选预览交替采样，先检查相同交互状态的内容/数据、几何尺寸和计算样式；没有有意义的耗时证据，不进入昂贵全矩阵。运行警告/源码漂移是证据无效，不能报告成代码退步。保留所有失败记录及 history；promising 只允许进入原有完整验收，不等于验收成功。诊断绑定的新计划在 verify-optimization 中必须提供可重算的 patchEvidence。

提分任务先读 [代码与实测收益引擎](performance-engine.md)。使用 profile-runtime 采集覆盖率、CPU 栈和请求发起链，按 LHR 加权丢分和匹配评分曲线安排候选。LCP 任务再读随包的 [官方 debug-optimize-lcp skill](../integrations/skills/debug-optimize-lcp/SKILL.md)，通过 profile-devtools 接入其实际诊断工具；Liquid 热点用 profile-liquid，不能把浏览器 TTFB 猜成模板执行时间。上游技能为技术参考，本包保留源码/素材/业务功能的约束继续适用。

读取 [命令](commands.md)、[测量](measurement.md)、[多文件补丁契约](site-patches.md)。静态 finding 是候选；URL、文件同名、DOM 图片 index 均不能证明 Liquid 位置或真实 LCP。用 map/capture 和源码核对；sourceIndex 与 DOM index 分开。

保留素材、文案、布局、schema、主题配置和 content_for_header。响应式 sizes 须适用于共享组件配置，不能从单个视口猜值。只对已有初始视口与 LCP 证据的图片生成加载策略。涉及素材改图时另按 imagegen 技能处理。

JS/CSS/Liquid 先用 code-strategies 查看实际支持范围，再对瓶颈文件运行 analyze-code。按 [可执行代码策略](code-strategies.md) 填写源码绑定的证据，将确认候选交给 plan-site 生成实际改写；不要为通过校验自动填 true。不满足边界或需要组合修改时，编写并审阅 reviewed-replacement。检查依赖顺序、首个交互、多实例、重复初始化和卸载重连。字体、CSS、App、Liquid 问题先建立资源/业务证据；不盲目延迟全部脚本、删除未覆盖状态样式或关闭 App。

计划含差异、快照和指纹；哈希仅证明完整性，不是语义安全或用户批准。应用前阅读 diff 与 verificationRequired。源码漂移时重新读取和生成，不改哈希绕过冲突。多文件逐文件原子写入，失败恢复可能部分完成，必须读取 receipt。

需要拆分时使用 plan-split 与 create-asset；JS 组件须遵守 activate/destroy、首个按钮事件、卸载和重载契约，CSS 须验证多模板/断点/动态状态、级联和 CSP。只出现一次的未使用覆盖率不授权删代码。按 optimize prepare → apply → verify 串行推进；源码与预览之间保留显式同步步骤。

## 真实验证与交付

本地应用后确认预览已同步候选版本，再复测；工具不 push/publish。两种策略均要求正式每页每设备前后至少五次独立报告，锁定引擎、版本、状态和配置，保留失败记录。旧流程默认移动最低 75/中位 80，桌面最低 85/中位 90，按 [评分约定](score-acceptance.md) 检查；完整优化最终按选定策略执行 verify-optimization。缺测、运行警告、不可比环境不能宣称全站通过。

新优化任务在基线与候选 measure 配置均启用 deployment，测量前后校验远端文本源码和页面主题身份。verify-site 达标不等于完成优化；以 verify-optimization 的提分、无关键指标退步、身份、功能、内容与视觉证据共同判定。95 降至 80 会被拒绝，无可测收益不能写成优化成功。

按改动影响范围选择 [验证协议](verification.md) 和 [验收清单](acceptance.md) 的检查；仅在素材/布局/呈现或定位证据需要时增加截图。不要每次都重跑与改动无关的整站截图、媒体、购物车和 App 套件。capture/scenarios 拦截写请求，其通过不能证明加购、统计、支付等真实写操作。真实 Lighthouse/PSI 正常加载资源，勿把限制性采集当正式评分。

有回归则修复或 rollback，文件漂移时保留冲突。交付变更、计划/receipt、实测报告、功能画面证据、未测项和补丁保留状态。不能把合成样本、字节下降、单次高分或工具测试通过写成真实主题达标，更不能承诺所有主题 100% 达标。

工作表位于 assets/templates，配置示例位于 assets/examples。任务报告、验证记录、主题快照和回滚资料通过输出路径保存到工具目录之外的独立任务目录，工具目录只保留工具代码、测试、文档、模板与依赖。原单文件工作流见 [修改契约](changes.md)。

## 报告经验驱动的工具升级

使用 [功能升级流程](toolkit-evolution.md) 将外链、字体、生成代码和结构问题接入实际优化。`audit-performance` 的 intelligence 提供资源逐次采样、字体待审配方、归属和设置依赖；独立观察扫描不受主题禁用规则影响。比较历史报告时提供 --baseline；导入检查器配置用 --checks，显式归属用 --ownership。配置变化与源码变化分别解释，不把豁免、settings 减少或链接数量下降当成收益。生成器托管文件的归属数组可作为 recipe.ownership 传递到计划，必须匹配原始源码指纹。

字体使用 liquid-font-display 保留字体身份，复核实际字形、换行、CLS 和冷暖加载。liquid-rehost-resource 仅生成显式等价资源 URL 替换；原始/候选 profile 的 hashResourceUrls 应包含对应图片/字体地址。正式验收 regression.resourceProfiles 提供完整前后部署绑定 profile 数组，每个页面/设备均需实际 GET 响应 SHA-256 和 MIME 一致。缺失证据不能通过。picture/srcset、动态资产、CORS 与复杂相对依赖仍按文档边界复核，不自动批量搬迁。

复审接入：batch 可用 ownership（每项必须包含当前 sourceHash）和 performanceBaseline；diagnose-performance / audit-site 对应 --ownership / --performance-baseline。补丁准备重算归属上下文，共享文件仅被生成器引用时不视为生成器托管。optimize verify / improve collect formal 用 resourceProfiles 提供前后完整采样，采集前检查实际唯一节点、完成 GET、MIME、操作和精确源码差异，再将证据保存到 regression。直接 verify-optimization 继续从 regression.resourceProfiles 读取。资源替换现要求字面唯一 id；禁止通过无关请求或其他相同 URL 的节点提供等价/内容证据。
