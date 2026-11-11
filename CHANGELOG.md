## 未发布 — 2026-11-11

- 完成第二、三批规范对齐：显式 standards-v1 指标验收、真实项目 Theme Check 差异门禁、按范围的证据清单；旧策略默认保持，新增策略要求部署绑定的完整性检查。
- 新增八项有范围边界的浏览器观察，性能规则共 39 项；HTML 首先给出要修/待确认/未测，新增提议的 PageOtter handoff v1 导入与严格同范围前后对比。
- 统一诊断复用请求内源码索引并逐次核对内容指纹；修复 CSS AST 循环引用克隆和移动端布局视口溢出识别，增加真实 Chrome 与已安装 Shopify CLI 验证。
- 新入口与兼容边界见 references/standards-upgrade.md；规范登记仍是待评审参考，不自动成为部门政策。

- 修复 CrUX 聚合 p75 因无样本总数而遗漏阈值告警与诊断优先级；新增阈值/样本/趋势资格字段，保留旧 limited 状态及严格趋势、窗口边界。
- 正式验收新增 PASS / FAIL / NOT RUN / N/A 检查结果，缺失证据与已执行失败分别报告；旧 checks.pass、验收策略及退出语义保留。
- 固定 130 条待评审规范元数据及来源指纹，为现有 31 项性能检测增加规范编号关联和报告展示；映射不等于完整覆盖或启用规范门禁。
- 新增隔离回归测试，说明见 references/standards-foundation.md。

## 0.20.0 — 2026-11-09

- Added content-addressed release/validation manifests and explicit delivery-v1 policy without weakening legacy performance gates.
- Added source-bound theme capability adapters, stale-context rejection, reviewed strategy contracts and raw external business verification.
- Extended existing scenarios with fill/select/Chromium IME and bounded GET fault injection; writes remain blocked.
- Extended resource budgets with explicit observation windows and ownership/component deltas; added incremental engineering policy audit.
- Added approved field-export monitoring, bounded scheduling, release/window-aware trend reports and local alerts.
- Added reusable lifecycle, scoped Section style and queued Cart protocol primitives with isolated positive/negative/recovery fixtures.

# 更新记录

## 0.19.0 · 2026-11-08

- 运行采集增加实际 LCP 元素可见性/尺寸/文字与祖先样式、显式期望 selector、同文档请求上下文和有界初始化事件日志。
- 新增 audit-runtime-integrity，识别 LCP 身份异常、重复脚本/样式请求和重复初始化信号；不将请求等同执行，不用缺证据换通过。
- 接入性能审计、诊断与 HTML 报告；显式 integrityProfiles 可在 optimize / improve / verify 中要求部署绑定的完整性验收。
- 沉淀视频分流、关键 CSS、统一延迟调度与组件生命周期方法；保留 content_for_header，排除指标对象污染。
- 操作或 trace 采集失败时保留已捕获请求，并标记网络窗口不完整，避免把丢失证据误判为无重复。
- 增加单元、CLI、正式证据合同和真实 Chrome 合成回归。SEO 包只同步发行版本，没有新增 SEO 规则。

## 0.18.0 — 2026-11-06

- 修复 Shopify CLI 5 检查环境变量互斥；兼容两代 JSON 结构，核验计数及坐标，保留原始诊断和独立入口失败证据。
- audit-quality 展开 JSON settings/custom_css 的内嵌代码，保留 JSON Pointer、解码行号、祖先禁用状态、业务逻辑候选和解析边界；报告不把配置存在当实际执行。
- 新增 theme-diff：主题文件哈希、增删改、JSON 字段变化与内嵌代码定位，检测源码漂移，禁止把字节变化或静态清零称为性能收益。
- 原有评分、五样本、部署身份、功能/视觉与回滚门禁保留。SEO 包同步发行版本，未新增 SEO 功能。

## 0.17.0 — 2026-11-06

- 全面复审：只读依赖改为按原始字节验证，真实主题的 settings_data.json、图片和字体不再被误当作修改目标；保持源码写入权限限制。
- SEO 补丁按所选规则核对 AST，保留业务正文、资源地址、Liquid 控制流及原生脚本/样式；拒绝以动态 JSON-LD 隐藏静态解析失败。补齐空语言、大小写元数据、无 href canonical 的自动修复。
- SEO 复核结束再次确认真实源码；存储失败仍执行还原，部分写入冲突明确报告，CLI 在写入前检查回执目录。
- 自定义性能计划经旧 plan 路径仍锁定方法身份并重验语法；失败历史记录实际专项机制，不能用 custom 名称绕过。增加 content_for_layout 保护及最大关联文件请求往返验证。
- 新增自定义补丁正式通过/缺证据拒绝/正式回归回滚测试，并提供真实 Chrome + Lighthouse 的 `validate_improvement_pipeline.mjs --custom` 隔离链路验证。

