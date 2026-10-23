# Liquid 首屏实际补丁与无收益调整验证

后续共享依赖、CSP、编辑器生命周期和正式失败恢复的审查修复见 [复审记录](section-liquid-review.md)。本文保留上一版补丁的历史测量，不作为修复后代码的性能证据。

2026-10-23。本次实现修改主题代码，并跑完两种不同机制的实际 Chrome/Lighthouse 验证。第二方案在本地隔离 Liquid 主题上正式通过 `loading / lcp` 目标；商家主题与未发布预览尚未提供，不代表已验证商家店铺、Shopify 服务器耗时或真实用户 CWV。

## 官方依据与实际改动

Shopify 要求[首屏必要内容由 Liquid/HTML 输出](https://shopify.dev/docs/storefronts/themes/best-practices/performance/render-essential-content-server-side)，并建议[动态更新使用 Section Rendering API](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-section-rendering-api)。[API 文档](https://shopify.dev/docs/api/ajax/section-rendering)要求保留页面/语言上下文，并处理区块渲染失败。本次据此新增两种可生成、应用、回滚和验证的真实补丁：

- `section-liquid-initial`：将已有 `{% render 'catalog-content', collection: collection, section: section %}` 放入首屏空容器，复用原 snippet；删除唯一的 `load()` 启动调用，保留原动态调用，替换内部 fetch 为当前区块的 Section API。
- `section-liquid-inline`：在相同 Liquid 首屏输出上，把小型独立控制器移入区块，消除其外部请求。仅允许展开后 ≤4KiB、没有其他源码引用、仅包含加载函数和事件代理注册的控制器，额外审核 CSP/全局依赖。以 Symbol 防止编辑器重复执行后重复注册监听。原资产只保留迁移注释，没有两份运行代码。

内联是本次原始依赖图支持的工程选择，不是“所有主题都应内联 JS”的 Shopify 规则。当前控制器 2962 字节，最终 section 共 61 行、3408 字节，低于项目组件 JS 200 行与 Section 主体 300 行复核线；这两个行数预算及 4KiB 边界均为项目约定。

目标 Liquid 中存在局部赋值/作用域副作用、render 依赖局部变量、初始容器非空或有条件、启动函数有其他副作用、脚本被其他文件引用等情况，须拒绝此自动方案或另做具体实现。替换渲染上下文必须实际审阅，不能假定两个模板中同名设置的值相同。

## 第一方案真实失败，再改变机制

第一方案探索 3+3 次时 LCP 约 1069→768ms，结果 promising。但随后移动/桌面前后各 5 次正式测量中，移动 LCP 为 **1064.75→916.31ms**，只改善 **148.43ms**，低于原 200ms 收益线。正式结果 `not-accepted`，自动回滚，未用探索结果覆盖正式失败。

对失败样本原始 trace/devtools log 离线重放：报告与重放 LCP 均为 **918.0209ms**，observed LCP 为 40ms。依赖图中主文档模拟结束于 601.01ms，`main.js` 模拟请求结束于 902.02ms，关联 EvaluateScript/Layout 任务结束于 918.02ms。首屏 Ajax 已消失，但外部控制器仍进入模拟 LCP 依赖链。

因此第二方案消除该外部脚本请求，不增加 rAF、计时器、隐藏内容或首次点击等待。两轮所有样本保留，各固定 6 次探索加 20 次正式测量，共 52 次 Lighthouse；没有重复测同一候选到通过。第二轮重新采集定位证据，并保存上轮正式失败和改变机制的说明。

- [第一方案正式失败](/private/tmp/perfkit-section-liquid-FZAD2w/formal/verification.json)
- [原始数据绑定的 LCP 重放](/private/tmp/perfkit-section-liquid-FZAD2w/lcp-replay.json)
- [第二轮调整依据](/private/tmp/perfkit-section-liquid-wTjsM9/reassessment.json)

## 第二方案正式结果

每侧每设备 5 次，以下均为 Lighthouse 中位数。原评分要求移动单次/中位数 75/80、桌面 85/90 保持不变；收益线 LCP 200ms、FCP 100ms、MAD 噪声检查及其他指标无退步要求保持不变。

| 指标 | 移动端前→后 | 桌面端前→后 |
| --- | --- | --- |
| LCP | 1070.32→754.92ms（改善 315.39ms） | 288.49→204.08ms（改善 84.41ms，未达到单组 200ms 收益线） |
| FCP | 768.88→628.75ms | 207.33→169.65ms |
| Speed Index | 1663.64→628.75ms | 645.65→169.65ms |
| TBT / CLS | 0 / 0→0 / 0 | 0 / 0→0 / 0 |
| 性能评分 | 100→100 | 100→100 |

正式 `optimization-accepted`，9 项门禁全部通过：单补丁实验、原评分目标、声明目标收益且无其他指标退步、候选身份、补丁与实际源码一致、功能回归、回归部署绑定、方法特定行为、内容/视觉审阅。移动端达到 LCP 收益门槛；桌面端没有退步。不宣称桌面端独立达到 200ms 收益，也不宣称评分提高。

独立保留原始浏览器数据：observed LCP 移动 **929→44ms**、桌面 **937→50ms**；observed FCP 移动 39→44ms、桌面 34→50ms。不能将模拟 FCP 改善直接说成原始浏览器 FCP 改善；正式判定始终使用未改写的 Lighthouse 指标，未用 observed 替代门槛。原始 LCP 和首屏网络证明 Ajax 内容等待被实际移除。

## 内容、交互和生成器验证

完整主题包含 layout、两个 collection 模板、两个 section、已有 snippet、配置和本地化文件；使用实际 LiquidJS 渲染，不把响应 HTML 作为静态补丁。Shopify CLI Theme Check 对两轮 baseline/candidate 均返回 `[]`、退出码 0。

行为验证涵盖移动/桌面相同初始内容、几何与样式；禁用 JS 时的相同首屏；排序后确实发生 Alpha→Beta 内容变化；详情打开、内容替换后再次操作、重复更新、编辑器替换、空列表和不同 heading 设置；Section API 的 500、错误区块、超时回退。正常更新须有真实请求、GET 200、完成标志、响应哈希、当前区块 ID；失败回退只算功能保全，不能算成功优化。候选没有原始启动 Ajax，也没有 main.js 外部请求。

探索回归的两设备首屏与操作后截图共四对，各对 SHA-256 相同；DOM、样式、布局检查也均 preserved。门禁反例测试拒绝缺失无 JS 证据、缺失真实响应、未完成请求、错误区块、未发生内容变化、残留启动请求等情况。

最后一轮相关回归 **57 通过、0 失败、1 跳过**，包括两种 Liquid 补丁的真实 Chrome、旧 Section/隐藏 DOM、官方入口、方法恢复、场景采集和 HTTP 资源检查；内联脚本在编辑器替换后连续重执行两次仍只发出一次动态更新请求。全量单元运行先得到 535 通过、30 跳过，唯一失败为沙箱禁止本地端口监听；该 HTTP 测试已在最后一轮允许本地端口的环境中通过。[最终测试日志](/private/tmp/perfkit-liquid-final-tests.log)。

这里的 source-pull 使用本地复制适配器，Section API/数据延迟由测试服务器提供。真实 Chrome、真实 Lighthouse 和 Theme Check 不等于真实 Shopify 后端；本结果只验证生成器、浏览器机制与原验收流程。真实主题仍须审阅实际 snippet、section settings、App 依赖、CSP 和交互，再在未发布预览重复完整验收。

## 可审阅产物与重现

- [实际候选 Section](/private/tmp/perfkit-section-liquid-wTjsM9/candidate/sections/main.liquid)
- [完整可逆 plan](/private/tmp/perfkit-section-liquid-wTjsM9/plan.json)
- [主题补丁 diff](/private/tmp/perfkit-section-liquid-wTjsM9/theme.patch)
- [正式验收](/private/tmp/perfkit-section-liquid-wTjsM9/formal/verification.json)
- [内容交互对比](/private/tmp/perfkit-section-liquid-wTjsM9/experiment/preservation.json)
- [原始浏览器指标](/private/tmp/perfkit-section-liquid-wTjsM9/observed-summary.json)

运行方式：`npm run test:section-liquid-browser`；`npm run test:section-liquid-live`；第一轮正式失败后，`node scripts/validate_section_liquid.mjs --inline --previous=/absolute/first-run`。方法选择与参数见 [执行说明](extended-optimization.md)。`improve` 会将正式无收益记录为 formal-rejected，回滚、重诊断并排除已失败机制；两种 Liquid 方案均失败后必须换瓶颈或补充证据，不能降门槛继续重试。
