# Liquid 首屏与内联控制器复审

2026-10-23。本轮审查发现实际功能风险，并修改生成的主题代码、CSP 证据和正式失败恢复逻辑。上一轮性能结论对应旧补丁；本轮产物和实测另行保存，不覆盖历史结果。

## 已修复的问题

| 问题 | 原来的漏洞 | 修复后的行为 |
| --- | --- | --- |
| 共享脚本 / 全局消费者 | 外部控制器方法直接删除资产里的启动调用，没有像内联方法一样检查其他模板引用；内联只搜资产名，其他脚本调用原全局 load() 可能被遗漏 | 两种方法共用入口归属检查；扫描其他主题资产、script、Liquid javascript 和内联事件中的加载函数消费者；未证明的自由全局变量、非 UI 注册和无法管理的异步逻辑拒绝自动生成。两种方法都要求 controllerIsolationReviewed，外部 App 和动态引用仍须实际审阅 |
| CSP | inlineScriptAllowed 审阅标志无法证明实际页面允许内联；原回归没有专门记录策略或执行身份 | 部署绑定 profile 记录 Header 和 Meta 策略；遵循 script-src-elem→script-src→default-src 及多策略交集。缺证据要求补采；严格策略禁止内联则保留外部方案。候选回归重新采集 CSP、浏览器违规事件及执行版本签名。原 external nonce 保留，不生成固定 nonce，不放宽 CSP |
| 编辑器卸载 / 添加 / 竞态 | 全局 Symbol 仅防重复执行；卸载后业务监听仍在，进行中的旧请求可能覆盖替换后的区块；旧测试主要克隆节点后重复执行脚本 | 生成按当前区块挂载的控制器：unload 移除业务监听、取消请求并失效化版本；load 重新绑定。每次更新有序号，过期响应不写入新 DOM，卸载导致的取消不触发整页回退或导航；重复 bootstrap 不增加监听，新代码签名可清理旧版本 |
| 正式无收益重诊断 | 会话保存了验证文件路径，但重诊断按对象读取，导致正式退步数据缺失；辅助成本分析只读探索目录 | 正式拒绝保存完整验证对象、文件引用和正式 before/after 路径。重诊断核验正式原始报告哈希与源码身份；旧路径格式也能恢复。Liquid 首屏失败后优先选择消除控制器请求的不同机制；已失败机制和指纹不能重试 |
| 累计收益未达标 | 单步通过但累计无收益时可能停留在等待补证据状态 | 对有效累计无收益同样回滚、记录 formal-rejected 并重诊断，保留固定基线、失败预算和正式样本 |

修改集中于 lib/section-liquid.mjs、lib/section-controller.mjs、lib/section-csp.mjs、lib/extended-plan.mjs、lib/scenarios.mjs 和会话/恢复模块。Section API 的正常错误回退继续存在；只有区块卸载时的主动取消会停止回退。

## 官方依据与实现边界

