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

## 数据与验证边界

旧功能回归缺少新增 `sourceStable`、店铺/主题、`documentStable`、`finishedAt` 或完整远端核验时，需重新运行 scenarios 和 verify-deployment；不能补造历史记录。原导航 LHR、默认 score、正式每组至少 5 次、移动 75/80、桌面 85/90、指标收益与退步阈值不变。

默认 score 流程使用隔离主题和真实浏览器测量；loading/interaction 另有契约与浏览器测试。远端 source pull 由本地部署快照模拟，真实 Shopify 账号同步、GitHub Actions artifact 传输、线上 CWV/INP 及真实交易写操作不属于该夹具的验证范围。测试产物保存在脚本输出的项目外目录，不作为发行包内容。
