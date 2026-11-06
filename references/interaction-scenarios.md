# 购物交互的速度与正确性

修改搜索、筛选、变体、Quick-add、加购或购物车时，选择实际受影响的场景。沿用现有主题的 Ajax/Section Rendering、事件与语言路由；不为采用这张表重构整套购物车。纯样式小改不扩大成全站交易测试。

## 选择场景

| 改动 | 最终必须正确 | 重点反例 |
| --- | --- | --- |
| 预测搜索 | 最后输入的结果、提交入口、键盘选择和状态提示 | 中文 IME composition；空词/无结果；`[`、`(`、`+`、反斜杠；`a b` 与 `a-b` 缓存区分；清空后旧响应到达；两个搜索框；断网 |
| 筛选/排序/分页 | 商品、数量、选中项、URL/历史与焦点一致 | 连续操作、响应乱序、返回、空结果、移动面板关闭重开；断言结果确实改变，不能只检查旧列表仍可见 |
| 变体选择 | 最新价格、库存、媒体、URL、实际提交 variant ID、数量规则一致 | A→B→A 快切；min/max/step；已购量与剩余额度 0；无匹配/缺货；失败后不可错误提交 |
| Quick-add/辅助抽屉 | 当前商品/变体、完整表单、可关闭、焦点返回 | 冷启动首开、关闭后响应到达、重开、同商品两个实例、首次完整内容、重复脚本与监听 |
| 加购 | 一次接受的用户提交对应一次写入，结果与可见提示真实 | 双击、超时、422、properties/selling_plan/quantity；写入成功但 section 为 null/目标节点缺失；只有错误事件但顾客无提示 |
| 购物车改量/删除 | line key、数量、总价、折扣、角标、空状态一致 | 连续改量/移除；空↔非空；同 variant 不同 properties；失败恢复；重复成功事件/埋点 |
| 多实例/编辑器 | 各实例独立，重建后只响应一次 | load/unload/reorder；卸载后旧响应不作用到新实例；焦点、disabled、readonly、required、多选和 open 状态 |

## 三种时间与现有工具

分开记录第一帧反馈、网络完成和最终业务断言结束。spinner 出现不表示完整可用；点击到业务完成不等于 INP，TBT 也不等于 INP。

已有 `measure-interactions` / `verify-interactions` 沿用独立正式采样、实际动作/Event Timing、相同页面/设备/主题/源码身份。导航分数、退步和完整 `verify-optimization` 门槛保持不变。普通功能回归按 [scenarios](automation.md) 的真实支持项运行；`checkpoint` version 2 补充 [运行时表单与焦点](rendered-html.md#快照-version-2)。

`scenarios` 目前支持 click、press、dispatch 和显式断言等，**没有通用 fill/select、网络乱序注入、IME 或真实写请求执行器**。复杂输入与失败场景使用项目已有浏览器测试或授权预览实际操作，记录步骤与证据，不能用未执行的清单宣称通过。capture/scenarios 拦截写请求及 WebSocket；对应结果只能用于受限诊断，不能证明真实加购、统计和支付。需要真实写入时按既有授权及项目环境另测。

## 请求边界

只读搜索、筛选和变体请求可以取消过时请求，并校验当前序号/参数/实例；缓存命中也必须经过相同校验。每次新请求使用新的 AbortController，IME composition 结束后再处理正式查询。搜索词按字面字符串处理；确需正则时正确转义，缓存键保留会影响结果的语言、市场和查询参数。

加购、改量和删除属于写请求。沿用提交锁/队列，不能将只读请求的“最后一次生效”当作服务器已撤销写入。超时、abort、HTTP 错误或 section 渲染失败均不能证明商品未写入；先核对当前购物车并单独恢复 UI，避免盲目重试 add 导致重复商品。

Ajax cart 的 bundled section rendering 要区分写入结果和渲染结果；沿用目标主题支持的 section ID、本地化路由、业务字段和 `sections_url`。响应里 section 为 null 时不要直接再次写入。一个 POST 后接 GET cart、pending 与完成事件可能属于正常协议，沿调用链检查实际重复写入及消费者，不按请求数直接判错。新 HTML 仍需清理旧实例、初始化新实例并恢复焦点。

## 记录与验收

记录主题/源码、页面数据、设备、网络/缓存与同意状态，动作前状态、预期最终状态、实际动作、三种时间、读写请求及可见错误。覆盖本次相关的正例与反例，未执行写 NOT RUN；功能错误先修复或沿原计划回滚。需要性能收益结论时进入原探索/正式实测流程，不能把这张表、单次快照或一轮点击计时当作通过。

本矩阵参考 [shopify-theme-skills 的交互验证](https://gitlab.tanlink.com.cn/fe-skills/shopify-theme-skills/-/blob/63744f0eaf4716ad8a7b1e8aa31b3c27728fcaa2/skills/shopify-section-seo-performance/references/interaction-verification.md)，并按本包实际执行能力整理。平台参数以目标主题及当前 Shopify 官方契约为准，不因采用清单启用新平台能力。
