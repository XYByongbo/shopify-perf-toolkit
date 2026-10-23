# 优化会话实现审查（2026-10-22）

本次审查覆盖 recovery、会话状态转换、补丁生成、单补丁实验、正式验收和证据复用。重点验证“错误证据能否通过”和“有证据的方案是否真的能执行”，不以规则数量或流程退出成功代替性能收益。

## 已修复问题

| 问题 | 影响 | 修复与反例验证 |
| --- | --- | --- |
| 实验未绑定假设页面/设备 | 其他场景的收益可能替当前假设背书 | runner 采样前、离线 verifier、会话均校验范围；会话同时核验店铺、引擎、页面矩阵；错误输入不启动采样 |
| 同一资产候选跨页面/设备碰撞，重复成本选取不稳定 | 关键场景被去重或低成本观察覆盖高成本观察 | 假设 ID 纳入页面、设备、状态；同范围保留最大观察成本，不相加 |
| FCP/Speed Index 目标仍生成 LCP 候选 | prepare 可以成功，experiment 必然因指标不符拒绝 | 实测阻塞资源生成目标指标专属假设，实际生成 critical CSS，独立验证对应指标；不匹配的候选保留为观察而非执行候选 |
| 评分器失效被当成“只是分数未达标” | 无效评分证据可能推进中间基线 | 仅 targets-not-met 且全部分组为有效 pass/fail 才可推进；模拟 Python 评分器不可用时拒绝推进 |
| 缺少功能证据被当成实测退化 | 有效候选被不必要撤销 | 缺证据保持待验证；实际失败步骤、明确内容/视觉拒绝、性能退化或非交互目标无收益才回滚 |
| 交互目标沿用导航分数无收益回滚条件 | 已改善交互仍因导航分数不变被撤销 | 交互收益以独立交互门禁为准；导航指标仍禁止退化 |
| 原始测量文件可在会话中被替换 | 后续验收可能使用变更过的基线、探索或正式分数 | 记录 manifest 和每份原始报告的内容指纹，后续步骤重新核验；首份有效正式样本固定，补审阅不能换更高分样本；证据损坏仍允许本地 rollback |
| 复制 session.json 可绕过 next-step 独占 | 可以从同一状态分叉，复用预算和历史 | 校验真实会话路径及父目录后继链接；复制文件不能续接；哈希仍不是签名 |
| runner 抛异常没有结算/回滚 | 相同补丁可能免费重复测试并留在候选目录 | 进度未知时消耗整轮预留次数，保留异常原因、计入失败并实际回滚 |
| 模型用量的单调性只在单次命令内检查 | resume 之间重置调用方 meter 可以绕过预算 | 已观察到的用量随会话保存，后续变小直接停止；仍不将调用方 meter 当作真实计费证明 |
| apply 写入后异常仍显示 review-required | 状态错误，可能再次 apply | 写入前占用轮数并进入恢复状态；写入后模拟异常测试确认只能先恢复，不重复应用 |
| CSS 覆盖按 URL 数除以 profile 数，且范围尾端处理错误 | 同页不同设备被误判为页面独占，已用规则可能显示未用 | 分开统计状态与页面；采用半开区间重叠规则，与 critical CSS 提取保持一致 |

## 当次审查的能力边界

后续四类生成与实测闭环已补充，最新范围见 [domain-optimization.md](domain-optimization.md)。以下保留当次审查结论，便于区分历史能力和新增实现。

- 当前自动可执行候选主要覆盖源码映射成立的导航 CPU、阻塞 JS/CSS 和交互 CPU；已有组件提取、critical CSS、显式 split 和 reviewed replacement 生成入口。
- 图片 LCP、CLS、Liquid、动态依赖和第三方 App 仍可能只有调查线索，尚无通用自动归因与生成闭环。`executionCoverage` 明确报告此差异；不能通过填写 method/rationale 就把静态告警升级为已证明假设。
- 本次接通 FCP/Speed Index 是已有实测阻塞资源能力的延伸。请求耗时不是预测节省量，是否有效仍以独立实验为准。
- 无收益后会实际回滚、保留历史并重新排序；新的复杂实现仍需操作者根据证据准备。工具没有内置模型，不能保证对任意主题自动找到有效改法。
- 隔离主题的真实浏览器测试证明对应机制可工作；不能据此推断任意生产主题提分，也不代表真实用户 CWV 或生产验收。远端发布、真实店铺同步不在此审查中执行。

## 验证入口

本次最终结果：Node 全量 486 项（468 通过、18 按配置跳过、0 失败）；Python 62 项（60 通过、2 跳过）；另行启用真实 Chrome 回归 15 项全部通过。Node 详细日志 `/private/tmp/perfkit-review-full-final.log`，Python 日志 `/private/tmp/perfkit-review-python-final.log`，浏览器日志 `/private/tmp/perfkit-review-browser.log`。

- `npm test`：全量 Node 回归，包含会话与生成器反例。
- `npm run test:lighthouse`：Python 评分与发布相关测试。
- `npm run test:browser`：真实 Chrome 的加载、交互、CSS 和运行证据回归。
- `npm run test:improvement-live -- --goal fcp`：预先声明 FCP 目标，用真实 Chrome/Lighthouse 执行无效补丁、回滚重诊断、critical CSS 和第二次实验；只有 Shopify 远端传输由隔离副本替代。

本次 FCP 隔离实验输出位于 `/private/tmp/perfkit-improvement-live-6Y3tEr`。负对照前后移动端中位分均为 93，判定 no-measurable-gain 并回滚。第二轮每侧三个独立样本，critical CSS 使 FCP 中位数约 1954→754 ms、LCP 约 2103→754 ms，评分 93→100；判定 promising，formalAcceptance 仍为 not-evaluated。没有为了通过而重复采样。
