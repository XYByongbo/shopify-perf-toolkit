# 查询、隐藏 DOM、Section Rendering 验证记录

日期：2026-10-23。实现说明与操作配置见 [扩展闭环](extended-optimization.md)，结构化结果见 [extended-validation.json](extended-validation.json)。这是工具和人工主题夹具的验证，不是商家店铺的上线验收。

## 完成的工具验证

| 验证 | 实际结果 |
| --- | --- |
| `npm test` | 545 个测试：517 通过、28 个需要单独环境的测试跳过，0 失败 |
| `npm run test:browser` | 25 个真实 Chrome 测试通过，0 失败、0 跳过；包括新增三项及原图片、App、CSS、字体、生命周期和运行归因回归 |
| `npm run test:lighthouse` | Python 62 个：60 通过、2 跳过 |
| 官方目录导出 | 70 篇方法卡；26 篇有生成器，32 个执行入口，来源审阅状态 current（指本地已审阅快照，不是持续联网保证） |
| Theme Check | CLI 4.9.4、Theme Check 3.26.1；相同默认规则的完整最小主题上下文，基线 0 error/0 warning，生成后 0 error/1 warning |

末轮收紧隐藏内容转义与 raw 标签边界后，相关 45 项测试再次全部通过。

Node 新增覆盖：查询空/短/长内容与多页顺序、禁止给固定列表加分页、元数据/嵌套拒绝、源哈希/偏移绑定、隐藏组件危险依赖、未转义 HTML 和模板结束标签拒绝、可逆新资产、fetch 原生调用绑定、真实区块响应解析、不能以回退证明收益、不能删掉 page 2 合同、缺少 Liquid 原始证据时在浏览器测量前停止，以及三类候选在 improve 中的真实 apply/rollback、换补丁与方法耗尽。状态机测试使用合成实验结果，只验证恢复逻辑，不宣称测试数据是商家性能。

新增 Chrome 测试实际生成并应用补丁：

- 隐藏 disclosure：320 个内容节点移出初始 active DOM；两种实现的第一次打开、关闭后键盘重开、内容/几何/样式 checkpoint、编辑器替换后的重新打开和无 JS 内容均通过。节点减少本身没有作为收益结论。
- Section fetch：CDP initiator 对应当前 JS 的实际 fetch 位置；HTML / JSON 两种实现保留语言路径与排序参数、输出相同区块。每种三对交替导航采样，独立 fresh context；人工设置整页 550ms / 区块 60ms 服务延迟，浏览器原始 LCP 中位数约 590ms → 85ms。响应正文约 170KB → 142/174B，源于夹具额外的无用整页内容，不能外推到真实店铺。
- 空 JSON、HTTP 500、错误区块正文、5 秒超时全部回退成功；这些结果无法通过“候选 Section API 有效收益证据”门禁。修复了响应采集先等待错误 HTTP 响应完成而可能耗尽整个场景预算的问题，错误状态现在不等待正文。

## 完整 Lighthouse 单补丁实验

下面是 `runPatchExperiment` 实际运行结果；每组每侧 3 次，顺序交替，正常资源开启。基线与候选源码、回归前后部署、HTML/交互检查与目标指标检查均走工具原路径。只有 Shopify source-pull 传输和 Section API 服务由本地夹具模拟；Chrome 与 Lighthouse 均真实执行。

| 方法 | 预先声明目标 | 中位数与结果 | 处理 |
| --- | --- | --- | --- |
| section-fetch-single | loading / LCP | LCP **1953.82 → 1054.68ms**，约减少 899.14ms；FCP 752.88 → 753.79ms；score 99 → 100 | `promising`，通过目标 LCP 探索合同；只增加 1 分不满足默认 3 分“评分收益”线，不能宣称评分模式正式通过。测试结束回滚。 |
| hidden-template | loading / TBT | TBT **0 → 0ms**；FCP **618.57 → 763.24ms**；score 100 → 100 | `performance-regressed`，回滚原文件并删除新资产；继续不同方法。 |
| hidden-template-chunked | loading / TBT | TBT **0 → 0ms**；FCP **618.60 → 762.32ms**；score 100 → 100 | `performance-regressed`，回滚；两种方案均不应保留。 |

隐藏 DOM 基线已经没有 TBT；延后节点且增加运行脚本/HTML，并不保证更快。工具没有把节点减少或规则通过升级为优化成功。两种生成补丁不同，仍都被实际性能门禁否决。单元状态机另外验证了方法耗尽后不重复重试。

汇总表为 18 个独立 Lighthouse 样本。另保留第一轮隐藏 DOM 的 6 个退步样本，最初验证脚本错误地要求负结果不能是 performance-regressed，已修正测试脚本以记录退步并继续下一方法；没有丢弃该负结果，记录在 JSON 的 initialNegativeTrial。

原始证据仍在本机：

- [Section API 实验](/private/tmp/perfkit-extended-live-gbPNjD/section-fetch/section-fetch-single)
- [隐藏 DOM 两种方案实验](/private/tmp/perfkit-extended-live-rQTAv4/hidden-dom)
- [Theme Check 配置、规则和前后输出](/private/tmp/perfkit-extended-themecheck-nvSso9)

这些临时目录含计划、原始报告、部署/请求/回归证据及指标分布。仓库的结构化结果保留结论、源哈希、planHash、指标分布和证据位置。

## 规范复核与未测范围

生成器使用 AST 和 JS 解析检查；运行脚本 63 行、无固定计时等待后才展示内容，支持重复打开与编辑器替换。没有修改 content_for_header、原 schema 或持久化配置。局部 fixtures 的重复内容用于压力测试，不作为商品主题生产模板。目标主题仍应执行其完整 Theme Check 和既有预算。

唯一新增 Theme Check warning 是 query-paginate 的 `UnusedAssign: skip`。转换移除了 offset 消费，但保留原赋值，避免改变后续 include 或共享作用域消费者。没有关闭规则或直接删除赋值；目标主题完成引用审阅后可单独消除该变量。隔离上下文含 layout、templates、sections、assets、locales 和 config，检查 stderr 为空；不能把最小主题检查替代商家主题检查。

Liquid 查询生成已验证本地输出模型与真实服务器证据门禁；本地 LiquidJS 的 paginate 切片模型**不是 Shopify 查询执行**。尚未获得商家主题/未发布预览，未采集 Shopify CLI 真实查询前后 profile，因此不报告服务端查询收益、真实店铺评分或正式验收。实际分页还须覆盖当前主题的末页、空页、筛选、导航和最大数据规模；page 1/2 是工具最小合同，不代表所有页面语义已经穷举。

没有执行发布、卸载 App、业务删减或线上修改。
