# LCP 身份与重复加载检查

0.19.0 新增四项工具自有运行检查，分类为 `integrity`，不冒用官方 Theme Check，也不替代原 11 组 P0 / 16 组 P1。用于第三方延迟加载、首页关键 CSS/媒体改造、LCP 数值异常或两主题差异核验。

## 入口

`profile-runtime` 默认采集身份和重复加载证据；`profile-domain` 的 runtime 模式沿用该采集器并增加前后部署证明。`audit-performance` / `diagnose-performance` / 整站报告通过已有 profiles 入口呈现检查；源码未绑定或失效的 profile 保持拒绝。单独复核已保存报告：

```sh
node scripts/perfkit.mjs audit-runtime-integrity --input /absolute/run/profile.json --out /absolute/run/integrity.json
node scripts/perfkit.mjs report --input /absolute/run/integrity.json --out /absolute/run/integrity.html
```

独立检查只接受 `runtime-profile`，从原始字段重算，不相信已有 `integrity.complete`。退出 0 为本窗口未见异常，3 为需复核/证据不完整，2 为输入或执行错误。`profile-runtime` 的 status 仍表示采集是否完成，新增 reviewRequired 表示诊断需复核，CLI 对后者退出 3。采集成功不等于性能优化成功。

配置新增两项（其他配置见命令参考）：

- `initializationEvents`：1–20 个唯一、非空、最长 100 字符的初始化事件名。默认 `StartAsyncLoading`、`StartKernelLoading`。只观察事件名、目标和时间，不读取 detail，不改写 dispatchEvent，不自动监听任意业务事件。
- `expectedLcpSelectors`：可选 1–10 个唯一、最长 500 字符的 CSS selector，由已核实主内容提供。期望错误也可能触发不匹配，因此不是自动认定异常意图。

[计时窗口示例](../assets/examples/runtime-integrity.json) 给 15 秒后加载器留出观察时间。另建一个含真实点击/滚动步骤的 profile 检查交互恢复，两者不要混成相同状态比较。默认 scroll 动作滚动 window，内部滚动容器须选择其具体可验证交互。readOnly 会拦写请求，不能证明真实加购、结账或统计可用。

## 四项检测与证据边界

| 规则 | 依据 | 不能推断 |
| --- | --- | --- |
| PERF_LCP_IDENTITY | LCP observer 的实际元素、祖先累计 opacity、display/visibility/content-visibility、视口覆盖、文字长度、字体尺寸及采集结束复核 | 作者意图、逐帧绘制状态、全部 CSS 滤镜/遮罩效果 |
| PERF_LCP_EXPECTED_TARGET | 实际 LCP 是否匹配调用方明确声明的 selector | selector 期望本身一定正确；LCP 必须是图片 |
| PERF_REPEAT_RESOURCE_REQUEST | CDP 中同主 frame、同 loader、同完整 URL 的多次 GET Script/Stylesheet 请求 | 一定重复下载、重复执行、可节省多少字节 |
| PERF_REPEAT_INIT_EVENT | 同事件名、同目标重复派发 | handler 一定重复执行、组件一定重复初始化；某业务事件本来就可能多次发生 |

LCP 的工具复核阈值：累计 opacity ≤ 0.01 或隐藏样式触发候选。近透明状态在采集结束仍存在、没有观察到正在运行的动画，同时是 ≤8 字符、覆盖至少 50% 视口、字体至少视口宽度的短文本时，升级为强异常。不是按 Γ 字符、主题名或固定 id 匹配。正常不透明的大标题、装饰图的 aria-hidden、负 z-index 单独不算异常。过渡动画仅保留较弱的复核候选。

`metricUse=hold-for-review` 表示当前 LCP 不可直接用于主内容速度收益论证。`no-anomaly-observed-not-acceptance` 仅表示已覆盖窗口未见该类异常；`not-assessed` 表示缺失/不完整。没有 LCP、旧报告缺身份字段、主题 ID 不符、源码漂移、祖先/历史截断均不能补为通过。样式采于 observer 回调和采集结束，不能重建准确 paint-time 状态。