- SEO 新增 plan/fix/apply/verify/rollback：自动元数据修复、业务源码候选、前后规则复核、完整指纹与失败回滚；只验收源码变化，不推断线上排名。
- 提取共享源码写入器，沿用性能补丁与回滚行为；SEO 仅增加 Shopify Liquid 解析器依赖，不引入测量引擎。
- 性能新增 request-implementation / plan-custom 和 prepare implementation，自定义代码绑定当前诊断、源码与会话，继续实测、无收益回滚及原正式验收。
- 补充真实文件写入/还原、漂移、篡改、误修、独立 CLI 与安装回归测试，更新两套技能工作流。

## 0.16.0 — 2026-11-06

- 拆分复审：排除源码 SVG、template、noscript 中的页面元数据及惰性图片误报；旧综合审查复用同一修正规则。
- SEO 报告校验覆盖状态、布局清单、观察归属及截断详情数量；等价 JSON 字段顺序不再导致拒绝。
- 依赖测试覆盖全部共享模块并禁止反向导入产品层；双包发布前同时检查性能与 SEO 锁文件版本。

- 第一轮 SEO/性能拆分：新增独立 seokit CLI、Skill、源码/保存 HTML 审查、无测量依赖的批处理及 HTML/PDF 报告。
- 提取公共源码遍历、读取/指纹、HTML 词法、进程和报告转义；旧 audit-quality 与新 SEO 入口共用同一规则实现。
- HTML 按规则组先筛选再截断，保留完整计数；SEO 来源与覆盖契约拒绝伪造干净汇总及线上验收结论。
- 旧 perfkit 命令、报告、评分门槛、补丁、回滚及会话继续兼容。SEO 首版只读，不新增主题写入器。
- 新增显式双包构建与独立安装验证，SEO 无 npm 运行依赖，两个 ZIP 均自包含；补充反例、架构边界与打包回归。

## 0.15.1 — 2026-11-03

- 修复 batch 多份 renderedHtml 共用 transport 文件导致第二项失败；逐项记录、已完成数量与失败/超时范围独立保留。
- 将渲染后 HTML 审查数组贯通 batch → audit-site CLI/直接调用 → 最终 HTML 报告，展示具体问题并保留 unverified-source 关联边界；不混入源码候选或性能评分。
- 校验保存的 HTML 审查计数、状态、输入指纹和来源声明，拒绝伪造干净汇总及部署验证结论。
- HTML 标准库辅助进程继承批处理监督组，避免超时后脱离总预算继续运行；其他子进程默认分组行为不变。
- 快照拒绝用 null 掩盖适用表单状态及无效布局，保留旧版本兼容和自定义元素状态；补充正式验收阻断、源码恢复及漂移冲突测试。
- 整站工作流、代码审查和验证协议接入 HTML 与购物交互矩阵；原独立五样本、评分/退步、部署身份、功能视觉及回滚机制保留。

## 0.15.0 — 2026-11-03

- 在既有 checkpointDOM / verifyPreservation 中增加 version 2：运行时表单约束、indeterminate、多选项、祖先实际禁用、open/inert、焦点及滚动；混版、缺字段、环境不一致拒绝验收。version 1 历史比较保留并显式标注有限覆盖。
- 新增标准库 HTML helper、`audit-html` CLI、batch `renderedHtml`、HTML 报告与有界摘要；输入绑定原始字节 SHA-256，重复 ID/元数据/图片/样式表/JSON-LD 问题单独报告，不充当源码身份或性能验收。
- 增加购物交互场景和请求边界，明确 IME、乱序、写入成功但 UI 失败、重复写入等测试，以及现有工具未自动执行的范围。
- 主 SKILL.md 按任务读取；既有专项约束迁至 references/task-workflows.md，沿用单 agent、预算、五样本、评分/退步、部署、功能视觉和 apply/rollback 保护。
- 保留 GitLab 套件固定来源和 MIT 许可；未导入品牌设计规范或替换测量/回滚引擎。

## 0.14.0 — 2026-11-02

### 新增能力

