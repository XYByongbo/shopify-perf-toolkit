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

## 五项改动的隔离全链路回归

在 macOS 或 Linux 的工具目录运行。需要 Node.js 22.19+、已安装的锁定依赖、Chrome 或 Chromium、Python 3，以及可执行项目 Theme Check 的 Shopify CLI。CLI 需要支持 `theme check --no-input`、`--list` 和 `--print`。可以用 `PERF_KIT_SHOPIFY_CLI` 指定绝对路径，避免 npm 选中其他版本。浏览器可通过 `PERF_KIT_BROWSER_EXECUTABLE` 指定。需要允许本机回环 HTTP 和无头 Chrome。

```sh
PERF_KIT_SHOPIFY_CLI=/absolute/path/to/shopify npm run test:optimization-e2e
```

每次都会从新建的夹具和空目录开始，通常需要数分钟。默认目录创建于系统临时目录。需要保留运行产物时，用 `--out` 指定仓库外的**新目录**。

```sh
PERF_KIT_SHOPIFY_CLI=/absolute/path/to/shopify npm run test:optimization-e2e -- --out /absolute/Codex-Outputs/optimization-e2e-run
```

### 固定配置

- 活动页和首页共两个页面，正式矩阵使用移动端。目标是 `campaign/mobile` 的 LCP，`home/mobile` 用于检查回退。
- 从 `PERF_DUAL_HERO` 发现生成 `profile-domain` 配置，观察窗口为 2,800 ms。夹具给图片响应增加 1,550 ms 延迟，并在主图前放置响应延迟 2,650 ms 的脚本。固定候选只将活动页移动主图的 `loading="lazy"` 改成 `loading="eager"`。
- 会话在启动时固定 `standards-v1`。Lighthouse 使用 `throttlingMethod: "devtools"`，交替实验在代表页每侧 3 次，正式前后每页每侧 5 次，共 26 份 Lighthouse 报告。
- 项目 Theme Check 保留推荐规则集，并显式启用 `AssetSizeCSS` 和 `AssetSizeJavaScript`。若同一条夹具图片引用的 `RemoteAsset` 警告因修改所在行而改变指纹，脚本会比较源码和警告列区间，再记录该条警告的审阅。
- 部署身份检查用独立的本地主题快照替代 Shopify 传输，真实 Chrome 仍核验页面上的主题 ID。视觉及交互证据来自多个宽度下的渲染内容、图片选源和几何、无溢出与键盘操作断言。验收范围为本地夹具，平台编辑器和线上效果未测量。

### 通过条件

| 改动 | 必须满足的断言 |
| --- | --- |
| 审计接定向采样 | `plan-sampling` 生成的配置通过 CLI 校验，采样捕获到真实移动主图 LCP，前后部署核验通过，证据可直接进入会话并生成仅修改目标图片属性的补丁。 |
| 采样预算 | 未复用实验时预检列出 6 次探索和 10 次正式采样。复用实验后给正式阶段 9 次预算，执行必须返回 `OPTIMIZATION_BUDGET`，已尝试次数为 0。 |
| 目标页和护栏页 | 活动页达到现有实测收益门槛，完整矩阵通过回退保护。使用同一批正式样本，仅将首页设为必须改善目标后，收益门禁必须拒绝。 |
| 策略一致 | 实验返回 `promising`，正式验收沿用同一 LCP 目标和 `standards-v1`，正式验收重放补丁实验时使用同一策略。 |
| 缺证据后继续 | 缺少视觉审阅时，唯一失败项为内容与视觉审阅，已应用补丁的源码哈希保持一致。补交实际审阅后复用已固定的正式样本，新增采样为 0，最终返回 `optimization-accepted`。 |

命令通过时退出 0，打印运行目录并写入 `summary.json`。其中包含实际样本数、预算拦截结果、负向对照、目标页和护栏页 LCP、审阅后新增样本数及最终会话路径。运行目录还包含 `configuration.json`、审计与采样配置、补丁、原始测量、功能回归、Theme Check 和正式决策。进入流程后断言失败时退出非零，并写入 `failure.json` 记录阶段和原因，已有证据保留。