请求按原始 URL 分组后才脱敏；保留 query 以区分版本/签名，忽略 fragment。重定向前跳、其他 iframe/文档、POST、重复存储的同一请求不合并为异常；预加载复用只有一次请求时不报警。记录完成/失败、缓存、阶段、发起者、已知 encoded bytes。重试保留 `retry-or-failure-review`，已知字节仅是观察值，不是预计节省。

最多记录 3000 个请求标识及 3000 个重定向跳，LCP 历史保留最近 20 条，初始化事件最多 500 条，祖先最多 32 层；达到限制显式 incomplete。iframe 内初始化、未声明事件、观察窗口后的计时器、无新增请求的缓存内重复执行不在完整覆盖范围。诊断禁用缓存且有采样开销，不能据此宣称常规用户下载了相同字节。

## 正式验收接入

`verify-optimization` 的 regression 可显式提供 `integrityProfiles: {before:[profile], after:[profile]}`；`optimize verify` 顶层和 `improve collect` 的 formal 同名字段也接收对象或 JSON 文件路径，每侧支持完整 profile 对象/文件路径数组。采用该门禁时必须使用部署绑定 `profile-domain` 输出，覆盖全部测量页面/设备，前后状态、动作、事件/selector 配置、浏览器和环境一致，动作完成、源码与店铺/主题身份匹配。

门禁从原始采集重算。任何异常、截断、缺字段或身份失效都令 `runtime-metric-and-loading-integrity` 不通过；没有“忽略并标通过”的布尔开关。修正来源后重新采集。为兼容旧流程，未提供 integrityProfiles 时新门禁显示 `not-assessed`，不改变旧验收结果；旧验收通过不能被描述为已完成新检测。诊断证据仍不替代每页/设备前后各至少五次正式评分、内容/视觉与购物行为回归。

## 本次主题审计沉淀的方法

1. **先核对基线和执行入口。** 不同框架、不同首页内容只能比较现状，不能把文件删除或主题原始字节下降算成补丁收益。追踪新增文件是否被实际引用、商家配置是否启用。
2. **视频先海报，屏外不抢占。** 保留首屏可见海报，按可见性加载/播放其余媒体；离开后暂停。图片首屏兜底仍须正确 eager / priority，不能所有图片统一 lazy。区分配置中的视频数量和实际发出的媒体请求。
3. **首屏样式先到，完整样式后到。** 关键 CSS 可以内联；完整 CSS 异步不是省掉字节，要验证断点、菜单、抽屉、语言和动态 section 的首次状态，以及内联/完整规则的一致性。
4. **一个入口一个调度器。** 用明确的 visible / interaction / idle 条件，保留依赖、原节点回调、失败重试、一次性状态与卸载清理。检测初始、首次交互和超时恢复三个窗口，不能只看导航采样窗口。
5. **保留平台与组件契约。** 不批量改写 content_for_header；不要用多个全局 DOM 拦截器叠加延迟 App。主题保护性代码（AbortController、disconnect、图片 error 收敛）不是冗余体积。
6. **先验证指标对象，再看分数。** 本次实际案例中近透明超大字符被记录为 LCP，不能算主视觉更快。该案例转化为通用检测和合成浏览器夹具，不把品牌、作者或特定字形写成规则。

原理依据：[Shopify 关键与非关键资源](https://shopify.dev/docs/storefronts/themes/best-practices/performance/defer-non-critical-resources)、[content_for_header 规则](https://shopify.dev/docs/storefronts/themes/tools/theme-check/checks/content-for-header-modification)、[web.dev LCP](https://web.dev/articles/optimize-lcp/)。官方原理不等于本工具启发式阈值的官方标准。

采集异常也保留已观察到的请求。网络窗口必须显式记录 `networkCapture.complete: true`；操作中断、trace 刷新失败或旧证据缺失该字段时，不能把“未检出重复”当作无重复。部分证据仍可报告已观察到的重复。
