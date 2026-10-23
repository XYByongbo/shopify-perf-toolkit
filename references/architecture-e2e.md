# 架构端到端验证

这套验证针对工具流程，在工具目录外创建隔离主题、独立部署快照和本地 HTTP 预览。页面由真实 Chrome 渲染、真实 Lighthouse 采样，官方 Theme Check 执行两项结构规则；只有 Shopify 远端源码拉取被替换为读取独立部署快照。不会访问、修改或发布实际店铺。

## 自动执行与审阅交接

| 阶段 | 自动执行与断言 | 操作者职责 |
| --- | --- | --- |
| 预检与基线 | batch 先运行官方 precheck、CSS/资源审计及双设备 runtime profile，再采集每设备 5 次正式基线，生成诊断绑定计划；核对主题字节未变 | 选择并锁定支持规则的 CLI；诊断中的 reviewRequired 不被基线完成状态覆盖 |
| 计划与应用 | 错误 reviewedPlanHash 必须拒绝且不改源码；固定夹具的已审计划应用后返回 awaiting-preview-sync | 真实任务需阅读 diff 与 verificationRequired；本测试的固定 CSS 转换由维护脚本的操作者审阅 |
| 显式同步 | 用独立部署目录复现未同步预览，身份检查必须拒绝；随后测试调用方显式复制候选到该目录 | 工具本身不会同步或发布主题 |
| 单补丁实验 | 一个代表页面/设备，前后共 6 次交替 Lighthouse；双设备场景断言与内容/布局/样式 checkpoint；promising 仅允许继续 | 确认同一假设与补丁范围 |
| 正式验证 | 候选双设备各 5 次；重算单补丁、原评分/收益/退步、身份、完整场景和最终远端核验 | 缺少 review 时必须 not-accepted，脚本保存 review-request.json 后结束自动阶段 |
| 内容与视觉审阅 | 程序不生成通过的 review；读取操作者提供的独立文件，再用 CLI verify-optimization 重算已有证据 | 查看差异、截图和 checkpoint，说明具体检查范围，将结论绑定候选 sourceHash |
| CI 与拒绝路径 | 审阅缺失、错误源码、缺少实验、篡改计划、错主题、陈旧远端证明、缺矩阵组、受限回归均不得完整通过；CI 独立输出 passed | CI passed 不代表已同步、发布或完整业务验收 |
| 回滚 | 验证本地回滚恢复源码字节，并确认远端快照仍是候选；随后调用方显式恢复测试部署快照 | 真实远端恢复仍由调用方负责 |

## 运行方法

在工具目录执行，需要已有 Chrome、已安装依赖和支持规则的 Shopify CLI。若已有外部 Playwright/Python 设置，继续使用；完整测试可使用应用自带、已安装 PDF 库的 Python。

```sh
PERF_KIT_SHOPIFY_CLI=/absolute/path/to/shopify npm run test:architecture
```

脚本输出临时任务目录。自动阶段成功停在 `awaiting-operator-review` 时，只说明自动链路与拒绝审阅缺失的门禁正常，尚未完整验收通过。按 `review-request.json` 检查材料，在任务目录外或其中新建 `review.json`，字段为 `sourceHash`、`contentPreserved`、`visualsPreserved`、`summary`；两个布尔值来自实际审阅，不能为了通过自动填写。用户已授权的操作者可以完成审阅，不要求重复向用户索取许可。

```sh
npm run test:architecture -- --resume /absolute/task/run --review /absolute/task/review.json
```

续跑复用原测量，不重复采样；成功生成 `summary.json`、CLI 验收结果、`negative-gates.json`、CI 报告与回滚回执。输出独占创建，失败保留原目录，不覆盖失败证据。不得在实际主题目录运行夹具恢复步骤。

若 batch 已完整完成而后续测试脚本在应用前中断，可用 `npm run test:architecture -- --continue-after-batch /absolute/task/run` 继续。仅在本地基线、候选及两份部署快照仍是原基线时允许复用，重新占用原本地端口；已有应用产物或源码变化不能靠此选项重试覆盖。不是自动补挑性能样本。