- 统一诊断与恢复候选排序，区分可执行补丁与待补证据任务；不直接比较不同机制的毫秒成本，耗尽策略不再显示可执行。
- `audit-performance` 汇总逐采样资源成本、健康覆盖、字体待审配方、归属与结构依赖；支持 `--baseline`、`--checks`、`--ownership`。batch、audit-site 和 diagnose-performance 已传递对应证据并更新报告/摘要。
- 新增 `liquid-font-display` 和 `liquid-rehost-resource`；通用代码策略由 19 项增至 21 项，沿用确定性重放、差异审阅、apply/rollback。
- 准备补丁时重新分析生成代码上下文；显式归属必须匹配当前 sourceHash。区分生成器托管与被生成器引用的共享文件。
- Liquid AST 分析 settings、别名、动态访问和精确 visible_if 引用，分别统计 section/block；不自动删除设置或将结构变化认定为性能收益。

### 修复与验收

- 资源等价证据贯通 optimize / improve collect → regression → verify，测分前验证完整 GET、唯一真实节点、MIME 用途、操作记录、源码差异与部署身份。
- URL 内容比较豁免仅适用于指定节点；拒绝重复 id、picture/模板/循环上下文和用途不明确的 preload。多页面矩阵允许完整证据证明未受影响的页面，但每项替换至少需要一个受影响页面的响应等价证据。
- 图片解码有界等待；选源变化、解码超时、空/缺版本快照和采样截断保持未知。不完整观察不能用于可比基线。
- CPU 和引用在重复请求间只计一次，使用原始 URL 关联后再脱敏；配置引用保留 JSON 路径，不伪造行号；识别编译后的 .js 与 .js.liquid 资产关系。
- 修复保存采样在批处理末端丢失、字体调查任务未进入工作流、豁免信息被观察差异遮盖等接入缺口。
- 恢复闭环保留正式证据固定、补证续跑、预算结算和异常恢复保护。

### 升级与边界

- 观察契约升级为 version 2，旧观察报告需重新建立基线；不要给历史报告补填当前指纹。
- ownership 输入新增当前 sourceHash 要求；资源替换配方需唯一字面 id，旧采样缺少节点/请求/范围证据时重新采集。
- `optimize verify` 和 improve collect 的 formal 配置支持 resourceProfiles，直接 verify-optimization 使用 regression.resourceProfiles。
- ZIP 是源码发行包，包含 lockfile、文档、测试和配置示例；不包含 node_modules、测量报告或其他发行包。解压后运行 npm ci --ignore-scripts。
- 原评分、独立测量、功能及视觉门槛保留；本版发布检查不等于商家主题性能验收。

## 0.13.0 — 2026-10-26

- 将主题性能八步流程接入诊断和恢复结果，区分资源正确性、可执行候选和正式收益。
- 新增成对 stylesheet-once、隔离作用域的 liquid-collapse-forwarder、带 render 的 query-limit-render；固定共享依赖并重放变换与 DOM 差异。
- 新增受限 JS Liquid 资产的配置值/静态 AST 归因、源码坐标和三种实际 JS 补丁，拒绝不支持的动态模式。
- 新增坏图补丁与实际解码/批准响应哈希验收；修复后重建内容基线，禁止冒充性能收益。
- 修复同设备多页面恢复证据串组、主题脚本误归 App、CSP 下隐藏控制器未运行却可能通过、分数空间不足仍试补丁等问题。
- 按机制与相关源码/依赖/交付上下文记住负实验；新增交互样式成本候选和相关 API 文档漂移门禁，原独立收益及分数门槛保持不变。
- 增加真实 Chrome、输出等价、依赖漂移、无收益与固定 Lighthouse 样本验证。商家主题实测待提供源码及未发布预览，不声明店铺提分。


## 0.11.1 — 2026-10-20

- P0/P1 二次审计收紧交互验收：核对计划次数与失败记录、串行不重叠的完整捕获、源码完整性、trace 状态、实际完成的动作及其目标/时间窗口、合法 Event Timing 阶段和页面重定向；缓存与 Service Worker 状态必须符合独立采集契约。
- 单补丁、正式优化和 CI 的交互证据同时匹配前后导航的源码、店铺、主题、页面与设备；诊断假设绑定具体元素/事件，避免复用其他交互目标或部署的收益。
- 完整交互验收新增目标操作紧接 UI 断言的门禁；scenarios 支持 press，并将键值、动作到断言的时长纳入保留性检查，补齐键盘目标回归能力。
- 线上数据排序匹配元素范围和实际存在的指标，交互候选保留页面/设备差异；CSV 空白指标保持缺失，可显式导入 target；未知 CrUX 设备不扩为 all。CLS 诊断按严格 1 秒间隔/5 秒窗口分段并排除近期输入。
- 补漏洞复现、正常采样、目标 UI/键盘、部署错配及原评分回归；原默认 score、正式样本数、75/80 与 85/90、指标退步与内容视觉要求不变。旧交互证据缺新增执行信息时重新采集，不补造历史字段。

