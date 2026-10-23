# 01 基线表

状态：未开始。本模板无真实测量值。按本次范围填写；未测、不适用（附原因）和缺失值不得写成 0 或通过。

## 任务范围与证据目标

| 字段 | 值 |
| --- | --- |
| 任务 ID / 负责人 | 待填写 |
| 范围 | 整站 / 单图 / 组件，选择并说明 |
| 目标页面、图片用途或组件行为 | 待填写 |
| 本次拟验证的结论 | 静态候选 / 局部运行 / 功能 / Lighthouse 实验室 / 真实用户，按需选择 |
| 涉及与不涉及的页面、状态和业务链路 | 待填写，注明理由 |
| 已知异常与未验证项 | 待填写 |

整站任务按受影响页面与业务链路组织记录。单图或组件任务填写目标及其依赖，按影响选择 [S/B 验收场景](../../references/acceptance.md)，不强制套用全站业务矩阵。只有本次需要 Lighthouse 汇总或前后比较时，才填写每组至少五次 LHR；局部诊断不以五次 LHR 为前置条件。

## 测试身份与条件

| 字段 | 值 |
| --- | --- |
| 店铺 / 域名 / 项目目录 | 待填写 |
| 基线主题 ID / 主题名称 / 分支 / commit | 待填写或不适用 |
| 候选主题 ID / 分支 / commit | 待填写或尚未创建 |
| 内容版本 / 商品与变体 / App 设置快照 | 待填写 |
| 日期与时区 / 测试地区 / 执行机器及负载 | 待填写 |
| 浏览器版本 / Lighthouse 版本 / configSettings | 按测量来源填写；未使用 Lighthouse 则不适用 |
| 视口宽高 / DPR / formFactor / 网络和 CPU 限速 | 移动与桌面分别填写 |
| 缓存 / storage reset / 登录 / 购物车 | 不同状态分别建组 |
| 同意状态 / Markets / 语言 / 币种 | 填写实际观测状态，不推定继承个人浏览器 |
| 预览方式 / 预览条状态 / 实际主题身份 | 待填写；本地迁移预览单独标记 |

## 页面与目标清单

| 页面 key | 类型 | 实际 URL | 内容/状态 | 本次是否涉及及理由 |
| --- | --- | --- | --- | --- |
| home | 首页 | 待填写 | 待填写 | 待确认 |
| product | 商品 | 待填写 | 商品、变体、数量 | 待确认 |
| collection | 集合 | 待填写 | 筛选、排序、页码 | 待确认 |
| cart-empty | 空购物车 | 待填写 | 空车 | 待确认 |
| cart-filled | 非空购物车 | 待填写 | 固定商品、变体、数量 | 待确认 |
| landing | 广告落地页 | 待填写或不适用 | 待填写 | 待确认 |

| 目标 ID | 源码 target / sourceHash | 源码图片 index / sourceIndex | DOM selector / DOM 图片 index | sourceIdentity 及映射验证证据 |
| --- | --- | --- | --- | --- |
| T001 | 项目相对路径 / 待填写 | 待填写或不适用 | 待填写 | 未验证 |

源码图片序号与 DOM 图片序号分别记录，不能因序号相同就认定同一对象。捕获到的 `sourceIdentity`（`sourcePath`、`sourceHash`、`sourceIndex`）仍需和对应版本源码核对；缺失或未核对时，不将运行成本自动归因到某个 Liquid 标签。目标选择器应唯一匹配。

## 局部浏览器基线（单图/组件按需）

| 组 key | URL / finalUrl / selector | 视口 / DPR / 浏览器版本 | wait-ms / observedUntilMs | 页面状态与操作脚本 | capture.json / 截图路径 |
| --- | --- | --- | --- | --- | --- |
| mobile | 待填写 | 390px 宽，补高度及其余条件 | 待填写 | 未操作 / 单独人工场景，注明 | 未采集 |
| desktop | 待填写 | 1440px 宽，补高度及其余条件 | 待填写 | 待填写 | 未采集 |
| breakpoint | 待填写 | 受影响断点前后分别填写 | 待填写 | 待填写 | 未采集或不适用 |

