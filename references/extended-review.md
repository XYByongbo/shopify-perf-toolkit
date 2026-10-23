# 三类闭环复审：隐藏 DOM 退步与有效证据

日期：2026-10-23。此次完成工具修复与验证，**没有获得可以接受的整轮性能补丁**。30 份 Lighthouse 报告全部来自隔离人工主题；商家主题地址尚未提供，Shopify Liquid 服务端未实测。结构化结果见 [extended-review.json](extended-review.json)，历史负结果保留在 [extended-validation.md](extended-validation.md)。

## 已确认的问题与修复

| 问题 | 修复与验证 |
| --- | --- |
| 旧隐藏模板复制 HTML，并引入额外 deferred 脚本；两种方案只在首次交互时的分批插入上不同 | 新增 `hidden-detach`：保留一份原 HTML，组件后内联引导将原节点暂存于 DocumentFragment，首次操作恢复；无需额外请求。禁用 JS 保留直接子节点结构。需要明确 CSP/初始化依赖审阅。 |
| 方法名不同就允许重试，同一优化机制没有被排除 | 旧隐藏模板标为 `comparison-only`，不能用于 improve；HTML/JSON Section 请求归为同一机制。有效失败后，显式方法、official 路由和有域合同的计划均不得绕过。无效测量允许修复证据。 |
| TBT=0 仍建议继续尝试 TBT 优化 | 恢复读取原始基线与失败实验，计算指标全部降到零也无法达到的收益上限；例如 0ms 无法达到 50ms 最低收益时切换其他已测瓶颈。没有足够证据则停止，不更改目标。 |
| 只检查第三次展开内容，可能漏掉第一次展开缺失；只计外壳可见的时间 | 强制首次关闭前的完整内容 checkpoint；连续 assert-visible/assert-count 的总耗时纳入响应检查。内联 JS 与独立 JS 同样受检。该时间是回归保护，不冒充 INP。 |
| 旧分批插入中断后可能残留部分内容，已完成 Promise 阻止恢复 | 改为移动 template 原节点，未移入的节点留在 fragment，任务完成/中断后清理 pending；实际 Chrome 中断、重新挂载验证没有重复或缺失。 |
| 分页 page 2 可以用无关页头检查点通过；其他 viewport 可冒充本 viewport 的 page 2 | query-limit 要求完整 body；query-paginate 在每个被测 viewport 要求原第一页 URL 和同上下文第二页的 body checkpoint。查询仍先通过独立 Shopify 原始 Liquid profile 门禁。 |
| 失败后只能看到通用“换方案”，缺少新增成本分析 | `reassessment` 保存失败实验、退步指标、机制、收益上限；`costEvidence` 从有原始报告哈希绑定的 LHR 提取实际样本分布、文档字节、脚本请求和 observed/simulated FCP。文件缺失/变更不能作为新的成本结论。 |

`hidden-detach` 不减少初次 HTML 解析和 Liquid 运算；它改变后续活动 DOM 的成本。任何依赖初始隐藏节点扫描的主题都必须审阅和验证。旧 `<noscript>` 外包结构还可能改变无 JS 的直接子元素 CSS 匹配；新实现保留原结构，旧方法只用于显式对照。

## 隐藏 DOM 开销对照

相同 320 条静态内容、相同本地服务及 Lighthouse 配置，每组 3 次探索。以下为中位数：

| 变体 | FCP ms | LCP ms | TBT ms | 总传输字节 |
| --- | ---: | ---: | ---: | ---: |
| 原始 details | 619.65 | 750.76 | 0 | 6,054 |
| 仅 template + noscript 双份正文 | 620.49 | 750.75 | 0 | 11,448 |
| 仅增加外部运行脚本 | 768.09 | 918.09 | 0 | 8,009 |
| 旧完整模板方案 | 618.37 | 900.77 | 0 | 13,403 |
| 新单份 HTML 停放原节点 | 623.75 | 624.45 | 0 | 7,468 |

结论：这个夹具没有 TBT 可优化。复制正文明显增加字节，但没有在这一组测量中单独造成显著 FCP 退步；外部脚本与额外加载依赖带来明显的模拟 paint 成本。旧完整方案的 FCP 会在约 620/770ms 两种模式间变化，不能把历史每一次 FCP 退步都确定归因于字节数。分批策略在交互后才运行，无法修复初始加载路径。

新方案消除了额外请求和重复正文，本组没有显著 FCP 回归；126ms 的 LCP 改善小于 200ms 最低收益门槛，TBT 仍为零，**不作为有收益结果**。