## 0.11.0 — 2026-10-19

- 落地 P0/P1 证据驱动架构：规范 RUM/CrUX JSON、汇总 CSV 与已有 field-evidence 导入，保留时间窗口、p75、设备/地区/URL范围、结构化输入哈希和未知计数；过期/低样本不升级为已核实证据。
- diagnose-performance 增加统一阶段、交互 CPU、源码身份、线上影响范围、原生样式兼容与审阅式第三方归属分析；未知关键路径、动态依赖及 App 归属继续显式保留。接入 CLI、batch 与 HTML 报告。
- 增加 loading/interaction 声明目标，连接单补丁与正式验证；默认 score 的原收益规则、正式至少 5 次、移动75/80、桌面85/90及全部退步/身份/功能呈现门槛保持不变。
- measure-interactions/verify-interactions 提供独立上下文重复采样、原始文件哈希、部署前后核验、可比性/预算/失败保留与 Event Timing 目标收益；运行采集补充目标、FCP 和 Long Animation Frame 线索，不宣称线上 INP。
- audit-stylesheets 保守检查同文件、render 祖先及多调用者的作用域依赖；复杂块/动态类/选择器保留待复核。attribute-apps 用明确 host/path+依据归属，不按 CDN 域名猜测或自动关闭 App。
- 新增只读 ci-check 与主题仓库 reusable workflow 模板，复用原导航评分及退步门禁，缺失/不可比基线不通过；保留独立完整优化验收。
- 增加配置示例、架构与实施文档、离线协议/CLI/batch/CI 及真实 Chrome 交互回归。未实施 P2 在线监控/A-B/缓存加速，未修改或发布实际店铺。

## 0.10.0 — 2026-10-19

- 新增源码依赖图和耗时诊断：追踪模板、section、snippet、资源与 JS import；脚本正文或 AST 匹配支持格式压缩和静态内联脚本行列定位，保留动态/歧义引用。导航与交互 CPU 分开，按 self time 筛选候选，不累计重叠 inclusive 耗时。
- 新增 plan-demand：从经典脚本的自定义元素中提取类、私有函数和常量，拒绝共享状态/外部消费者/动态作用域；同时检查全局引用、Liquid 内联脚本及事件属性，在实际 Liquid 使用处加载，支持后续 section 插入。多设备及交互 CSS 覆盖率合并后生成关键样式，保留原完整样式与 noscript 回退。
- 新增 experiment/verify-patch：一个假设、一个代表页面/设备，验证源码只有该补丁；交替前后采样，整轮前后核验两个预览身份，保留失败、预算和候选历史。区分无效证据、无收益、性能/功能回退和 promising；原正式验收门槛不变。
- scenarios 增加源码绑定 checkpoint，比较内容/媒体引用/表单值、几何尺寸、计算样式及相同交互断言。诊断绑定计划的正式 verify-optimization 必须重算单补丁证据，不能只填通过标志。
- 新能力接入 CLI、batch、技能入口、配置示例及隔离浏览器回归。无素材下载、主题同步或发布动作。

## 0.9.0 — 2026-10-19

