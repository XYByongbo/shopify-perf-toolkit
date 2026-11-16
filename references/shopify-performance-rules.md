# Shopify 官方性能检查与 P0/P1 规则

此扩展补充官方检查执行、Shopify 图片输出、首屏资源顺序、Liquid 数据访问和 LCP 显示延迟。规则是诊断候选，不能把发现数量减少、文件变小或测试通过当作真实店铺收益。原测量、源码身份、功能保留、评分及回滚门禁继续生效。

当前共有 11 组 P0 + 16 组 P1 自有候选规则，独立于 11 项官方 Theme Check。P0/P1 是实施批次，不代表已证明某店铺的瓶颈严重程度。报告按规则分别标明静态、仓库依赖和实际支持的运行检查；只做源码分析的规则不会因提供 profile 就标为运行已检查。

0.12.0 起，P1 规则的 runtime 覆盖从 5 组扩展到 9 组，新增 PERF_ASYNC_CSS、PERF_FONT_DELIVERY、PERF_LAYOUT_ANIMATION、PERF_JS_DOM_READY_FETCH 的运行证据检查。Liquid profile 增加源码图关联，交互 CPU 增加窗口上下文和交互脚本识别。critical CSS 生成增加共享/页面特定规则分析。App 归属增加自动边界推断。实验支持 URL 参数切换主题版本。verify-optimization 增加可配置性能预算门禁。

## 入口与覆盖状态

```sh
# 运行本机已有 Shopify CLI，不安装/升级、不自动修复
node scripts/perfkit.mjs check-performance --project /absolute/theme --out /absolute/run/official.json

# 离线 P0/P1 检查；profiles 可省略
node scripts/perfkit.mjs audit-performance --project /absolute/theme \
  --profiles /absolute/run/profiles.json --out /absolute/run/performance.json
node scripts/perfkit.mjs report --input /absolute/run/performance.json --out /absolute/run/performance.html

# 定点读取候选、源码偏移和待填写 recipe
node scripts/perfkit.mjs analyze-code --project /absolute/theme \
  --target sections/hero.liquid --out /absolute/run/hero-analysis.json
```

`profiles.json` 为最多 24 个已保存 runtime profile 的绝对路径或完整对象数组，与 `diagnose-performance` 一致。输出文件须尚不存在；官方检查输出不得位于主题内。两条新命令退出码 0 表示当前检查范围内没有待复核项，3 表示候选或检查不完整，2 表示输入/执行错误。没有 runtime profile 时，报告明确保留 `runtime: not-assessed`，不会宣称线上性能通过。

`scan` 自动包含 P0 静态候选及 `performance` 详细库存；`audit-site` 自动包含 `performance-audit` 补充报告和发现，用 `--official /absolute/run/official.json` 接入官方检查结果。`diagnose-performance` 的 `performance` 字段包含专项候选，但不会把它们自动提升为已有证据引擎的可执行 CPU/资源假设。老 runtime profile 缺少 LCP presentation 时应重新采集；已有有效 CPU 候选仍保留，CLI 可能因待复核返回 3。

batch 使用 `officialChecks: true` 或 `officialChecks: {"timeoutMs":120000}` 在测量前运行官方性能检查。它与 `precheck` 两项结构检查、`checks.run` 项目检查或 `checks.input` 外部报告并存，分别保留证据。quality 优先使用项目检查或导入报告，其次官方性能报告，再次结构预检。标准 [batch 模板](../assets/examples/batch.json) 已开启官方性能检查，已有未声明的配置不会自动调用 CLI。

## 官方检查范围

独立配置 `extends: theme-check:nothing`，启用：

- `AssetSizeJavaScript`、`AssetSizeCSS`
- `ParserBlockingScript`、`ImgWidthAndHeight`、`RemoteAsset`
- `AssetPreload`、`CdnPreconnect`、`PaginationSize`
- `DeprecateLazysizes`、`DeprecateBgsizes`
- `ContentForHeaderModification`

这不是全量 Theme Check，也不替代原 `LiquidComplexity` / `LiquidNestingDepth` 预检。冻结 Liquid/JSON/JS/CSS 源码快照，保留 CLI/检查器版本、请求与实际配置、原始 JSON、文件哈希和检查范围；完成后复核快照及原主题，漂移时拒绝结果。使用检查器自身默认阈值，并记录其版本和打印配置；不继承主题 `.theme-check.yml` 忽略项。源码内的抑制指令仍服从官方语义，零告警不代表没有被抑制的代码。

