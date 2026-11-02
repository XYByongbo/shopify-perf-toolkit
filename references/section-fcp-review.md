# Section API FCP 退步：原始任务与模拟图复审

日期：2026-10-23。本次确认了隔离主题中 FCP 双峰的机制，并修复测量和恢复实现。**没有撤销上一轮拒收，没有将本次诊断样本作为提分验收，也没有宣称真实商家主题已优化成功。**

## 原因与证据

原始浏览器 FCP 来自未应用模拟限速的采集阶段；Lighthouse `simulate` 的 FCP 则来自 Lantern 构建的网络/CPU 依赖图。两者的时间轴不同，不能直接相减来证明主题代码回归。

实际捕获了两种任务分组：

- 低模式：首次 Layout 所在任务只依赖主文档。`main.js` 未进入 FCP 图。
- 高模式：浏览器把 `EvaluateScript(main.js)` 和首次 Layout 放在同一 RunTask。Lantern 为保留首次 Layout，保留整个任务及它的脚本依赖，于是图变成 `Document → main.js → Layout`。即使脚本是 defer，也会通过这条 CPU 依赖被包含。

候选高模式样本中，脚本实际执行 **0.725ms**，11.741ms 开始、12.466ms 结束；首次 Layout 在 **13.244ms** 开始。模拟图中主文档结束于 **601.2205ms**，脚本请求结束于 **752.441ms**，这条额外依赖消耗 **151.2205ms**；最终 FCP 为 **769.441ms**。Section 响应请求本身不在这个 FCP 图内。

原版也出现同样的 `EvaluateScript → 同任务 Layout`：脚本执行 0.306ms，模拟 FCP 768.0663ms。因此不能将整段约 150ms 的差异归因于新增的 Section API helper。初始 fetch 在 await 处交还主线程，之后才把响应写入 hero；没有发现需要通过延后脚本执行来修复的同步首屏 DOM 写入。

先补采了固定一对原版/候选导航，两者均为低模式。随后执行一次预先固定顺序 `前、后、后、前、前、后` 的 3+3 诊断批次，全部保留，未设置“测到通过”为止的退出条件。六份原始 trace/log 都能精确离线重放 LHR：

| 样本 | 模拟 FCP ms | 原始 FCP ms | FCP 图包含 main.js |
| --- | ---: | ---: | --- |
| 1 原版 | 662.1697 | 69.150 | 否 |
| 2 候选 | 629.7316 | 32.602 | 否 |
| 3 候选 | 769.4410 | 43.684 | 是 |
| 4 原版 | 768.0663 | 24.831 | 是 |
| 5 原版 | 774.3316 | 63.158 | 是 |
| 6 候选 | 626.55385 | 46.165 | 否 |

同一份源码就能出现两种图。只比较 3 次样本中位数，会受到两种模式比例的影响。旧六次测量没有保存 trace/log，无法逐次还原它们的任务边界；此次证实的是同源码夹具可复现的机制，不能伪造旧样本的因果证据。

原始记录：[固定诊断批次](/private/tmp/perfkit-section-fcp-jmDGwD)、[六份重放分析与哈希](/private/tmp/perfkit-section-fcp-jmDGwD/offline-review/summary.json)、[最初诊断对](/private/tmp/perfkit-section-fcp-Ha4gow)。旧失败记录仍在 [上一轮审查](extended-review.md) 中。

## 实现调整

1. `measure` 默认开启 Lighthouse 原始资产保存；每次导航单独归档 trace、网络日志和 FCP 分析，LHR 文件保持原值。
2. `fcp-diagnostics.mjs` 使用固定 Lighthouse 版本和原始配置离线重放，列出观察/模拟耗时、实际网络依赖、脚本与 Layout 同任务证据。错配原始数据、版本不同、指标不能重现时不输出可信原因。
3. 实验样本合并复制所有证据并校验哈希。恢复流程逐份读取原始绑定，不依赖容易丢失的临时 sample 目录引用。
4. `recovery-cost` 检测同源码样本的 FCP 依赖图变化。原版和候选均出现任务合并时标记 `shared-task-coalescing-sensitivity`；恢复原因由笼统的“优化机制失败”改为明确的 FCP 因果待核对。
5. 所有这些诊断均保留原性能门禁、原拒收和同机制禁止重试。没有修改 Lighthouse 模型、FCP 100ms 回归线、MAD 规则或评分目标。Section helper 没有添加定时器/帧等待来改变采样时的任务边界。

本次修复的是错误归因与缺失的诊断能力，不是用新的高分替换旧结果。真实首屏内容如果仍依赖 Ajax，下一种有实际成本差异的实现应由当前主题的 Liquid 内容与配置决定；单纯切换 Section HTML/JSON 格式不能消除首屏请求链。

## 验证与边界

维护入口：本次固定 3+3 采样使用的一次性脚本已移除；高/低模式原始数据继续保存在 `tests/fixtures/lantern-fcp/`，可用 `node --test tests/fcp-diagnostics.test.mjs` 离线复核。新的已保存报告使用 [测量约定](measurement.md) 中的 `inspect_lantern_fcp.mjs` 回放，无需重新采样来验证本次结论。下列次数与结果仍描述 2026-10-23 的历史验证。

- 固定浏览器诊断 8 次（1+1 初次诊断、3+3 模式诊断）；最后的六次通过实际 `measure` 保存与重放。无新验收轮次。
- 保存两份真实浏览器高/低模式为压缩回归夹具（去除截图与无关 LHR audits），测试无需启动浏览器即可精确重放 629.7316 / 769.441ms，并确认对应脚本依赖和任务边界。
- 覆盖缺失资产、错配 trace、修改 FCP 值、文件篡改、路径逃逸、符号链接、复制后原目录删除、归档文件污染 LHR 目录，以及诊断不能覆盖评分/允许原补丁重试。
- 最终相关测试 104/104 通过（FCP 诊断、测量器、成本诊断、恢复会话）。全量检查当时 558 项：529 通过、28 环境跳过、1 项被沙箱禁止 localhost 监听；该 HTTP 文件在允许监听的环境单独复核 12/12 通过。之后新增的实际归档闭环用例包含在最终 104 项检查内。CLI 重放也精确复现 769.441ms。
- 未修改主题 Liquid/CSS/JS 生成内容，因此本次没有新的 Theme Check 对象。实际商家 URL 尚未提供；本地服务器中的 900/60ms 响应延迟是人工夹具条件，不能当作 Shopify 服务端收益。

Shopify 官方将 [Section Rendering API](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-section-rendering-api)用于动态更新，并建议[首屏关键内容直接由 Liquid/HTML 输出](https://shopify.dev/docs/storefronts/themes/best-practices/performance/render-essential-content-server-side)。模拟与实际限速的区别见 [Lighthouse throttling](https://github.com/GoogleChrome/lighthouse/blob/main/docs/throttling.md)。任务保留和依赖构建已核对本项目锁定的 Lighthouse 13.5.0 及其 trace-engine 源码。
