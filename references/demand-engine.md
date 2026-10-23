# 源码归因、按需加载与单补丁实验（0.10.0）

当前本地主题是分析与修改基准。复用已有有效运行记录；只在诊断缺少对应页面/状态时补采集。远端预览用于核验明确候选。图片、视频、配置、文案和排版保持原状，不屏蔽 App/资源制造分数。

## 1. 源码与耗时关联

```sh
node scripts/perfkit.mjs source-graph --project /absolute/theme --out /absolute/task/graph.json
node scripts/perfkit.mjs diagnose-performance --project /absolute/theme --profiles /absolute/task/profiles.json --out /absolute/task/diagnosis.json
```

profiles.json 是保存的 profile.json 绝对路径数组（最多 24 个），也接受完整对象。可选 --run 导入已有完整 Lighthouse run，--liquid 导入 Liquid profiler 结果。这两个命令不访问店铺、不修改源码。

图解析模板 JSON、Liquid render/include/section/sections/layout、asset_url 和静态 JS import；支持由 Liquid asset_url 定义的无歧义 Shopify importmap 别名。动态/作用域 importmap、动态引用、解析失败及缺失文件单列，不猜测完整可达性。运行配置的源码快照必须仍与当前源一致。

profile-runtime 通过 CDP scriptId 关联 CPU 帧：外部 JS 正文一致，或完整 AST（不含注释/位置/raw 拼写）一致时映射到本地 token 行列；静态内联脚本映射到 Liquid 的具体行。变量改名/语义转换、动态 Liquid 脚本和多个相同内联片段保持 unmapped/ambiguous。字符串同名、CDN 域名及 document URL 不能证明本地归属。

导航 CPU 与交互 CPU 分开。诊断保留 selfMs、inclusiveMs、运行调用栈及静态引用路径；只使用 selfMs 排序，不相加重叠父子耗时。默认导航 self CPU ≥50ms、已定位的阻塞资源请求 ≥100ms 才进入可操作候选，默认最多 3 项。请求时长不是可节省时间，也不能直接换算分数；大量同等候选需要按实际关键路径复核。未定位的外部脚本和低收益线索仍保留在 observations。

CSS 也可按完整 PostCSS 结构一致性关联格式压缩后的响应，并将观察范围映射成对应本地整条规则；变量值、选择器等改变保持未关联，不猜偏移。LHR 有警告时单列问题。没有对应正文证据的 LHR URL 不提升为源码已核实。旧版同时记录交互的 CPU profile 不用于证明首屏 CPU。Liquid profiler 的文件/行匹配仍需独立部署证明，保留原 analyze-code / plan-site 的缓存纯过滤器等策略；这里不把导入的旧服务端采样自动升级为已核实源码。

## 2. 生成实际代码补丁

```sh
node scripts/perfkit.mjs plan-demand --project /absolute/theme --config /absolute/task/demand.json --diagnosis /absolute/task/diagnosis.json --out /absolute/task/plan.json
node scripts/perfkit.mjs apply --project /absolute/theme --plan /absolute/task/plan.json --out /absolute/task/apply.json
```

plan-demand 必须选择 diagnosis.candidates 中的 candidateId，绑定整个源码快照、具体文件/行和一个性能假设。先审阅生成 diff，再应用；已有授权可继续，无需重复申请同一操作。所有变化共用原 apply/rollback 的逐文件预检、哈希与漂移保护。

### component 模式

配置见 [demand-component.json](../assets/examples/demand-component.json)。输入现有经典 JS、元素名和新资产路径，工具实际提取类声明、注册调用及闭包内私有函数/原始值常量，在所有静态 Liquid 使用处插入 defer 脚本。无组件的页面不请求该组件资产；重复实例只注册一次。原全局脚本保留一个轻量桥接，处理后续 HTML section 插入的 inert script，支持 section load 和已注册元素重连。

支持边界：单个顶层 customElements.define('tag', LocalClass)，本地 class extends HTMLElement；无 imports/exports、共享可变状态、其它消费者、动态作用域、静态/computed 类初始化或 currentScript/document.write。检查包括剩余脚本的全局/字符串引用、其它 JS/JS Liquid 资产、Liquid 内联脚本及事件属性。含这些依赖或疑似动态消费者时保守拒绝，不凭布尔 review 字段跳过依赖分析。已有使用范围可能是动态生成的主题需要 reviewed-replacement。原组件的 connected/disconnected 实现保留，工具不声称自动修复它已有的生命周期缺陷。

初始 HTML 脚本由浏览器按 defer 加载，不拦截或伪造第一次点击。动态插入一个此前未加载的组件需要等其资产就绪：必须验证最早业务操作可用性、CSP、编辑器和 Section Rendering API；不能用“最终截图一致”代替首次操作验收。不支持的复杂模块仍可使用原 plan-split 的 activate/destroy 契约。

### critical-css 模式

配置字段：schemaVersion:1、mode:"critical-css"、source、newAsset、loaderTarget、tagStart、candidateId、inlineLoadHandlerAllowed:true。同时用 --profiles 提供匹配当前 CSS 正文的覆盖率。需 mobile/desktop 两种设备及至少一个实际交互状态；每个声明状态都必须包含该 CSS。状态矩阵的代表性仍需针对主题选择。

合并这些状态的使用范围，按 PostCSS 顶层规则提取关键样式，保留字体、关键帧和自定义属性。不足 20% 源码字节缩减时拒绝生成。支持普通 link rel=stylesheet + asset_url，以及 Shopify `asset_url | stylesheet_tag`（可选 preload:true/false）；预加载提示仅保留给关键样式。拒绝其它特殊属性、@import/@layer/@namespace/@charset。必须确认站点 CSP 允许 onload 属性。