## 真实恢复会话结果

同一个人工主题同时含隐藏 details 和首屏整页 fetch；原目标固定为 loading/LCP。服务端明确设置整页响应 900ms、区块响应 60ms，用来验证请求范围变化；它不是对 Shopify 真实服务器速度的模拟证明。

| 轮次 | 实际动作 | 独立样本与结论 |
| --- | --- | --- |
| 1 | 生成并应用 hidden-detach | 3 前 + 3 后，LCP 1967.62 → 1967.93ms，无收益；真实回滚。 |
| 2 | 重新诊断，从隐藏组件切到实际 fetch initiator，生成 Section API 补丁 | 3 前 + 3 后，LCP 1960.45 → 1068.24ms，但模拟 FCP 625.48 → 767.16ms，触发 100ms 回归门槛；拒收并回滚。 |

第二轮原始 observed FCP 是 37 → 23ms，和模拟 FCP 方向不一致。恢复报告明确标记 `simulated-fcp-regression-not-reproduced-in-observed-fcp`，要求检查已有 trace/模拟临界路径。observed 值是在未应用模拟限速模型的采集阶段获得的，**不能替代模拟评分指标，也不能用来撤销回归结果**。没有重测到通过、降低门槛或将目标换成更容易通过的指标。

后续专项审查已捕获原版和候选的两种真实任务分组：同任务内的脚本执行与首次 Layout 会使 Lantern 多保留一条脚本请求依赖，造成约一个 RTT 的跳变。测量器已补齐每次 trace/log 保存和自动离线重放；详情见 [Section FCP 原因与实现修复](section-fcp-review.md)。此补充不改变这里保存的原拒收结果。

初版验证脚本预设第二轮一定应通过，其断言在此失败；已修正为如实保存有效拒收结果。最终当前合同复核重新采集了前后首开、重开和 Section 消费行为，并复用原始 Lighthouse 报告，新增测分数为 0。两轮均 `preservation: preserved`，结论仍分别为无收益和性能退步。当前恢复结果 `nextDomainStep: null`：不会退回旧隐藏模板，也不会换 JSON 格式再赌分。

因此，本次验证证明的是“重新定位另一瓶颈、实际生成不同机制补丁、实测并严格拒收副作用”的闭环；**没有证明可以在这个样本上得到最终可接受的提分，更没有证明任意主题必然提分**。

## 检查与复现

- 全量 Node：550 项，522 通过、28 按环境跳过、0 失败；新增负例全部通过。Chrome 三项测试全部通过：隐藏节点/首开/键盘/无 JS/编辑器重载/中断恢复，Section 输出与实际请求范围，以及 null/500/错误区块/超时回退。
- Theme Check：完整最小主题上下文，前后均 0 error；候选只有原有分页 `UnusedAssign: skip` warning。保留赋值以避免破坏未知的下游共享消费者，没有关闭规则。新隐藏补丁不足 40 行引导 JS，无新增资产；这是项目预算复核，不是 Shopify 平台限制。
- 对原始报告哈希不匹配的成本读取实际返回 unavailable，旧报告未修改。
- Liquid 输出模型、分页合同和原始服务器证据门禁已测；没有商家原始 profile，不能报告 Liquid 查询耗时下降。

```sh
npm test
npm run test:extended-browser
node scripts/validate_extended_recovery.mjs
# 仅重采行为并复核已有原始报告；不给测分追加预算：
node scripts/recheck_extended_evidence.mjs /absolute/prior-output /absolute/new-recheck-output
```

完整开销与会话脚本上限 30 份 Lighthouse：对照 15、会话初始基线 3、两轮候选各 6。错误和负结果全部保留。实际主题仍需自己的 preview、源绑定测量、浏览器/服务器证据和正式完整矩阵。

原始证据：[对照与恢复会话](/private/tmp/perfkit-extended-review-RyuFV5)、[当前合同复核](/private/tmp/perfkit-extended-review-RyuFV5/final-contract-recheck)、[Theme Check](/private/tmp/perfkit-review-themecheck-1T15Qp)。

官方依据：[Lazy DOM rendering](https://shopify.dev/docs/storefronts/themes/best-practices/performance/lazy-dom-rendering)、[限制查询与分页](https://shopify.dev/docs/storefronts/themes/best-practices/performance/limit-product-queries-with-pagination)、[Section Rendering API](https://shopify.dev/docs/api/ajax/section-rendering)。这些文档指导成本与语义边界，没有承诺每个主题或每次变换都会提高评分。