[Shopify 编辑器文档](https://shopify.dev/docs/storefronts/themes/best-practices/editor/integrate-sections-and-blocks)说明 section 内容会在不整页重载的情况下被替换，load 时重新初始化、unload 时清理。不能假定新 HTML 中的 script 自动执行。

[CSP script-src-elem](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src-elem)有自己的指令及回退顺序；[nonce/hash 与 unsafe-inline](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy)不能用简单字符串包含判断。因此当前裸内联生成器采用保守策略；nonce/hash 专用接入需单独实现，不复制预览响应中的 nonce。

动态引用、外部 App 全局契约和未经测量的其他页面不可能通过一次静态扫描完全证明。已有 bootstrap 的区块删除/重加已验证；从未加载过此区块控制器的页面首次在编辑器添加，仍需要主题自身提供初始化入口，不能声称通用覆盖。

项目预算为包装前控制器 ≤4KiB、完整内联脚本 ≤8KiB，另复核 JS 200 行；这些是项目约定，不是 Shopify 平台限制。

## 验证证据

真实 Chrome 测试覆盖 Header、Meta、多 Header 策略下阻止内联候选，以及严格 CSP 下外部控制器仍可运行；编辑器重复执行、unload 时的请求取消、替换后排序、删除/重加，以及原内容、无 JS、空数据、配置和失败回退。

会话状态测试使用明确标注的合成 LHR 与探索决策，但实际调用生成器、应用、回滚和重诊断：先生成 Liquid 首屏补丁，模拟 promising 后输入收益不足的正式原始报告，确认两份文件恢复、正式成本证据 verified、失败计数增加、相同方案被拒绝，并用 next 实际生成不同的内联补丁。也覆盖旧会话路径格式。该测试证明状态闭环，不冒充真实性能收益。

检查结果：完整单元运行 539 通过、0 失败、30 跳过；最终相关回归 59 通过、0 失败、1 跳过，包含旧 Section API/隐藏 DOM 的真实 Chrome；新增 Liquid 首屏与内联控制器的真实 Chrome 两项均通过，涵盖上述 CSP 和编辑器边界。旧版仅保存布尔标记且未保存清理函数的引导，不能在同一文档内无缝迁移其匿名监听，升级时须整页重载预览；自动测量/回归会新建页面，不接受旧版执行标记作为新候选证据。

## 修复版真实性能复验

固定最多 26 次 Lighthouse：前后各 3 次探索，promising 后移动/桌面每侧各 5 次正式；没有重复采样到通过。原移动 75/80、桌面 85/90 分数门槛、LCP 200ms 收益线、FCP 100ms 退步线和 MAD 检查保留。

| 正式中位数 | 移动端前→后 | 桌面端前→后 |
| --- | --- | --- |
| LCP | 1062.55→640.06ms，改善 422.48ms | 295.07→174.85ms |
| FCP | 633.18→640.06ms，增加 6.88ms，未达到退步线 | 212.72→174.20ms |
| Speed Index | 1593.16→640.06ms | 658.55→174.20ms |
| TBT / CLS | 0 / 0→0 / 0 | 0 / 0→0 / 0 |
| 分数 | 100→100 | 100→100 |

正式结果 optimization-accepted，9 项门禁全部通过。移动端 LCP 达到收益线；不把微小 FCP 增加写成改善，也不把桌面 120ms 改善写成独立达到 200ms 目标。原始评分数据未改写。

两份完整主题的 Shopify Theme Check 均返回空告警列表、退出码 0。实际内联控制器包装前 3257 字节、连同生命周期代码 5542 字节，最终 section 97 行、5850 字节，低于项目预算。两个被测设备的候选均捕获到相同控制器版本签名、零 CSP 违规、零外部控制器请求；内容、无 JS 首屏、布局和交互 preserved。

本次仍为隔离 LiquidJS 主题、真实 Chrome/Lighthouse，Shopify source pull 和 Section API 使用本地适配器；商家未发布主题、真实 Shopify 后端与真实用户数据未测。评分为 100→100，只确认声明的加载目标改善。

- [修复版实际候选](/private/tmp/perfkit-section-liquid-waH5UK/candidate/sections/main.liquid)
- [完整 plan](/private/tmp/perfkit-section-liquid-waH5UK/plan.json) · [补丁 diff](/private/tmp/perfkit-section-liquid-waH5UK/theme.patch)
- [正式验收九项门禁](/private/tmp/perfkit-section-liquid-waH5UK/formal/verification.json)
- [内容交互对比](/private/tmp/perfkit-section-liquid-waH5UK/experiment/preservation.json)
- [CSP 与执行身份](/private/tmp/perfkit-section-liquid-waH5UK/experiment/regression-after.json)
- [新增浏览器测试日志](/private/tmp/perfkit-liquid-review-final-tests.log)：其中旧会话兼容单元首次失败已修复，最终结果以随后日志为准
- [最终相关回归日志](/private/tmp/perfkit-liquid-review-regression.log)

上一轮记录见 [首轮实施与两种机制验证](section-liquid-validation.md)。
