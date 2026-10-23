# 查询、隐藏 DOM 与 Section Rendering 可执行闭环

这三类方法已进入 `profile-domain → diagnose-performance → plan-domain/plan-official → apply → experiment → verify`，也接入 `improve` 的回滚、重诊断和方法历史。本文说明实际生成器范围；没有测得收益时不能标为优化成功。

## 官方依据与实现边界

| 官方方法 | 当前生成器 | 定位与改写 |
| --- | --- | --- |
| [限制数据查询](https://shopify.dev/docs/storefronts/themes/best-practices/performance/limit-product-queries-with-pagination) | `query-limit` | 部署绑定 Liquid profile 定位到循环。把 `collection.products` / `collections` 的已有纯输出 `forloop.index <= N` 上限转换成 `limit:N`。只支持静态 1–50、完整 trim 形式，不擅自截断原来完整展示的列表。 |
| 同上；[paginate](https://shopify.dev/docs/api/liquid/tags/paginate) | `query-paginate` | 对 blog.articles、search.results、pages、product.variants、customer.orders、customer.addresses、article.comments，转换已有 `current_page - 1` 乘页大小的手工 offset 分页。加 paginate、保留 limit、移除 offset；保留原页码导航、赋值和外部空白。拒绝固定轮播、既有 paginate、嵌套循环和依赖循环元数据的正文。 |
| [延迟隐藏 DOM](https://shopify.dev/docs/storefronts/themes/best-practices/performance/lazy-dom-rendering) | `hidden-detach`；旧模板方法仅供对照 | 初始关闭、至少 200 个后代的唯一原生 details；结构须是 summary + 有 id 的 div。新方法保留一份原 HTML，在组件后内联引导将原节点移入 DocumentFragment；首次 click/键盘/toggle 恢复节点，无克隆、无额外请求，无 JS 时保持原始结构。 |
| [Section Rendering 性能方法](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-section-rendering-api)；[API 合同](https://shopify.dev/docs/api/ajax/section-rendering) | `section-fetch-single` / `section-fetch-json` | CDP 请求 initiator 精确映射到当前 JS 的原生 fetch 调用；必须是首屏同源同路径、≥100ms 的 HTML GET，且页面包含真实 LCP 区块。将已存在的整页 HTML 请求改成 section_id 或 sections，保留原 `.text()/DOMParser` 消费链。 |

这是解析器支持的子集，不是对任意主题逻辑的自动重写。隐藏组件有脚本、样式、自定义元素、模板、嵌套 render/include 或有副作用的 Liquid 时拒绝生成。动态输出须以 escape/escape_once 结束；不包装可能输出任意 HTML 的富文本，防止关闭 template/noscript 破坏文档。DOM 延后不会减少原始 Liquid 运算。hidden-detach 也不减少初次 HTML 解析成本，只影响后续样式计算/DOM 扫描；必须审阅内联脚本 CSP 和组件初始化依赖。旧 template + noscript 会复制 HTML，外部引导再增加请求，只保留为显式对照生成器，不参与 improve 自动/显式恢复选择。

Section API 生成器用稳定子节点选择器查找**当前**页面真实 `shopify-section-*` ID，不复制另一个预览主题的 ID。保留语言路径、页码和筛选参数。拒绝有请求 options、fetch/globalThis 等被遮蔽、跨域、已有 section 参数和不唯一的区块；参数表达式只求值一次。调用方必须确实只消费选定区块 HTML，不依赖整页 head、其他区块、JSON 格式或原 Response 的 URL/额外头。JSON 入口只取一个区块，转换回 HTML Response。

500、null、空响应、区块 ID 不符、重定向或 5 秒超时回退原整页请求。不新增路由、历史导航、购物车写请求、多区块协调或任意弹窗服务器加载机制；也不以 section.index 为 nil 擅自省略服务端内容。

## Liquid 首屏补丁

依据 [首屏服务端输出](https://shopify.dev/docs/storefronts/themes/best-practices/performance/render-essential-content-server-side)，新增 `section-liquid-initial`。它在 Section fetch 的实测定位上，复用已有字面量 render 和 snippet，填入目标 section 的空容器；删除异步加载函数唯一的无参顶层启动调用，保留动态调用并转换为 Section API。不会把抓取到的 HTML 写死到 Liquid。

`plan-domain` 仍使用当前 candidateId，method 为 `section-liquid-initial`，sectionSelector 为目标容器；另加以下 `initialLiquid` 参数：

```json
{
  "targetFile": "sections/main-collection.liquid",
  "sourceFile": "sections/ajax-collection.liquid",
  "renderOffset": 24,
  "startupFunction": "loadCollection",
  "legacyView": "ajax",
  "update": {
    "triggerSelector": "#sort-control",
    "assertionSelector": "#first-product-title",
    "requestUrl": "https://example.myshopify.com/fr/collections/all?sort_by=title-descending&view=ajax"
  }
}
```

必须替换为实际文件、render 起始字符偏移、函数名和已审阅动态 URL。review 除 summary 与原有 Section 四项外，还要求 initialContentReviewed、startupSideEffectsReviewed、globalRenderInputsReviewed、dynamicUpdatesReviewed、controllerIsolationReviewed。目标必须是唯一字面量 id 的空容器，不能在 Liquid 条件中；render 来源不能依赖局部赋值或条件，参数仅支持字面量及已审阅全局对象。两个 section 的设置和 collection/product 上下文须实际一致；不同模板的 section settings 不能仅凭同名字段假定相同。启动函数若承担其他初始化副作用，不能批准此方法。复杂生成逻辑继续使用专门审阅补丁。

两种 Liquid 方法都要求资产只有目标 section 一个已知加载入口，并检查其他主题 JS、script、原生 javascript 标签和内联事件中的全局加载函数消费者；未证明的自由全局变量或无法管理的异步逻辑拒绝生成。动态引用及外部 App 的契约仍须在 controllerIsolationReviewed 中实际审阅。

`legacyView` 仅在原始 Ajax 使用 alternate template 时设置。候选 scoped 请求移除此匹配 view，使用当前模板的真实区块 ID 和设置；失败回退仍使用原 URL。其余语言路径与查询参数保留。

内联候选仅支持观测到无脚本 CSP 限制或有效脚本指令明确允许裸内联的页面；多 Header/Meta 策略取交集，nonce/hash/strict-dynamic 不以 unsafe-inline 字面量绕过。不会写入静态 nonce 或放宽策略。候选必须重新采集 CSP、浏览器违规事件和已运行的控制器版本签名；旧行为证据缺字段时须补采。

回归配置须设置 `serverRenderedSelectors:["#目标容器"]`：采集独立禁用 JS 的页面、原始 HTML 哈希及 DOM/布局。先 checkpoint 初始容器，再点击/键盘操作 update.triggerSelector，紧跟 update.assertionSelector 的内容断言，最后 checkpoint 更新后的容器。操作前内容必须与预期更新内容不同。门禁验证禁用 JS 与正常首屏一致、没有原内容端点的启动 fetch、更新请求确实在操作之后发出并成功返回当前区块。HTTP 失败、错误正文、未完成请求和回退不得冒充优化成功；其他 App 的无关请求保持正常。

恢复机制将此方法与 scoped HTML/JSON 请求缩减区分。后两者无收益时可选 Liquid 首屏；Liquid 首屏仍无收益时，该机制也耗尽；若原始 trace 指向剩余控制脚本请求，可选 section-liquid-inline 消除该请求，否则须基于新证据换瓶颈，不通过调整等待时间或重测通过。既有门槛全部保留。

`section-liquid-inline` 使用相同 initialLiquid 参数，额外要求 inlineScriptAllowed，并要求当前部署绑定 profile 采集了 CSP。仅接受展开后不超过 4KiB 的独立控制器，且只有加载函数和 document 事件代理注册；拒绝其他文件引用、非标准 defer 标签、脚本结束符或 Liquid 定界符。控制器移入目标区块，原资产改为迁移注释，不新增首交互等待；控制器通过版本签名按当前区块挂载，编辑器 unload 时移除业务监听并取消请求；load 时重新绑定，旧响应和过期排序请求不能覆盖新内容。4KiB 为加生命周期包装前的控制器预算，完整内联代码另限 8KiB，均为工具保守边界。外部控制器方法也采用相同生命周期管理，并保留原 script 标签的 nonce。

可重复执行 `PERF_KIT_BROWSER_TESTS=1 node --test tests/section-liquid-browser.test.mjs` 和 `node scripts/validate_section_liquid.mjs`。后者生成完整主题副本、实际补丁、Theme Check、探索与双设备正式报告，最多 26 次 Lighthouse；首轮不 promising 则停止正式测量并保留负结果。第二机制使用 `--inline --previous=/absolute/previous-run`，重新定位并保存上轮正式失败与调整依据；每种机制仍固定最多 26 次，不重复测同一补丁。它使用实际 LiquidJS/Chrome，但 Shopify source-pull 与 API 由本地夹具提供，不能证明商家主题或 Shopify 服务端收益。

## 获取定位证据

沿用 [域证据采集](domain-optimization.md) 的 `profile-domain` 配置。隐藏 DOM 与 Section fetch 需要 runtime 模式；查询还需 liquid 模式的真实 Shopify CLI 原始 profile，同页面配套 runtime 数据确定设备。

```sh
node scripts/perfkit.mjs profile-domain --config /absolute/runtime-config.json --out /absolute/runtime-profile
node scripts/perfkit.mjs profile-domain --config /absolute/liquid-config.json --out /absolute/liquid-profile
node scripts/perfkit.mjs diagnose-performance --project /absolute/candidate-theme --profiles /absolute/profile-paths.json --liquid /absolute/liquid-profile/profile.json --limit 20 --out /absolute/diagnosis.json
node scripts/perfkit.mjs shopify-methods --format full --out /absolute/methods.json
```

非查询任务省略 `--liquid`。候选 kind 分别为 liquid-query、hidden-dom、section-fetch；包含准确文件、偏移、源码哈希、运行证据和可用 methods。默认目标仍为 score；用户明确要求单项加载指标时，诊断与实验统一使用 loading 目标。隐藏 DOM 默认提出 TBT 假设；Section fetch 提出 LCP 假设。它们不证明真实用户 INP 改善。

## 生成补丁

`plan-domain` 配置示例（审阅字段须实际检查后再改为 true）：

```json
{
  "schemaVersion": 1,
  "candidateId": "当前诊断返回的候选 ID",
  "method": "hidden-detach",
  "review": {
    "summary": "填写实际组件、共享引用、依赖与无 JS 语义的审阅",
    "initiallyHiddenReviewed": false,
    "dependencyLifecycleReviewed": false,
    "noJsFallbackReviewed": false,
    "allStatesReviewed": false,
    "inlineScriptAllowed": false
  }
}
```

其他合同：

| 方法 | 额外参数 | 必需 review 字段（另有 summary） |
| --- | --- | --- |
| query-limit | 无 | profileHotspotConfirmed、loopScopeReviewed、paginationIsolationReviewed |
| query-paginate | 无 | 上述字段 + paginationPagesReviewed |
| hidden-detach | 无 | initiallyHiddenReviewed、dependencyLifecycleReviewed、noJsFallbackReviewed、allStatesReviewed、inlineScriptAllowed |
| hidden-template / hidden-template-chunked（旧版对照） | 新的 assets/name.js | initiallyHiddenReviewed、dependencyLifecycleReviewed、noJsFallbackReviewed、allStatesReviewed |
| section-fetch-single / section-fetch-json | sectionSelector，如 #product-main | responseScopeReviewed、sectionSettingsReviewed、fallbackReviewed、allStatesReviewed |

```sh
node scripts/perfkit.mjs plan-domain --project /absolute/candidate-theme --diagnosis /absolute/diagnosis.json --config /absolute/plan-config.json --out /absolute/plan.json
```

`plan-official` 也可用：选表格中的官方 methodId，executor 为 `domain:方法名`，将 newAsset / sectionSelector 放在 parameters 内，并在 review 添加候选文件 sourceHash。输出真实 before/after、diff 和 planHash；审阅后沿用 apply、明确同步到候选未发布预览，再开始实验。

## 实测验收不能省略

查询执行 `experiment-liquid`，输入每侧三次探索、五次正式的独立原始服务器 profile。工具核验文件 self-time 和总区间成本；TTFB、导航分数或模拟 Liquid 数据不能替代它。新增 paginate 还必须在回归里对基线采集的第一页 URL（无 page 时原样使用）和同上下文 page=2 在每个被测 viewport 做 `selector:"body"` 的完整 checkpoint，对比顺序、数量、导航和内容。query-limit 同样要求完整 body；页头或无关组件不能替代查询内容证据。工具为额外回归页面单独采集前后部署证明；正式验收将 page 1/2 纳入页面矩阵及回归范围。

隐藏 DOM 的回归必须包含实际状态变化，并在第一次关闭前核验完整内容：

```json
[
  {"action":"click","selector":"#filters > summary"},
  {"action":"assert-visible","selector":"#filter-body","visible":true},
  {"action":"assert-count","selector":"#filter-body > p","count":320},
  {"action":"checkpoint","selector":"#filter-body","key":"first-open"},
  {"action":"click","selector":"#filters > summary"},
  {"action":"assert-visible","selector":"#filter-body","visible":false},
  {"action":"press","selector":"#filters > summary","key":"Enter"},
  {"action":"assert-visible","selector":"#filter-body","visible":true},
  {"action":"checkpoint","selector":"#filter-body","key":"opened-content"}
]
```

按实际内容增加 count/text/attribute 断言，分批插入必须先等待完整内容。验收核验每次操作前后的真假变化、键盘、完整打开内容及布局；JS 补丁（包含内联）还比较从操作到连续就绪断言结束的时间，不能只计外壳可见的时间。示例 count 和选择器须按实际主题内容填写。生成器测试覆盖禁用 JavaScript 与编辑器替换后重载；目标主题自身的初始化依赖、编辑器和无 JS 使用方式仍须具体审阅，不由一个通用场景代替。

Section fetch 必须 checkpoint 到 sectionSelector，并有 click/press + 业务断言测试原消费者。采集真实 fetch 状态、完成标志、响应体哈希和实际区块正文解析结果。候选响应须包含当前区块；空值、错误 ID、缺失正文或发生原整页回退都不能作为优化成功证据。不能用无关按钮或提前存在的静态内容掩盖请求失败。

以上行为检查通过后才进行前后交替的独立 Lighthouse 导航样本；正式验收继续要求原评分门槛、完整矩阵、无其他指标退步和内容视觉审阅。常规请求不被屏蔽。

## 无收益后的调整

`improve prepare` 用 `domain` 字段和 `method:"next"` 选择未测试方法；`candidateId:"next"` 允许转到另一假设。有效无收益、未确认或回归后实际回滚（包括删除新增 JS），记录方法与补丁指纹并重诊断。

恢复报告包含 `gainCeiling` 与 `reassessment`：保留失败实验地址、退步指标/中位数、已否定机制和下一步假设。`costEvidence` 从已绑定原始报告哈希的 LHR 重新提取传输字节、文档体积、脚本请求数和 observed/simulated FCP 分布；原始文件改变时不使用该辅助诊断。模拟 FCP 与 observed FCP 方向不一致时要求检查临界路径，仍保留原退步判定，不重采到通过。若原指标总值都小于最低收益门槛（如 TBT 0 < 50ms），不再生成该指标的候选，选择其他已测瓶颈。

旧隐藏 DOM 两种模板具有相同初始加载机制，批量大小不能作为初始指标失败后的新方案。单份 HTML 原节点停放改变传输和启动机制，但仍须独立测量；失败后换瓶颈或补采新证据，不自动退回旧模板。Section API 的 HTML/JSON 归为同一个请求缩减机制；任一个有效无收益后，不能换格式再赌分。显式 method、official 和附带 domainMethod 的计划入口都受同一检查。无效证据不否定机制，修复采集后仍可重试。查询只对原结构提供语义安全的一个方法，没有收益时换候选或重新采集热点，不为了凑重试而给固定轮播加 paginate。方法耗尽时保留负结果，不重复测同一补丁，不降低门槛或自动增加预算。

## 可重复验证

```sh
npm run test:extended
npm run test:extended-browser
npm run test:extended-live
node scripts/validate_extended_recovery.mjs
```

单元测试使用合成证据验证解析、门禁与会话状态；Chrome 测试运行真实生成补丁；live 脚本运行真实 Lighthouse 探索，保留负结果并换方案。只在本地人工夹具模拟 Shopify source pull 和 Section API；不伪造 Shopify Liquid 服务端收益。新增恢复脚本固定最多 30 次 Lighthouse（五种开销对照各三次 + 基线三次 + 两轮各六次），不自动加码。复审结果见 [闭环复审](extended-review.md)，历史结果见 [上次验证记录](extended-validation.md)。商家项目地址尚未提供，店铺实际评分与服务器查询收益仍待真实预览验证。