没有兼容 CLI、规则未启用、输出异常、执行超时或源码漂移时失败，不降级成“通过”。batch 保存 `official-checks-failure.json`。成功时保存 `official-checks.json/html`，规范告警与 Lighthouse 节省估值分开。`PERF_KIT_SHOPIFY_CLI` 可固定可执行文件。

## P0 检查

| 规则 | 静态范围 | 运行证据与边界 |
| --- | --- | --- |
| `PERF_IMAGE_TAG_LOADING` | image_tag 的 lazy/high 冲突 | 新 profile 检查实际图片 LCP 的 loading 与优先级；按 class 找到的源码仍只是候选 |
| `PERF_IMAGE_TAG_SIZES` | image_tag 缺少显式 sizes | Shopify 默认值可能正确；核对共享组件布局、实际选源、DPR 和断点 |
| `PERF_DUAL_HERO` | 同一 HTML 父节点的 `--desktop`/`--mobile` 等类名 image_tag 或 img 输出 | CSS 隐藏不证明没有下载；条件分支候选标记为需复核，不同包装节点需人工分析 |
| `PERF_HEAD_RESOURCE_ORDER` | head 中在 content_for_header 之后的 stylesheet/preload/module/importmap | 先判断是否首屏必需；实站流式响应、依赖顺序与层叠需验证 |
| `PERF_HEAD_LIQUID_COST` | 边界前目录循环，以及字面 snippet 调用链中的数据访问候选 | 静态可达不代表执行；动态 snippet 明确标为未完成 |
| `PERF_LIQUID_NESTED_LOOP` | 循环内嵌套目录/变体循环 | 结合实际数据量和 Liquid profiler；不把所有双循环声称为平方复杂度 |
| `PERF_LIQUID_METAFIELD` | 循环内 metafield 读取 | 区分每项数据与循环不变量，不能统一外提 |
| `PERF_LIQUID_OVERFETCH` | 无 limit/paginate 的目录循环、完整目录/variant JSON | 检查实际需要的数据、for/paginate 语义及动态 UI |
| `PERF_LIQUID_RENDER_LOOP` | 循环内 render/include | 追踪被调用 snippet 实际耗时，不自动拆分或内联 |
| `PERF_LCP_REVEAL` | 同一 CSS 规则的隐藏属性与动画组合 | profile 保存 LCP 元素/祖先样式、动画事件历史；render delay ≥100ms 时提出相关性候选，不声称因果已证明 |
| `PERF_LCP_BACKGROUND` | CSS 背景样式库存 | 实际 LCP 非 img 且有 background-image 时提示；转换需要保留裁剪/布局的审阅补丁 |

解析失败、动态 CSS、缺失或过期 runtime 证据单列，不能静默跳过。Liquid raw/comment/schema、HTML 注释及 script 内容不作为模板执行代码检查。LCP 快照采集有诊断开销，与正式 Lighthouse 采样分开。

部分从 opacity:0 开始的动画用例在 Chrome 中不产生 LCP 条目。此时保留动画事件和静态候选，并报告缺失的 LCP presentation；不能伪造 LCP 或计算显示补丁收益。样式快照记录的是 Observer 回调采集时刻，不是逐帧渲染历史。

## 五项新增补丁策略

`code-strategies` 现在列出 21 项通用代码策略。以下五项 P0 策略通过原 `plan-site → apply → rollback` 生成与重算，绑定当前 `sourceHash`。所有审阅证据必须由实际检查得出，工具不自动填 true。`analyze-code.reviewTasks` 提供源码偏移和待填 recipe；缺少页面证据或参数的模板不能直接应用。

