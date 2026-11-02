# 官方性能专题完整映射

2026-10-23 快照。来自工具的 `officialMethodCatalog()`；参数、必需证据与精确子集以 `shopify-methods --format full` 为准。表格中的生成器可用不等于目标主题适用或已经取得收益。

## images

| 官方专题 | 当前能力 | 执行入口 | 改写/验证重点 |
| --- | --- | --- | --- |
| [never-lazy-load-lcp-image](https://shopify.dev/docs/storefronts/themes/best-practices/performance/never-lazy-load-lcp-image) | 有受限生成器 | `domain:image-eager`、`site:liquid-image-tag-loading` | 仅对已定位的首屏 LCP 取消懒加载；保留非首屏策略。 真实 LCP、共享实例、资源发现时间和响应式选择。 |
| [set-fetchpriority-high-on-lcp-image](https://shopify.dev/docs/storefronts/themes/best-practices/performance/set-fetchpriority-high-on-lcp-image) | 有受限生成器 | `domain:image-priority` | 给确认的 LCP 提高请求优先级，不能同时 lazy。 优先级、下载竞争和独立 LCP 收益。 |
| [prevent-image-layout-shift](https://shopify.dev/docs/storefronts/themes/best-practices/performance/prevent-image-layout-shift) | 有受限生成器 | `domain:image-dimensions`、`domain:image-aspect-ratio` | 依据真实图片比例预留尺寸，保留响应式缩放。 同图片加载完成后的最终布局及首次加载 CLS。 |
| [use-picture-for-art-directed-heroes](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-picture-for-art-directed-heroes) | 有受限生成器 | `site:liquid-picture-pair` | 相邻移动/桌面图片转 picture，保留设置、裁切和缺图回退。 两断点、DPR、currentSrc、只加载匹配图片。 |
| [use-responsive-images](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-responsive-images) | 有受限生成器 | `site:image-responsive` | 用实际布局推导 sizes/widths；eager LCP 不依赖 lazy-only 的 sizes=auto。 跨断点显示宽度、DPR、currentSrc 与视觉清晰度。 |
| [use-shopify-image-filters-efficiently](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-shopify-image-filters-efficiently) | 需编写替换补丁 | — | 把已确认图片对象接入 image_url/image_tag，保留焦点及原配置。 尺寸、alt、srcset、nil 数据与布局；禁止凭 URL 猜图片对象。 |
| [use-filter-chains](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-filter-chains) | 需编写替换补丁 | — | 改写手拼 CDN URL 为图片过滤器链；请求最大宽度必须覆盖目标候选。 版本参数、焦点、合法 srcset、实际下载宽度。 |
| [avoid-background-images-hero](https://shopify.dev/docs/storefronts/themes/best-practices/performance/avoid-background-images-hero) | 需编写替换补丁 | — | 将 LCP 背景迁移为 HTML img，匹配 object-fit/position 与原叠层。 加载发现、裁切、焦点、布局及内容一致性。 |
| [dont-hide-lcp-image-behind-animations](https://shopify.dev/docs/storefronts/themes/best-practices/performance/dont-hide-lcp-image-behind-animations) | 有受限生成器 | `site:css-lcp-reveal` | 只解除实际 LCP 的初始显示门槛，保留其它交互状态。 初始可见性、动画用途、最终样式、LCP render delay。 |
| [use-section-index](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-section-index) | 需编写替换补丁 | — | 按 section.index/location 分层加载；nil 保持 eager/sync 并输出完整内容。 编辑器、静态区块、Section API、disabled section 和共享实例。 |

## apps

| 官方专题 | 当前能力 | 执行入口 | 改写/验证重点 |
| --- | --- | --- | --- |
| [prevent-popups-hijacking-lcp](https://shopify.dev/docs/storefronts/themes/best-practices/performance/prevent-popups-hijacking-lcp) | 需编写替换补丁 | — | 按业务契约调整弹窗尺寸或交互触发，不能隐藏关键内容骗分。 弹窗业务、焦点、键盘、实际 LCP 与显示时机。 |
| [reserve-space-app-injected](https://shopify.dev/docs/storefronts/themes/best-practices/performance/reserve-space-app-injected) | 有受限生成器 | `domain:app-reserve-space` | 按目标 App 的双断点实测尺寸预留局部空间。 全部状态稳定高度、正常文档流、业务完整性、CLS。 |
| [remove-render-blocking-apps](https://shopify.dev/docs/storefronts/themes/best-practices/performance/remove-render-blocking-apps) | 有受限生成器 | `domain:app-defer`、`domain:app-async` | 为有明确归属的主题可控 App loader 调整调度；平台注入交给拥有者。 原脚本字节、依赖、业务状态变化和全资源独立测量。 |
| [audit-remove-third-party-scripts](https://shopify.dev/docs/storefronts/themes/best-practices/performance/audit-remove-third-party-scripts) | 有受限生成器 | `domain:app-defer`、`domain:app-async` | 跨模板与真实交互确认第三方用途，再进行已授权的条件加载或调整。 不以阻断域名的测分作为验收；保留统计、同意和购买功能。 |
| [disable-ab-testing-when-inactive](https://shopify.dev/docs/storefronts/themes/best-practices/performance/disable-ab-testing-when-inactive) | 需编写替换补丁 | — | 先确认实验停止及拥有者授权，再移除无效 anti-flicker 行为。 活动实验、首屏可见性、转化埋点与配置；不能自动停业务。 |

## liquid

| 官方专题 | 当前能力 | 执行入口 | 改写/验证重点 |
| --- | --- | --- | --- |
| [render-essential-content-server-side](https://shopify.dev/docs/storefronts/themes/best-practices/performance/render-essential-content-server-side) | 有受限生成器 | `domain:section-liquid-initial`、`domain:section-liquid-inline` | 复用已有 snippet/render 参数填充首屏空容器，只移除独立启动调用；后续动态更新使用 Section API。验证无 JS 首屏、无启动请求、真实更新响应和内容变化。 |
| [avoid-deeply-nested-liquid-loops](https://shopify.dev/docs/storefronts/themes/best-practices/performance/avoid-deeply-nested-liquid-loops) | 需编写替换补丁 | — | 用实际热点选择预过滤或索引以减少重复遍历，避免盲目替换早停循环。 空/短/长目录、输出顺序、作用域及真实 Liquid profile。 |
| [move-metafield-access-outside-loops](https://shopify.dev/docs/storefronts/themes/best-practices/performance/move-metafield-access-outside-loops) | 有受限生成器 | `domain:liquid-cache-metafield`、`site:liquid-cache-metafield` | 只缓存迭代不变的 metafield；逐商品输入不能跨循环共享。 零迭代语义、输入写入、作用域、原始服务端采样。 |
| [move-operations-outside-loops](https://shopify.dev/docs/storefronts/themes/best-practices/performance/move-operations-outside-loops) | 有受限生成器 | `domain:liquid-cache-loop-filter`、`site:liquid-cache-loop-filter` | 缓存不变 assign/filter；不提升依赖循环项或被重赋值的表达式。 空/短/长集合及变量语义、服务端和导航双验证。 |
| [avoid-repetitive-filter-calls](https://shopify.dev/docs/storefronts/themes/best-practices/performance/avoid-repetitive-filter-calls) | 有受限生成器 | `domain:liquid-cache-loop-filter`、`site:liquid-cache-loop-filter` | 同参数同作用域的纯过滤结果只计算一次。 确认无输入变化；比较输出与原始 self-time。 |
| [liquid-performance-patterns](https://shopify.dev/docs/storefronts/themes/best-practices/performance/liquid-performance-patterns) | 有受限生成器 | `domain:liquid-cache-loop-filter`、`domain:liquid-cache-metafield` | 根据 Theme Inspector 热点选择不变量缓存、受限循环或语义保持重构。 服务器采样独立于浏览器 TTFB，真实采样才可确认收益。 |
| [assign-block-settings-to-variable](https://shopify.dev/docs/storefronts/themes/best-practices/performance/assign-block-settings-to-variable) | 需编写替换补丁 | — | 在当前 block 作用域缓存 settings；不能跨不同 block 复用。 空设置、block 顺序、动态重载和模板输出。 |
| [use-echo-for-concatenation](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-echo-for-concatenation) | 需编写替换补丁 | — | 只将立即输出的连接拆成输出语句；需要字符串变量时保留原逻辑。 escape、空白、nil、后续字符串消费者及实际 profile。 |
| [avoid-conditionals-in-loops](https://shopify.dev/docs/storefronts/themes/best-practices/performance/avoid-conditionals-in-loops) | 需编写替换补丁 | — | 按实际筛选逻辑预过滤，保留顺序和需要的复合判断。 forloop 元数据、数量、空集合与早停语义。 |
| [avoid-nested-renders](https://shopify.dev/docs/storefronts/themes/best-practices/performance/avoid-nested-renders) | 有受限生成器 | `domain:liquid-collapse-forwarder` | 只绕过命名参数逐个原样转发的单 render 包装层，保留叶子 render 隔离；真实调用关系及合计 self time 验收。 |
| [avoid-variant-overfetching](https://shopify.dev/docs/storefronts/themes/best-practices/performance/avoid-variant-overfetching) | 需编写替换补丁 | — | 初始输出必要变体与选项，选择后按上下文增量取数据。 高变体产品、无库存组合、价格、选择、加购与 URL。 |
| [limit-product-queries-with-pagination](https://shopify.dev/docs/storefronts/themes/best-practices/performance/limit-product-queries-with-pagination) | 有受限生成器 | `domain:query-limit`、`domain:query-limit-render`、`domain:query-paginate` | collection.products/collections 使用有限循环；其它数组按平台语义考虑 paginate。 原有页码、数量、forloop、固定轮播及数据查询。 |
| [limit-pagination-depth](https://shopify.dev/docs/storefronts/themes/best-practices/performance/limit-pagination-depth) | 需编写替换补丁 | — | 减少深页查询并提供筛选或明确分页；保持完整访问路径。 平台分页边界、键盘、Load more、URL 和内容范围。 |
| [defer-modal-content-loading](https://shopify.dev/docs/storefronts/themes/best-practices/performance/defer-modal-content-loading) | 需编写替换补丁 | — | 首开再请求隐藏弹窗昂贵 Liquid；按正确 API 上下文渲染。 首次打开、关闭再开、错误重试、recommendations 专用上下文。 |
| [defer-combined-listing-products](https://shopify.dev/docs/storefronts/themes/best-practices/performance/defer-combined-listing-products) | 需编写替换补丁 | — | 用选项的子产品 URL 按需加载 combined listings，保留普通选项路径。 资格、nil、所选变体、商品跳转和购买行为。 |
| [use-section-rendering-api](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-section-rendering-api) | 有受限生成器 | `domain:section-fetch-single`、`domain:section-fetch-json` | 用真实 section.id 和语言/页面上下文更新局部，处理失败和 null。 Section 生命周期、多实例、最多五区块、设置保留与历史导航。 |

## delivery

| 官方专题 | 当前能力 | 执行入口 | 改写/验证重点 |
| --- | --- | --- | --- |
| [load-critical-resources-before-content-for-header](https://shopify.dev/docs/storefronts/themes/best-practices/performance/load-critical-resources-before-content-for-header) | 有受限生成器 | `site:liquid-hoist-head-resource` | 把独立首屏样式或字体预载移到原样保留的 content_for_header 前。 级联、Shopify 全局依赖；streaming 收益只能在支持的 live 场景核验。 |
| [use-preload-resource-hints-sparingly](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-preload-resource-hints-sparingly) | 有受限生成器 | `site:liquid-dedupe-resource-hint` | 预载只用于确实发现晚的关键资源，清理确定相同的重复 hint。 Link 头、as/type/media/CORS、请求复用及优先级竞争。 |
| [use-preconnect](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-preconnect) | 有受限生成器 | `site:liquid-dedupe-resource-hint` | 只对需要的第三方连接预热，避免重复的平台 CDN 连接提示。 连接时序、CORS、实际使用域与网络收益。 |
| [use-shopify-cdn](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-shopify-cdn) | 需编写替换补丁 | — | 在有合法本地资产时使用 asset_url/font_url/image_url；不批量复制远程素材。 内容版本、缓存、实际请求、资产许可与 CSP。 |
| [use-speculation-rules](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-speculation-rules) | 需编写替换补丁 | — | 在平台已有规则基础上审查页面预测，不重复注入或预取写操作。 浏览器支持、导航命中、流量、隐私及现有平台配置。 |

## platform

| 官方专题 | 当前能力 | 执行入口 | 改写/验证重点 |
| --- | --- | --- | --- |
| [avoid-request-proxies](https://shopify.dev/docs/storefronts/themes/best-practices/performance/avoid-request-proxies) | 平台范围 | — | 定位代理导致的额外往返，优先恢复受支持的直达 Shopify 交付。 路由、域名、缓存、安全与平台拥有者协作；非主题单文件修复。 |
| [platform](https://shopify.dev/docs/storefronts/themes/best-practices/performance/platform) | 平台范围 | — | 区分 Shopify CDN、流式输出、原生子集等平台能力与主题责任。 真实可用上下文；不在预览上宣称 streaming 收益。 |

## css

| 官方专题 | 当前能力 | 执行入口 | 改写/验证重点 |
| --- | --- | --- | --- |
| [stylesheet-subsetting](https://shopify.dev/docs/storefronts/themes/best-practices/performance/stylesheet-subsetting) | 需编写替换补丁 | — | 根据实际 section/block/snippet 渲染树组织原生 stylesheet，保留动态使用。 平台原生子集与手工 critical CSS 分别验证，不能混同。 |
| [reduce-stylesheet-count](https://shopify.dev/docs/storefronts/themes/best-practices/performance/reduce-stylesheet-count) | 有受限生成器 | `domain:stylesheet-once` | 一个非嵌套循环的调用方与前导样式 snippet 成对修改；首个实际实例输出、共享默认调用、级联和独立收益验证。 |
| [load-critical-css-synchronously](https://shopify.dev/docs/storefronts/themes/best-practices/performance/load-critical-css-synchronously) | 有受限生成器 | `site:liquid-critical-css-sync`、`demand:critical-css`、`split:css` | 首屏样式保持同步；只延迟证实非关键部分。 无 JS、FOUC、CLS、冷缓存和跨状态计算样式。 |
| [use-transform-for-animations](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-transform-for-animations) | 有受限生成器 | `site:css-transition-properties` | 对审阅过的动画收窄变化属性，复杂布局动画需要保持语义重构。 hover/focus/open/close、reduced motion、布局及呈现耗时。 |

## fonts

| 官方专题 | 当前能力 | 执行入口 | 改写/验证重点 |
| --- | --- | --- | --- |
| [reduce-cls-font-swapping](https://shopify.dev/docs/storefronts/themes/best-practices/performance/reduce-cls-font-swapping) | 有受限生成器 | `site:css-font-fallback` | 用实测 fallback 度量匹配文本，保持明确 line-height 和换行。 实际 fallback 使用、字号、语言、断点和冷字体加载 CLS。 |
| [self-host-web-fonts](https://shopify.dev/docs/storefronts/themes/best-practices/performance/self-host-web-fonts) | 需编写替换补丁 | — | 在许可允许时将已有字体经 Shopify CDN 提供，正确设置显示与预载。 WOFF2/CORS、字体功能、实际使用、文字 LCP 与回退布局。 |
| [use-system-fonts](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-system-fonts) | 需编写替换补丁 | — | 仅按商户设计要求改系统字体并省去多余字体请求。 字体外观、font_picker、system? 分支、空 href 和页面布局。 |

## measurement

| 官方专题 | 当前能力 | 执行入口 | 改写/验证重点 |
| --- | --- | --- | --- |
| [fake-performance-apps](https://shopify.dev/docs/storefronts/themes/best-practices/performance/fake-performance-apps) | 测量流程 | — | 审查测试环境与真实访客资源差异，保留所有内容及正常请求。 识别 UA 特供、屏蔽和隐藏内容；不允许伪造优化成绩。 |
| [finding-worst-offenders](https://shopify.dev/docs/storefronts/themes/best-practices/performance/finding-worst-offenders) | 测量流程 | — | 结合真实 CPU、Coverage、请求和归属定位可控源文件。 不能把字节或单状态未使用等同收益；核实测得函数与修改位置。 |
| [understanding-inp](https://shopify.dev/docs/storefronts/themes/best-practices/performance/understanding-inp) | 测量流程 | — | 区分输入延迟、处理和呈现，针对具体操作优化。 独立 Event Timing、真实目标、输入响应和原导航门槛。 |
| [improve-mobile-page-load-speed](https://shopify.dev/docs/storefronts/themes/best-practices/performance/improve-mobile-page-load-speed) | 测量流程 | — | 在移动 CPU/网络条件下独立采样并核查真实用户数据。 固定设备/引擎/条件，保留失败样本，不把桌面结果外推。 |
| [lab-vs-field](https://shopify.dev/docs/storefronts/themes/best-practices/performance/lab-vs-field) | 测量流程 | — | 区分受控实验与真实用户 p75，按相同页面设备分组。 时间窗口、样本量、地域、版本与不可比群体；不混池。 |
| [performance-gaps](https://shopify.dev/docs/storefronts/themes/best-practices/performance/performance-gaps) | 测量流程 | — | 用 TTFB/FCP/LCP 间隔缩小调查范围，再用 trace 证实。 流式文档下载包含 Liquid 与传输，间隔不是直接因果。 |
| [sustainable-performance](https://shopify.dev/docs/storefronts/themes/best-practices/performance/sustainable-performance) | 测量流程 | — | 维护假设、预算、前后独立测量、回滚和正式验收。 无收益切换机制，原始证据固定，不重复磨分。 |
| [testing-for-performance](https://shopify.dev/docs/storefronts/themes/best-practices/performance/testing-for-performance) | 测量流程 | — | 固定配置多次采样，比较中位数并检验功能及部署身份。 实验室/线上分开；工具阈值不冒充 Shopify 官方门槛。 |
| [theme-check-tool](https://shopify.dev/docs/storefronts/themes/best-practices/performance/theme-check-tool) | 测量流程 | — | 运行官方 Theme Check 定位静态性能问题并保留有效配置。 静态检查通过不等于性能收益或完整行为验证。 |

## javascript

| 官方专题 | 当前能力 | 执行入口 | 改写/验证重点 |
| --- | --- | --- | --- |
| [defer-scripts](https://shopify.dev/docs/storefronts/themes/best-practices/performance/defer-scripts) | 有受限生成器 | `domain:app-defer`、`domain:app-async`、`site:liquid-defer-script` | 非关键依赖链使用 defer；只有完全独立脚本使用 async。 执行顺序、首次操作、inline consumer、DOM ready 与写文档依赖。 |
| [load-javascript-on-user-interaction](https://shopify.dev/docs/storefronts/themes/best-practices/performance/load-javascript-on-user-interaction) | 有受限生成器 | `split:interaction` | 将已确认非首屏的私有组件脚本改为首次交互加载，保留首次操作与生命周期。 首个点击/键盘、重复初始化、卸载、动态插入、失败重试。 |
| [lazy-dom-rendering](https://shopify.dev/docs/storefronts/themes/best-practices/performance/lazy-dom-rendering) | 有受限生成器 | `domain:hidden-detach`、`domain:hidden-template`、`domain:hidden-template-chunked`（后两者仅旧版对照） | 隐藏组件按首次操作构建 DOM，必要时按正确 Section 上下文取内容。 首开延迟、template 空白节点、状态恢复、加载失败及内存。 |
| [request-critical-data-before-dom-ready](https://shopify.dev/docs/storefronts/themes/best-practices/performance/request-critical-data-before-dom-ready) | 需编写替换补丁 | — | 把确需首屏 JS 数据请求与 DOM 写入拆开，处理脚本早到和晚到。 readyState、错误恢复、Shopify 依赖及真实 LCP；不能一律 defer。 |
| [defer-non-critical-resources](https://shopify.dev/docs/storefronts/themes/best-practices/performance/defer-non-critical-resources) | 有受限生成器 | `site:liquid-defer-script`、`site:js-idle-init`、`demand:critical-css`、`split:css` | 对已审阅的非关键工作安排调度和分包，保留首屏和首次交互依赖。 非关键证据、CSP、无 JS、FOUC、依赖顺序和业务响应。 |
| [debounce-throttle-event-handlers](https://shopify.dev/docs/storefronts/themes/best-practices/performance/debounce-throttle-event-handlers) | 有受限生成器 | `site:js-raf-listener` | 按事件契约合并/节流工作；需要 preventDefault 的监听不能 passive。 最新输入状态、首个/重复事件、取消、卸载和响应延迟。 |
| [cancel-view-transitions-on-interaction](https://shopify.dev/docs/storefronts/themes/best-practices/performance/cancel-view-transitions-on-interaction) | 需编写替换补丁 | — | 在快速输入或 reduced-motion 时取消待完成的视图过渡。 pointer/keyboard、双端 opt-in、无 API 回退和连续导航。 |
| [use-import-maps-for-modules](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-import-maps-for-modules) | 需编写替换补丁 | — | 统一 importmap 与 asset_url 版本依赖，避免重复加载平台 shim。 map 位于模块前、共享模块请求、动态导入和解析错误。 |

## mobile

| 官方专题 | 当前能力 | 执行入口 | 改写/验证重点 |
| --- | --- | --- | --- |
| [reduce-mega-menu-dom-overhead](https://shopify.dev/docs/storefronts/themes/best-practices/performance/reduce-mega-menu-dom-overhead) | 需编写替换补丁 | — | 在业务与可访问性一致时复用菜单结构，减少重复 DOM。 移动/桌面导航、焦点、触控、键盘和编辑器重载。 |
| [ensure-content-parity-mobile-desktop](https://shopify.dev/docs/storefronts/themes/best-practices/performance/ensure-content-parity-mobile-desktop) | 需编写替换补丁 | — | 保持两端核心内容及信息结构一致，只按布局调整展示。 相同产品信息、图像、SEO、键盘与读屏。 |
| [fix-content-wider-than-mobile-screen](https://shopify.dev/docs/storefronts/themes/best-practices/performance/fix-content-wider-than-mobile-screen) | 需编写替换补丁 | — | 定位具体溢出元素并修复宽度/布局约束，避免全局裁切掩盖问题。 长文本、表格、图片、横屏与放大后的完整内容。 |
| [implement-responsive-design](https://shopify.dev/docs/storefronts/themes/best-practices/performance/implement-responsive-design) | 需编写替换补丁 | — | 以主题既有断点组织响应式组件，减少重复内容和不必要请求。 全断点、orientation、焦点及性能同条件对比。 |
| [increase-tap-target-size](https://shopify.dev/docs/storefronts/themes/best-practices/performance/increase-tap-target-size) | 需编写替换补丁 | — | 根据实际交互控件扩大有效区域和间隔，保持布局与语义。 触控、键盘、遮挡、缩放及目标之间的误触。 |
| [remove-intrusive-interstitials](https://shopify.dev/docs/storefronts/themes/best-practices/performance/remove-intrusive-interstitials) | 需编写替换补丁 | — | 按业务要求调整遮挡内容的插页，保持必要同意及可访问性。 显示时机、关闭/焦点、内容可见和业务事件。 |

## external

| 官方专题 | 当前能力 | 执行入口 | 改写/验证重点 |
| --- | --- | --- | --- |
| [hydrogen-performance](https://shopify.dev/docs/storefronts/themes/best-practices/performance/hydrogen-performance) | 外部项目 | — | 转入 Hydrogen 应用与其服务端/客户端性能流程。 该文章不属于 Liquid 主题生成器，不能对主题自动套用。 |
| [optimize-checkout-extensions](https://shopify.dev/docs/storefronts/themes/best-practices/performance/optimize-checkout-extensions) | 外部项目 | — | 由 checkout extension 拥有者审查其网络、数据和代码路径。 需对应扩展项目及业务测试，不作为主题代码改写。 |