| 目标 ID / 组 key | src / currentSrc / 素材身份 | sizes / srcset / picture sources | 盒子尺寸 / 比例 / 裁切 | 可见 / complete / 解码证据 | 字节来源与数值 | 截图检查 |
| --- | --- | --- | --- | --- | --- | --- |
| T001 / 待填写 | 未采集 | 未采集 | 未采集 | 未采集 | transferSize / encodedBodySize / decodedBodySize 分开，缺失为 null | 裁切、文字、布局、清晰度未检查 |

记录 `blockedRequests`、控制台错误、缺失截图及 `limitations`：待填写。`naturalWidth` 不能直接当作编码像素宽度，`decodedBodySize` 不是位图内存。基线不可见、零尺寸或未解码应先记为异常，两次空白截图不能证明视觉通过。

`capture` 默认使用全新上下文并阻止非 GET/HEAD/OPTIONS 请求，路由使 HTTP 缓存禁用；Service Worker 被阻止，WebSocket 是否阻止以报告字段为准。它不执行用户交互，不能据此声称加购、交易、支付、同意后的统计或事件发送通过。相关功能需在适当环境另做人工验收。具体可比性和限制见 [采集与验收边界](../../references/verification.md)。

## Lighthouse 五次运行记录（仅选择该证据层时填写）

每个页面 × 设备 × 状态单独建组。组 key：待填写；配置记录：待填写。

| 次数 | 原始 JSON / trace 路径 | fetchTime | 有效性与排除理由 | FCP ms | LCP ms | Speed Index ms | TBT ms | CLS | Performance /100 | TTFB ms及来源 | 传输 bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | — | — | 未测 | — | — | — | — | — | — | — | — |
| 2 | — | — | 未测 | — | — | — | — | — | — | — | — |
| 3 | — | — | 未测 | — | — | — | — | — | — | — | — |
| 4 | — | — | 未测 | — | — | — | — | — | — | — | — |
| 5 | — | — | 未测 | — | — | — | — | — | — | — | — |

汇总路径：待填写。记录中位数、最小值、最大值及有效样本数；失败运行另存并注明理由，补跑至至少五份有效独立报告。锁定 Lighthouse、浏览器、configSettings 和状态；只忽略 `preview_theme_id` 参数，其他 URL 差异不得修改原报告绕过。`server_response_ms` 是旧审计值，不能直接替代完整导航 TTFB。

| audit ID | 数值单位 | score 有效样本数 / 总数 | median_score（0–1） | green |
| --- | --- | --- | --- | --- |
| first-contentful-paint | ms | 未测 | null | null |
| largest-contentful-paint | ms | 未测 | null | null |
| speed-index | ms | 未测 | null | null |
| total-blocking-time | ms | 未测 | null | null |
| cumulative-layout-shift | 无单位 | 未测 | null | null |

`strict_green.all_green`：null（未验证）。五项各自的 audit score 中位数与综合 Performance 分数分开记录；每项 score 样本完整时按锁定 Lighthouse 版本的评分判断中位数是否 ≥ 0.9。任一项 score 缺失则对应判定及 `all_green` 为 null，不能填写通过。绿色不是功能、发布或真实用户 CWV 结论。

## 瓶颈证据与真实用户基线

| 项目 | 发现 | 证据路径 | 资源决策 ID |
| --- | --- | --- | --- |
| LCP 元素 / 选择器 / 资源 URL | 未测 | — | — |
| 长任务 / 脚本归属 / 执行成本 | 未测 | — | — |
| 请求瀑布 / 迟发现 / 重复资源 | 未测 | — | — |
| CLS 移动元素 / 触发源 | 未测 | — | — |
| 实际交互 / 响应延迟 | 未测 | — | — |
| 原始 HTML / CSS 和 JS 错误 | 未测 | — | — |

真实用户数据源、窗口、页面/设备/地区、样本量、LCP/INP/CLS p75：未测 / 本次不采集（说明理由）。数据不足时明确填写“数据不足”；五次 LHR、TBT 或一次 capture 都不能替代真实用户 INP 与 p75。