| kind | 参数 | 必需审阅 / 拒绝边界 |
| --- | --- | --- |
| `liquid-image-tag-loading` | `outputStart`、`loading` | `initialPlacementConfirmed`、`sharedInstancesReviewed`；eager 要 `isLCP:true`、`inViewport:true`，lazy 要两者 false。保留 image_url、裁剪、alt、尺寸链；拒绝动态 loading/priority、capture、template 或属性内输出 |
| `liquid-picture-pair` | `desktopStart`、`mobileStart`、`breakpoint`、`desktopWidths`、`mobileWidths`、`sizes`、`className` | `initialLcpConfirmed`、`artDirectionReviewed`、`cssVisibilityReviewed`、`responsiveSizesReviewed`、`bothImagesPresent`；仅相邻、同父且不在条件分支的简单 image_url/image_tag。两图需相同显式字面 alt；宽度不超过原上限，拒绝固定高度裁剪、未知属性和事件处理器 |
| `liquid-hoist-head-resource` | `resourceStart` | `firstPaintRequired`、`cascadeReviewed`、`dependenciesReviewed`、`liveStreamingValidationPlanned`；只移动 layout 中直接 head 子节点的字面 stylesheet/font preload，或字面 asset_url→stylesheet_tag。不能跨赋值、脚本或其他资源，也不移动 script |
| `liquid-cache-metafield` | `assignStart` | `profileHotspotConfirmed`、`loopScopeReviewed`、`metafieldImmutable`；仅直接 for 正文中的固定全局 metafield 路径。首次迭代缓存，空循环不读取；拒绝每项数据、动态 lookup、过滤器、根变量/forloop 写入、嵌套循环、render/include 和提前退出 |
| `css-lcp-reveal` | `selector` | `initialLcpConfirmed`、`revealOnlyReviewed`、`allStatesReviewed`；唯一顶层 class/id、字面 opacity:0 或 visibility:hidden 加动画/过渡。只解除显示门槛；拒绝 important、条件/重复规则、transform/display/clip/filter 等复杂隐藏 |

picture 策略用一个 `<img>` 保留高优先级，为 mobile/desktop 生成各自 `<source>`、响应式宽度及原图比例，并用经审阅的公共 class 替换双端隐藏类。原来的两图必须确认均存在；动态商家配置、空图兜底和条件化 art direction 使用 `reviewed-replacement`。不改 schema，不复制、下载或转码素材。

picture 策略拒绝带 Liquid 空白裁剪标记的图片输出，避免意外改变周围文本。head 移动策略要求 `content_for_header` 独占一行，以保留原有受保护内容检查。

复杂主题可以使用已有 `reviewed-replacement`，但仍需完整 diff、源码身份及针对性回归。CSS 背景转 img、任意嵌套循环改写、变量宽度和跨文件参数映射尚不自动生成；报告必须保留这些边界，不能写成所有主题自动修复。

## P1 检查与优化

优先核对资源发现和 CSS/字体交付，再处理实际交互热点与隐藏组件。所有 P1 源码候选自动进入 scan 和 analyze-code；仓库级 stylesheet 作用域检查在 audit-performance / audit-site 中复用已有 audit-stylesheets。无须更改 batch 配置。既有 11 项官方检查保持原范围，以下是工具自己的官方实践补充分析，不冒用官方规则名。

| 规则 | 检查与证据 | 优化路径 / 边界 |
| --- | --- | --- |
| `PERF_PRELOAD_BUDGET` | 同文件及实际页面的 author preload 数、完全重复提示、font 缺 crossorigin；计入 preload_tag 及 image_tag/stylesheet_tag 的 preload:true | 超过两项只是复核候选，条件分支不相加当真实页面；检查 Link 头与实际发现时机，再做定点重复清理 |
| `PERF_PRECONNECT` | Shopify 管理的域名、实际同源/重复提示及数量；保留 CORS 模式差异 | 不能把带/不带 crossorigin 的连接合并；不按未知域名自动新增或移除连接 |
| `PERF_STYLESHEET_COUNT` | 同文件声明与实际 active stylesheet 链接分别统计 | 超过 4 条触发工具复核，**不是 Shopify 上限**；先检查原生 subsetting、共享资源及 style recalculation，再考虑分包 |
| `PERF_ASYNC_CSS` | print/onload 样式声明 | 确认首屏所需才恢复同步；不能一律异步化或一律同步化 |
| `PERF_STYLESHEET_SCOPE` | 复用原生 stylesheet 跨文件/调用祖先分析及其未完成项 | 复杂选择器、动态 class/block 继续复核；Section Rendering API 插入要保留返回的 section stylesheet |
| `PERF_FONT_DELIVERY` | 绝对字体 URL 和 Google Fonts 样式入口；离线无法确认店铺同源 | 核对 origin、授权、现有平台字体及自托管选择；不下载或搬运字体文件 |
| `PERF_FONT_DISPLAY` | CSS @font-face 及 Shopify font_face 的默认/block/auto 策略 | CSS 复用 css-font-display；Liquid 字体过滤器通过审阅补丁，验证字体交换和文本 LCP |
| `PERF_FONT_FALLBACK` | swap 字体在同源文件缺少带度量覆盖的 local fallback | 复用 css-font-fallback；还要跨文件检查实际 font stack，参数必须测量，不自动猜值 |
| `PERF_LAYOUT_ANIMATION` | keyframes 中布局属性，以及 all/布局属性 transition | 窄模式用过渡属性策略；任意 keyframes/transform 改写需保留最终布局、定位与交互语义 |
| `PERF_JS_DOM_READY_FETCH` | 内联/asset JS 的 DOMContentLoaded/load 回调直接调用 fetch | 只提示请求时机；先核对 DOM 输入、Shopify 全局、同意状态及请求副作用，不自动外提 |
| `PERF_JS_PASSIVE_LISTENER` | window/document 的 wheel/touch 监听器未显式 passive | 浏览器默认值可能已 passive；只有不需取消默认行为的受限函数可生成补丁 |
| `PERF_JS_VIEW_TRANSITION` | document.startViewTransition 调用位置 | 要审阅 pointer/keyboard 取消及完整生命周期；找到调用不等于缺少取消，不自动插入全局监听器 |
| `PERF_JS_MODULE_SHIMS` | script src 或静态 import 的 es-module-shims | 核对平台自带 shim、模块解析及浏览器兼容；不自动删脚本 |
| `PERF_HIDDEN_DOM` | dialog/关闭 details/hidden 元素中的 Liquid 循环和 snippet 工作；隐藏 DOM 超过 200 后代 | 200 是**工具复核线**；按需内容要验证首次打开、多实例、焦点、空状态及编辑器重载 |
| `PERF_DIALOG_LCP` | 真实初始 LCP 的祖先为 dialog 或 dialog/alertdialog role | 仅运行检查；不能把静态 dialog 当作 LCP，也不自动延后同意或关键通知 |
| `PERF_LIQUID_FETCH_LIMIT` | collection.products / collections 以外数组仅有 for limit，未在 paginate 内 | 渲染数量不证明查询数量减少；数据类型、paginate 支持、页码和完整 UI 需单独审阅，不自动包 paginate |