新关键样式先加载，原完整 CSS 原样通过 print/onload 延后加载并提供 noscript 回退。这样保留最终完整层叠，而不是将“单次未使用”代码删除。需要检验首屏、中间加载阶段和动态状态，避免闪烁或首次交互缺样式。20% 是生成门槛，不是提分承诺。

## 3. 自动内容/排版回归

scenarios 配置支持 project（绝对路径）及 expectedThemeId。在既有场景中加入：

```json
{"action":"checkpoint","key":"menu-open","selector":"#MainContent"}
```

checkpoint 最多读取 5000 个元素，记录文本、媒体引用、链接/表单/ARIA/data 属性、控件值、位置/尺寸与固定计算样式，不下载媒体。元素更多时选更小的组件。基线/候选配置必须有相同动作、显式 assert-* 和对应 checkpoint。点击优先场景保留首次点击前不截图的原约定。

verify-preservation 的配置包含 before/after（scenario-results.json 路径或对象）和 beforeSourceHash/afterSourceHash。所有运行需成功、没有阻断写请求、源码稳定、浏览器环境一致；内容/属性及样式精确比较，位置/尺寸允许 0.5 CSS px。只覆盖声明状态和属性，不能当作完整像素或真实加购/统计/支付验收。动画、动态数据变化导致差异时保留证据复核，不自动忽略。

JS 补丁至少需要一次 click 紧接 assert-*，记录点击到预期 UI 状态的耗时。若候选比基线慢超过 max(150ms, 基线耗时)，返回证据需复核，不允许用最终画面一致掩盖首次响应变慢；这是一组实验室时延的保守复核门槛，不是 INP 或统计因果证明。显式等待不能替代这组紧邻动作。

## 4. 单个补丁收益实验

准备两个明确绑定本地文本快照的未发布预览，只有计划内文件允许不同。基线目录保留本轮开始代码，候选目录应用补丁；保留用户原有修改，不重置到 Git HEAD。工具不会自动复制主题、同步或发布。

```sh
node scripts/perfkit.mjs experiment --config /absolute/task/experiment.json --out /absolute/task/experiment
node scripts/perfkit.mjs verify-patch --config /absolute/task/experiment/patch-evidence.json --out /absolute/task/rechecked.json
```

完整格式见 [patch-experiment.json](../assets/examples/patch-experiment.json)。plan/diagnosis 可为路径或对象；before/after 为 measure 配置，各只有相同代表页面和设备，显式 deployment；regressionBefore/After 是匹配动作的 scenarios 配置。runner 绑定各自 project/themeId。

先执行前后功能及 checkpoint 检查，失败不花 Lighthouse 样本。每侧 3 次（可选 4 次），配对顺序交替：前/后、后/前、前/后，浏览器正常加载全部资源。两个预览各在整轮测量前后核验一次，避免每个样本重拉全套主题。每份原始报告及失败目录都保存；本地每次检查漂移，有警告立即停止，不抽取高分样本补数。部署核验仍不能排除区间内改动后又还原、商家内容/App/网络状态变化。

verify-patch 重新读取原始报告，要求：

- 两侧只有该计划的精确文件/哈希差异，所有文件绑定同一个 candidateId。
- 原始配置、环境、页面/设备与采样时间独立可比，且部署证明完整。
- 分数及目标指标的提升超过现有 MAD 噪声/最低收益门槛，其他关键指标没有实质退步。
- 同页面/设备/主题上的显式功能断言与源码绑定 checkpoint 通过。

结果区分 invalid-evidence、no-measurable-gain、hypothesis-not-confirmed、performance-regressed、functional-regressed、promising。promising 仍为探索结果，不改变移动最低75/中位80、桌面最低85/中位90、正式每组前后至少5次的标准。

history 传入全部已有 verification.json 路径或对象；拒绝重复已评估补丁，连续两轮无收益/无效证据停止，也受 maxCandidateRounds、maxWallTimeMs、maxAttempts、maxFailures 控制。保留 invalid-evidence 与源码回退的区别；runner 本身只读，回滚仍显式调用 rollback。

新诊断绑定计划最终用 optimize verify / verify-optimization 时，patchEvidence 指向上述 patch-evidence.json。验证器重新计算实验结果并校对正式基线/候选哈希，不能只提交 promising 布尔值。optimize 带 patchEvidence 时复用已完成探索，直接进入原正式矩阵与功能/视觉复核。

## 5. batch 与本地验证

batch 增加 `"bottlenecks":{"profiles":["/absolute/task/runtime/profile.json"],"limit":3}`，合并本轮 runtimeProfiles 与已有记录，输出 bottlenecks.json。可用 demand 指定上述 plan-demand 配置；未指定 candidateId 时选 source 对应的首个已核实候选。demand 与独立 recipe 互斥，batch 仍只输出计划，不应用。run 复用已有测量，避免为诊断重跑全站。

`npm run test:demand` 验证依赖与收益协议；`npm run test:browser` 验证真实 Chrome 下的 CPU 映射、生成补丁、首次点击、多实例、卸载重连、动态 section、CSS 与 DOM 检查点。测试服务器只在临时本地目录，测试数据不代表店铺分数。

`npm run test:demand-live` 使用刻意设置阻塞 CSS 的隔离主题，真实采集运行证据、生成并应用 CSS 补丁、检查交互/呈现，再交替运行六次真实 Lighthouse。仅 Shopify CLI 源码传输被本地夹具替代，真实浏览器校验页面身份。该测试保留结果到终端输出的临时目录；不能作为任何实际店铺的提分证据。
