# 页面评分验收约定

## 本项目的默认目标

同一页面、同一设备和状态的优化前后各至少五次独立 Lighthouse navigation 报告。按用户要求，移动端至少 75 分，桌面端更高；默认采用下列可配置验收门槛：

| 设备 | 优化后每次最低分 | 优化后中位数目标 |
| --- | ---: | ---: |
| 移动端 | 75 | 80 |
| 桌面端 | 85 | 90 |

中位数目标为运行波动留出余量；超过目标仍然通过。桌面端 85/90 是本工程的默认更高门槛，可根据实际项目明确调整。该目标是项目约定，不是 Google 或 Shopify 对所有商店的保证。

当前没有指定主题的基线和优化后报告，结果为**未验证**。从性能分数 75–80 不能推出全部指标为绿色、真实用户 CWV 通过或购买功能通过。

## 固定测试范围

开始时记录主题源码路径与 commit/文件指纹、预览 URL/主题 ID、首页/代表商品页/集合页等目标页面、移动或桌面设备、地区、同意状态、App 配置、内容、缓存状态和机器负载。每个页面、设备和状态单独成组，不能用全站平均分掩盖未达标页面。正式执行前由用户确认实际页面与口径；尚未指定时优先规划移动端，桌面另测。

使用 `measure` 按 [测量配置](measurement.md) 运行固定版本本地 Lighthouse 或 PSI，也可导入外部原始 JSON。保留全部有效样本，串行测量以减少资源竞争；无效页面、密码页、重定向、运行错误或内容变化先查明，不挑最好的一次、不复制单份报告凑次数。PSI 返回的 `lighthouseResult` 可直接导入。

报告需锁定 Lighthouse/浏览器版本、URL 和完整 `configSettings`。新门槛命令要求浏览器标识含有效 Chromium/Chrome 版本，且具有明确节流方式和所需数值配置；环境证据不足时拒绝验收。`throttlingMethod=provided` 表示实际环境由外部提供，其节流参数不由 Lighthouse 应用，工具将其标为需复核，不能自动通过。前后比较仅忽略 `preview_theme_id` 参数，其余差异拒绝自动比较。工具检查报告字段和重复 `fetchTime`；真实内容、主题身份和相同业务状态仍需核对，JSON 不能独自证明这些事实。

## 执行门槛检查

整站流程使用 `verify-site --before <测量目录> --after <测量目录> --out <新结果.json>`，校验相同引擎、完整页面/设备矩阵、报告路径与样本，然后逐组调用下述评分器。仅所有组通过才返回 `score-targets-met`；任一组未达标、需复核或证据无效都会阻止通过。`--thresholds` 可接收 [设备门槛示例](../assets/examples/thresholds.json)。外部已有报告按以下单组命令验收。

```sh
node scripts/perfkit.mjs score-target --before /absolute/path/to/run/lhr-before --after /absolute/path/to/run/lhr-after --out /absolute/path/to/run/score-target.json
```

以上命令从项目根执行，按报告的 `formFactor` 识别设备并使用对应门槛。输出必须为新文件，位于两个原始报告目录及其子目录之外。`--minimum` 是优化后各次最低分门槛，`--target` 是中位数门槛，范围为 0–100 且 minimum ≤ target。显式参数覆盖对应默认值，改变门槛需在交付中明确记录。移动/桌面分组验收，不能混合报告或拿一端结果代替另一端。

| 结果 | 退出码 | 含义 |
| --- | --- | --- |
| passed | 0 | 所提供报告达到评分门槛且没有运行警告 |
| failed | 3 | 最低分或中位数未达到门槛 |
| review-required | 3 | 原报告含运行警告或使用外部 provided 环境，需复核实际运行条件 |
| 输入/执行错误 | 2 | 样本不足、分数无效、环境证据缺失、运行重复、环境混合、文件错误或输出位置不允许 |

命令输出前后分数范围与差值，也保留报告路径和运行警告。分数门槛通过仅对应该批实验室样本；功能、视觉、指标退化和是否发布仍要另行审阅。已有高分主题的下降也会体现在差值中，不能仅看是否高于门槛。

## 主题交付还要满足

- 所有约定页面和设备组都有真实报告；缺测明确列出，不写“全站通过”。
- 保留素材、文案、布局、移动/桌面展示和画质，实际查看相关截图。
- 对受影响的菜单、轮播、变体、加购、购物车、搜索、同意及必要统计执行回归，记录证据；测试支付只在具备相应条件且已获授权时进行。
- 代码、补丁与回滚记录可对应到实际主题版本，发现回归时修复或撤回。
- 仍未达标时列出瓶颈、已做改动、第三方或平台限制以及需要的业务取舍，不能报告“保证通过”。

Google 说明 Performance 分数受运行条件影响，应结合多次测量理解；移动与桌面评分也有不同曲线。[Lighthouse performance scoring](https://developer.chrome.com/docs/lighthouse/performance/performance-scoring)

Shopify 的性能建议覆盖图片、JavaScript、CSS/字体和 Liquid，应依据真实瓶颈实施。[Shopify performance best practices](https://shopify.dev/docs/storefronts/themes/best-practices/performance)

## 0.9.0 提分与候选身份门槛

verify-site 在原门槛外调用 verify-gain，对分数和 LCP/TBT/CLS/FCP/SI 实质退步返回 performance-regressed；scoreTargetOutcome 仍记录原门槛结果。单独 score-target 保持 navigation_lab_score_target_only 契约。

完整优化使用 verify-optimization，另要求基线/候选测量前后 deployment 核验、当前候选哈希、可测分数收益、功能断言和内容视觉审阅。无收益、旧预览或缺失回归不接受。配置与噪声带定义见 [执行引擎](performance-engine.md)。
## 0.11.0 目标扩展

默认 score 模式及下述全部正式门槛不变。loading 允许声明目标指标收益，interaction 使用独立重复 Event Timing 证据，但完整优化仍要求原导航分数门槛、无实质指标退步、部署身份和功能呈现通过；CI 通过也不等于完整优化验收。详见 [目标与验收契约](evidence-driven-architecture.md)。

0.11.1 对 interaction 加严独立捕获、实际动作与事件窗口、前后部署范围一致性和目标 UI 断言。缺少新增执行记录的旧交互证据须重采；默认 score 的原最低分、中位数、5 次正式样本、可比性和退步检查保持不变。95→80 即使达到门槛且 LCP 改善，score/loading 的 CI 与完整验收仍不通过。