P1 runtime 使用 `initial.delivery.version:1`：最多 500 个 link、100 个隐藏组件，保留采集时间、media 是否匹配、disabled、CORS、图片选源属性及后代数量。LCP presentation 增加祖先 tag/role。只在已完成、源码稳定且指纹匹配时消费这些记录，DOM 选择器仍不是已验证的 Liquid 文件映射。

文档响应只额外保存最终响应的 Link 头（最多 64 KiB），不保存所有响应头。**没有采集 HTTP 103 Early Hints**，也不能由最终 Link 头缺失推断平台没有发出提示。记录截断、缺失字段或旧 profile 时列入未完成项；没有 LCP 时仍可检查独立 delivery 证据。DOM 快照采于 settle 后，脚本可能已改写标签，因此不能重建完整加载历史。

新增四项策略：

| kind | 参数 | 必需审阅与结构边界 |
| --- | --- | --- |
| `liquid-dedupe-resource-hint` | `firstStart`、`duplicateStart` | `renderedTogether`、`responseHeadersReviewed`、`resourceTimingReviewed`、`domReferencesReviewed`；同一 head 的无条件直接子节点，允许属性完全一致，保留第一项。拒绝动态值、ID、事件、组合 rel 和 CORS/media 差异 |
| `liquid-critical-css-sync` | `tagStart` | `initialViewportStylesConfirmed`、`cascadeReviewed`、`mediaAllIntended`、`domReferencesReviewed`；仅 media=print 且 onload 只清空自身和切到 all。保留 href、integrity、CORS 和 noscript；拒绝其他回调、disabled/alternate、重复属性和任意动态 URL |
| `js-passive-listener` | `registrationStart` | `cancellationNotRequired`、`listenerLifecycleOwned`、`capturedStateReviewed`；顶层注册本文件唯一同步零参数函数，原 options 省略/false。拒绝调用、事件/this 依赖、别名、额外注册、动态作用域和自定义 options；保留函数身份与 capture:false 的移除行为 |
| `css-transition-properties` | `selector`、`properties` | `animatedPropertiesReviewed`、`allStatesReviewed`、`visualBehaviorReviewed`；唯一顶层 class/id，单一 transition-property:all，properties 只能是明确审阅的 opacity/transform。拒绝 shorthand、important、条件/重复规则和动态 CSS |

以上还要求当前 sourceHash 和非空 summary/reason。位置使用 UTF-16 源码偏移。`analyze-code.reviewTasks` 只生成待填参数；不自动填写审阅布尔值，也不保证模板已满足所有转换边界。[P1 recipe 示例](../assets/examples/p1-code-strategies.json) 中哈希/位置为占位符，证据为 false，不能直接应用。同文件组合修改仍按原约定使用 reviewed-replacement，不放多个 change 绕过单文件约束。