## 本轮发现与修复

1. 旧验证脚本分别止于 score-targets-met 与 promising，未覆盖完整验收和审阅交接。增加上述贯通脚本。
2. 默认 score/loading 的功能验收只校验顶层状态及少量字段，源码不稳定、错误主题或隐藏失败步骤仍可能通过。已增加统一完整回归校验，并由 optimize 自动绑定候选项目/主题；最初复现测试在修复前失败。
3. 普通计划进入正式验证时未重算计划完整性，且只比对候选文件。现在同时校验完整计划与基线/候选文件，并补篡改计划、无关基线的拒绝测试。
4. npm 与终端选择的 Shopify CLI 不同，旧 CLI 参数错误只留下泛化异常。现在 batch 保留 precheck-failure.json，可追溯实际版本、退出码与输出；通过显式 CLI 路径继续运行，不自动升级或跳过预检。

旧功能回归缺少新增 `sourceStable`、店铺/主题、`documentStable`、`finishedAt` 或完整远端核验时，需重新运行 scenarios 和 verify-deployment；不能补造历史记录。原导航 LHR、默认 score、正式每组至少 5 次、移动 75/80、桌面 85/90、指标收益与退步阈值不变。

## 测试覆盖边界

2026-10-20 的隔离端到端主线已通过：真实 Lighthouse 26 次，其中正式基线/候选各 10 次、单补丁前后各 3 次，0 失败。使用 Shopify CLI 4.9.4、Theme Check 3.29.0、Lighthouse 13.5.0 和已有 Chrome 155。

| 验证项 | 实际结果 |
| --- | --- |
| 移动正式矩阵（前后各 5 次） | 分数中位数 93 → 100，候选最低 100，原 75/80 门槛通过 |
| 桌面正式矩阵（前后各 5 次） | 分数中位数 98 → 100，候选最低 100，原 85/90 门槛通过；全矩阵收益由移动组满足，未放宽 3 分收益下限 |
| 单补丁实验 | promising；精确补丁差异、身份、目标收益、内容/布局/交互保留全部通过 |
| 审阅交接 | 自动阶段只有 content-and-visual-review 为 false，返回 not-accepted；操作者查看完整差异及双设备前后截图，正式截图哈希一致；提供独立审阅文件后 CLI 返回 optimization-accepted |
| 拒绝路径 | 未审哈希、未同步预览被阻止；另有 8 类最终无效证据均不能通过，CLI 缺审阅退出码 3、完整通过退出码 0 |
| CI 与回滚 | CI passed 保留独立含义；本地回滚字节恢复，测试预览保持候选直到显式恢复 |
| Node 全量 | 416 项中 406 通过、0 失败，10 项专用浏览器用例另行运行 |
| 专用真实 Chrome | 10/10 通过，无跳过；重复交互采集、键盘操作、首次交互、动态 Section、源码身份与 DevTools trace |
| Python | 62/62 通过，无跳过；原评分、汇总、发行与 PDF 均覆盖 |

相关源码/验收/预检定向测试 64/64 已通过，属于上述 Node 套件，不重复计数。初始两次旧 CLI 失败和测试脚本断言失败均保留：脚本将计划级 verificationRequired 误当成逐文件字段，修正后复用已完成的 10 次基线继续，未覆盖证据或重挑样本。

本轮任务目录为 `/private/tmp/perfkit-architecture-live-KN5dDJ`，保留完整原始报告、review-request/operator-review、最终验收、拒绝路径及回滚回执；日志为 `/private/tmp/perfkit-architecture-*.log`。临时产物不进入工具发行包。

真实端到端主线使用默认 score，loading/interaction 的完整门禁另有合成契约测试和真实浏览器采集测试。真实 Shopify 账号同步、GitHub Actions 上下游 artifact 传输、线上 CWV/INP 及真实交易写操作不属于隔离夹具的通过结论。