- 新增性能收益判定：保留 5 次正式样本与移动 75/80、桌面 85/90；增加分数及 LCP/TBT/CLS/FCP/SI 退步拦截、噪声带、候选身份与回归证据。达标和完成优化分别报告。
- 新增独立 Chrome CPU/trace、JS/CSS 覆盖率、请求 initiator 和正文哈希映射；CDN 同名不再作为源码已确认的依据。按指标加权丢分与匹配版本的评分曲线排序。
- 接入固定版 Chrome DevTools MCP、官方 LCP skill、Playwright Core、Shopify Liquid HTML parser；支持 Shopify CLI Liquid profile 和 Speedscope 导入。只使用已有浏览器，不额外下载媒体。
- 可执行代码策略从 4 项扩展到 10 项，补脚本 idle/defer/页面作用域、字体显示/回退度量、循环过滤缓存；新增 CSS 拆分及 activate/destroy 契约组件首次点击加载，支持去重与编辑器卸载重载。
- 新增 create-asset 计划类型及新文件预检、独占创建、漂移保护、回滚；保留 schema、配置和 content_for_header 保护，使用官方解析器验证独立资源标签不改变保护输出上下文。
- 新增 optimize prepare/apply/verify，连接待审计划、本地应用、显式预览同步、探索与正式实测、功能回归。测量前后可拉取指定主题的文本源码核验，临时目录自动清理；不推送或发布。
- batch 接入运行剖析、Liquid/DevTools、待审 recipe，探索样本也进入审计；保留报告导入、误报校正、外链/脚本、SEO、PDF、预算与原验收标准。
- 增加收益/身份/创建回滚/解析转换/批量链路测试，以及真实 Chrome 覆盖率、CPU、请求映射、首个点击、重复初始化、卸载重载和官方 MCP 集成回归。测试产物位于临时目录。

## 0.8.0 — 2026-10-16

- 将 PDF 从告警列表改为分析型专项评估：统计、分类根因、源码示例、隐藏架构、SEO、整改路线、回归、覆盖矩阵与规则附录；完整记录保留在 JSON。
- 新增 audit-quality：布局引用闭包的 SEO 声明/静态值检查、JSON-LD 解析，Acorn 生命周期候选，PostCSS 规则/字体/作用域统计，以及嵌套、重复配置、样式和可访问性检查。
- 映射示例规则与现代 Theme Check，明示自有启发式的差异；动态 Liquid 解析缺口、平台输出与运行检查不冒充通过。
- 加强误报边界：JS 字符串不作 HTML、父类清理不误报为本类无清理、密码布局不套公开页 SEO、Schema 缩进、注释与尾逗号兼容、检查器扫描全文件哈希核验。
- 修正 asset_url 的 非二进制 `.liquid` 资产（含 CSS / JS / SVG） 源文件解析，避免把 Shopify 编译资产误报为缺失。
- batch 支持 quality:true，保留原有诊断、导入、外链和评分验收标准。主题文件不因生成报告而修改。
- 按用户要求清理所有生成的报告、验证快照、主题回滚资料及发行包，只保留最新工具源码、测试、文档、模板与依赖；后续任务数据使用工具目录之外的独立输出目录。

## 0.7.0 — 2026-10-16

- 新增 report-pdf：参考报告的 A4、蓝色标题、灰色表头与红色差异样式；输出 PDF 和完整 JSON。
- 扫描源码、整合规范报告与资源依赖，为条目绑定问题编号、文件、行号、代码摘录和哈希；历史漂移保留并标注，人工条目拒绝错误位置/哈希。
- 支持同契约基线差异、真实测量样本/警告/失败展示；不会自动测分或把报告数量当作收益。新增源码绑定、输出保护、中文长文档渲染测试。
- outdoor 使用新命令生成报告并按编号生成本地补丁；线上同步因 CLI 登录不可用，按用户选择完成本地代码与验证，未宣称分数提升。

## 0.6.0 — 2026-10-16

- 新增 code-strategies / analyze-code，以及真正生成源码补丁的四项策略：JS scroll/resize 合帧、CSS 相邻相同声明去重、显式屏外区块渲染、Liquid 受限输出循环改写。
- 接入原 plan-site/apply/rollback：AST/语法结构校验、来源哈希、显式审阅证据、生成器重放校验及源码漂移保护；不支持的代码模式拒绝自动改写，保留 reviewed-replacement。
- 锁定 Acorn/PostCSS 运行依赖及 LiquidJS 测试依赖；补齐 CLI 和多文件应用/回滚测试、事件执行与卸载测试、Liquid 实际渲染对比。
- 本地真实 Chromium 验证事件合帧及 390/1440px CSS 内容、几何与聚焦。初测暴露外边距折叠问题后，屏外策略收紧为已有 display:flow-root 的布局边界并复验通过；测试不下载远程素材。
- 保留报告导入、误报校正、外链/脚本依赖、batch、预算与原正式评分门槛。本次工具验证不代表实际店铺分数提升，未修改或发布 outdoor。

## 0.5.1 — 2026-10-16

- 工作流修订：默认以实际主题代码补丁和分数收益为目标，复用有效基线，先验证受影响页面再正式验收；区分只读检查与优化任务。
- 代码优化不额外下载图片/视频素材；截图与业务回归按改动影响选择。明确正常测分资源请求、截图文件与素材下载的区别，保留真实加载及原验收门槛。本次为技能流程修订，CLI 行为与版本号不变。