字体 display/fallback、scroll/resize 合帧、非关键脚本 defer、资源作用域、CSS 多状态拆分和组件首次交互加载继续使用原策略。尚未自动改写 App、任意 ready-fetch、View Transition 生命周期、隐藏组件网络请求、菜单合并、字体搬运或关键帧。这些候选保留具体原因，不能写成 P1 任意主题均可自动修复。

参考：[preload](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-preload-resource-hints-sparingly)、[preconnect](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-preconnect)、[关键 CSS 同步](https://shopify.dev/docs/storefronts/themes/best-practices/performance/load-critical-css-synchronously)、[事件处理](https://shopify.dev/docs/storefronts/themes/best-practices/performance/debounce-throttle-event-handlers)、[View Transition](https://shopify.dev/docs/storefronts/themes/best-practices/performance/cancel-view-transitions-on-interaction)、[数组查询限制](https://shopify.dev/docs/storefronts/themes/best-practices/performance/limit-product-queries-with-pagination)。其他条目对应官方总览的 CSS/fonts、JavaScript、Liquid 分类；工具的数量预算和受限生成器是本项目实现，不是官方要求。

## 验证

- 官方 runner 测试覆盖 JS/CSS 快照、规则支持、分类、错误输出、源码漂移及 batch 传递。
- P0 测试覆盖注释/原始文本排除、候选与证据、空/短/长集合等价性、五种补丁应用/回滚和篡改拒绝、CLI/整站审计接入。
- `PERF_KIT_BROWSER_TESTS=1 node --test --test-concurrency=1 tests/performance-browser.test.mjs`：本机 Chrome 验证 mobile/desktop、DPR 1/2 仅请求对应图片，采集真实 LCP 动画记录并验证显示补丁。使用隔离 HTTP 服务及受支持子集的本地 Liquid filter，不替代 Shopify 主题预览或店铺评分。
- 原完整测试：`npm test`、`npm run test:lighthouse`；浏览器回归：`npm run test:browser`。
- P1 专项：`npm run test:shopify-p1`，覆盖 16 规则、误报与拒绝边界、旧/损坏 runtime 证据、四策略源码重放、实际 apply/rollback、篡改与独立源码漂移拒绝、CLI/整站报告及原生 stylesheet 复用。
- P1 浏览器：`PERF_KIT_BROWSER_TESTS=1 node --test --test-concurrency=1 tests/p1-performance-browser.test.mjs`。本地 HTTP + 真实 Chrome 验证 JS 开/关时 CSS 生效与请求数、实际 passive 注册/滚动/移除/重注册、过渡最终布局、Link 头/隐藏 DOM/弹窗 LCP 采集；已纳入 test:browser。不替代 Shopify 实站流式、同意流程或性能分数验收。

2026-10-20 本轮工具验收：`npm test` 共 459 项，441 通过、18 按条件跳过；Python 共 62 项，60 通过、2 跳过；完整真实 Chrome 回归 15/15 通过。新规则的布尔证据只在明确标为合成的测试夹具中构造，生产分析输出保持待填写状态。

四项策略的生成结果另在完整隔离主题中使用 Shopify CLI 4.9.4 / Theme Check 3.26.1 的默认完整配置复核：没有新增 error/warning，保留原有 AssetPreload 和 RemoteAsset 各一条 warning，未通过抑制规则清零。项目 60/5 结构预检完整、无告警。生成后 layout/JS/CSS 非空物理行分别为 14/3/6，无新增 Liquid 嵌套、无新 helper，重复 hint 减为一项；这只是支持模式的主题代码预算与语法验证，不是实际商家主题或性能分数验收。

依据：[官方性能总览](https://shopify.dev/docs/storefronts/themes/best-practices/performance)、[Theme Check](https://shopify.dev/docs/storefronts/themes/best-practices/performance/theme-check-tool)、[picture](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-picture-for-art-directed-heroes)、[head 顺序与实站验证](https://shopify.dev/docs/storefronts/themes/best-practices/performance/load-resources-before-content-for-header)、[metafield](https://shopify.dev/docs/storefronts/themes/best-practices/performance/move-metafield-access-outside-loops)、[variants](https://shopify.dev/docs/storefronts/themes/best-practices/performance/avoid-variant-overfetching)、[LCP 动画](https://shopify.dev/docs/storefronts/themes/best-practices/performance/dont-hide-lcp-image-behind-animations)。对照日期：2026-10-20。

0.14.0 新增 `liquid-font-display` 与 `liquid-rehost-resource`，参数、证据与正式验收要求见 [功能升级](toolkit-evolution.md)。资源替换不等于内容恢复或已取得性能收益。