- 串行整合报告接入与执行预算两组更新；合并重复的 0.5.0 更新记录。
- batch 接入 checks.input / metadata / baseline；提供 project 时默认生成离线外链、脚本依赖 JSON/HTML，可用 resources=false 关闭，probe=true 才联网。
- 两种诊断自动附入 audit-site，保留校正前告警、源码漂移和未完成状态；reviewRequired 独立于评分，需复核时 batch 返回 3。
- 新阶段共用剩余时间预算，超时保留已完成证据；原单 agent、紧凑摘要、候选早停和正式验收门槛不变。
- 增加完整串联、配置兼容、源码漂移、诊断失败、预算中止及评分隔离回归测试。工具夹具不代表实际店铺验收。

## 0.5.0 — 2026-10-16

- 新增 import-check：原生 Theme Check JSON 与人工提取报告陈述接入、源码绑定、原告警保留、有限校正和同口径增量门禁。
- 新增 audit-resources：外链去重、引用位置与域名分类、可选受限 HEAD 探测、script_tag / classic / defer / async / module 分类、顺序和显式全局符号依赖候选。
- audit-site 可附带两种补充报告，识别源码漂移；HTML 单列规范、资源与性能证据，不把告警下降计作性能收益。
- 新增隔离测试、PDF 汇总导入验证和报告预览。没有重新扫描实际 WOLFBOX 主题，也没有发布或修改店铺。

- 增加 batch：一次调用串行测量、精简摘要、可选审计/验收/HTML，完整原始证据留盘。
- 默认单 agent 执行约定，CLI 默认有界摘要、measure 默认 quiet，保留显式完整输出和进度开关。
- 增加时间、尝试、失败、候选轮数预算；外部模型计量可选，缺失/回退时 fail-closed，不冒充账户实时计费。
- 增加探索 purpose、候选历史与低收益/负向/受限证据早停；探索不能用于正式验收。
- 正式每页设备前后至少5次、移动75/80、桌面85/90及警告/可比性规则保持不变。
- 执行预算功能使用离线合成夹具验证；发行前另完成工具级浏览器集成回归。未运行实际店铺 Lighthouse/PSI 验收。

## 0.4.0 — 2026-10-16

- 补齐整站 scan、map、scenarios，合并已安装 v0.3 能力到本项目源码；安装目录未覆盖。
- 新增 measure：锁定 Lighthouse 13.5.0，支持本地 Chrome 和 PSI，串行运行页面/设备矩阵，保留原始报告、失败与超时记录。
- 新增 audit-site：关联源码、LCP、主线程、第三方与机会证据，明确候选关联及非累加估值。
- 新增 plan-site 多文件计划、指纹预检、应用/回滚、失败恢复 receipt；支持图片策略与已审阅 JS/CSS/Liquid 候选。
- 新增 verify-site：完整矩阵及报告证据校验，逐组执行移动 75/80、桌面 85/90 门槛。
- 加入配置示例、完整使用流程、依赖 lockfile，以及隔离主题前后 40 次真实 Lighthouse 测试脚本。
- 本版工具测试与隔离样本不代表用户实际主题已经达标；真实店铺与实时 PSI 服务另行验收。

## 0.1.1 — 2026-10-16

- 合并工具源码和历史验证资料为同一项目；原 116 个验证文件及 v0.1.0 ZIP 完整保留。
- 增加项目 README、主题优化流程和评分验收约定。
- 增加 `score-target`：从真实 Lighthouse / PSI 报告识别设备，默认移动端最低分 75、中位数 80，桌面端最低分 85、中位数 90；报告无效、环境证据不足、未达标或存在运行警告时返回非零退出码。
- 增加发行包白名单和构建命令，防止将验证资料和历史 ZIP 重复打入工具包。
- CLI 显示 `package.json` 中的版本；原图片、组件补丁算法保持不变。
- 修复通过符号链接或 macOS 临时路径别名启动时 CLI 未执行命令的问题，增加入口回归测试。
- 本次未测量实际主题分数，没有已达 75–80 分的结论；历史 0.1.0 报告不作为 0.1.1 的新测试结果。

## 0.1.0 — 2026-10-13

原始单图与组件性能工具包，包含诊断、采集、补丁、回滚、报告和 Lighthouse 导入。原始发行包位于 `releases/`，历史验证材料位于 `validation/2026-10-13-v0.1.0/`。
