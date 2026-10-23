# 有预算的单 agent 执行（v0.8.0）

默认由一个 agent 调用固定 CLI；工具本身不调用任何模型、不创建子 agent。只有用户明确要求并行 agent 工作时，才由宿主另行安排。测量保持串行，避免浏览器争抢资源。不要让 agent 按单次报告来回调用，也不要每轮重新生成同步/回归/统计脚本。

优化默认以代码补丁为主线，见 [整站工作流](site-workflow.md)。batch 只承担该版本的诊断/测量阶段，不会生成或应用主题修改；一次成功 batch 不代表完成优化。已有可比 run 优先离线导入；新候选先测受影响组合的 exploration，有可信收益再做完整正式矩阵。报告导入按用户需求提供，资源默认离线；不因补充诊断存在未解析项就自动下载素材或扩展全站浏览器测试。

## 一次命令执行一个已部署版本

```sh
node scripts/perfkit.mjs batch --config /absolute/batch.json --out /absolute/new-run
```

batch 先检查候选历史早停，再串行执行可选报告导入、外链/脚本分析、测量矩阵或已有 run 导入、完整摘要；探索进入候选评估，正式用途进入可选源码审计和 before/after 验收及 HTML。同一目录由一个写入方维护，不安排其他聊天同时修改同一批文件。配置的 before 与当前预览必须对应各自真实版本；**批处理不修改、上传或发布主题**，不能在同一未变更预览上连续测两批就称为优化前后。基线批次省略 before；已确认候选同步后，再用新的输出目录运行候选批次。

完整产物在 batch.json、checks.json/html、resources.json/html、measurement-summary.json、audit.json/html、verification.json/html、summary.json；measurement/ 包含全部原始 LHR、传输/失败记录和 run.json。没有对应阶段的产物不生成。run 可以代替 measurement，表示只导入已有测量证据并做离线处理；两者必须且只能有一个。project/before/run 使用绝对路径。

CLI 默认 stdout 是至多约 4 KiB 的紧凑 JSON，最多显示配置顺序前 8 个组合，omittedGroups 明示省略数；完整摘要包含全部组合和每次分数。没有挑选最好样本。默认不输出逐次进度；需要时 measure --progress group 或 --progress attempt。其他命令用 --out 保存完整 JSON，或 --format full 明确取完整 stdout。补丁、错误恢复 receipt 的完整文件仍需审阅，不能用摘要替代 diff。

## 报告与资源配置

[带规范报告的示例](../assets/examples/batch-with-checks.json) 可导入已有测量目录，measurement 与 run 二选一。

| 字段 | 行为 |
| --- | --- |
| checks.input | 规范报告 JSON 的绝对路径；需要 project。支持 Theme Check 和结构化报告陈述，PDF 需先提取 |
| checks.metadata | 可选的扫描契约 JSON 绝对路径；缺少完整来源时保留 incomplete |
| checks.baseline | 可选的历史 import-check 输出绝对路径；不是性能 before 目录 |
| resources | project 存在时默认启用离线分析；false 关闭 |
| resources.probe | 仅 true 时做受限 HEAD，默认 false；其余字段拒绝，避免拼写错误静默失效 |

checks/resources 阶段共用剩余墙钟预算，通过受控子进程执行并保存 transport。HEAD 最多 40 个 URL，每个至多 5 秒和 3 次跳转；受总剩余时间进一步限制。尝试/失败预算仍用于测量，HEAD 不冒充测量样本。显式探测时遗漏、未验证或失败均标记待复核；离线 not-probed 不作为网络通过。

导入 exit=3 表示保留的诊断需要复核，batch 继续保存资源与性能证据；格式错误或子进程执行失败则停止后续阶段并保留失败记录。超时标记 stopped。尚未执行的诊断标记 not-run。

status=complete 只说明流水线执行完成。diagnostics 分别记录检查完整性、增量门禁、资源 findings/unresolved/网络状态、审计源码漂移；reviewRequired 汇总待复核状态。原始 error 不因误报候选注记消失；无可比基线且存在 error 时需复核。可比基线通过只表示无新增 error，历史告警仍保留。正式 acceptance 单独记录，探索始终 not-evaluated。batch 停止/失败、reviewRequired=true 或评分未通过均退出 3；无效配置退出 2。退出 0 不是业务/视觉验收。

batch 自动把两类诊断附入 audit-site；源码在阶段间变化会显示 stale，并要求复核。补充报告不计作性能收益。第一轮可省略 checks.baseline 和 before，后续使用真实对应的基线；不要为让结果通过伪造 metadata/sourceHashes。

## 预算是执行控制，不是验收放宽

measurement 的 budget 默认：maxWallTimeMs=3600000、maxAttempts=80、maxFailures=10、maxCandidateRounds=2。batch 默认 maxFailures=3，其他同上；内层测量预算只能进一步收紧。它们分别限制墙钟时间、总尝试数（失败也计数）、失败数、探索候选轮数。预算不是重试次数；不会按分数自动重跑或替换。

每个测量启动前预留完整 timeoutMs 加 3000 ms 清理余量；不足就不启动。当前 Lighthouse/PSI 请求沿用自身超时和进程清理。离线审计/验收子进程使用剩余时间，超时终止其进程组并保存 transport。文件落盘和进程清理可能少量超过墙钟边界；预算耗尽绝不能报告成功。已完成文件保留，run.status=stopped，stopped.reason 和 unattempted 明示缺额，退出 3；不能把部分矩阵当正式通过。

可选模型 token 上限：同时提供 maxModelTokens 和 modelUsageFile。计量文件是调用方持续更新的 `{ "usedTokens": 12345 }`，累计值包含什么必须由调用方固定；文件缺失、非法或计数回退时停止。检查发生在阶段/每次测量启动前。**CLI 没有模型调用，无法读取或阻止宿主 Codex 已经发生的推理，也无法实时核实账单。** 若要硬限制模型调用，宿主也须在调用模型前使用同一计量器；不得把未配置计量解释为已限制账户额度。默认以时间、尝试、失败和轮数控制工具执行。

## 探索与正式验收分开

purpose 默认 acceptance，runs 仍只能 5–10。显式 purpose=exploration 才允许 1–4 次（默认 3），run.json 和摘要始终携带 purpose，verify-site 拒绝任何 exploration 数据。正式验收仍要求每页/设备前后至少 5 次；移动最低 75/中位 80、桌面最低 85/中位 90，运行警告、不可比环境、缺测仍不能通过。预算或早停不改变这些规则。

探索先选一个代表性、受影响页面/设备，使用同引擎/浏览器/节流/页面状态。历史 baseline 可以是完整正式矩阵；early-stop 只比较候选声明的组合，使用 baseline 中该组的全部样本，双方各至少 3 份；会记录评估范围。这只是候选决策，不是全站验收。

```sh
node scripts/perfkit.mjs evaluate-iteration --config /absolute/history.json --out /absolute/decision.json
```

history 配置包含 rounds（全部候选，按发生顺序，每项只有 before/after 测量目录）、可选 earlyStop、maxCandidateRounds（默认 2）。batch 用 history 数组读同样的历史；探索有 before 时把当前轮加入 iteration.json。下一次调用须携带所有历史，不得为了绕过预算/低收益停止而重置或漏掉失败轮。

默认低收益门槛：分数中位提升至少 3 分，或 LCP 中位减少至少 200 ms；同时须达到基线该指标的极差 × noiseMultiplier（默认 1）。连续 patience=2 轮低收益则 stop-low-gain；达到 maxCandidateRounds 则 stop-candidate-budget；超出波动门槛的负向指标、警告、不完整/不可比证据或重复时间戳触发 review 停止。每轮全部单次分数/负向结果保留，不以某次最好结果继续。默认不再评估轮数预算以外的原始报告，只保留其路径和未评估状态。

batch 收到已停止的历史时，不再启动新的探索测量。**正式验收批次仍可完成必要的五次矩阵**；早停只停止新增候选，不能代替验收、宣称达标或触发自动回滚/发布。保留或回滚补丁仍由既有源码/交互/视觉证据决定。

## 离线验证

```sh
node --test tests/batch-integration.test.mjs tests/execution.test.mjs tests/measure.test.mjs tests/site-verify.test.mjs tests/run-evidence.test.mjs tests/cli.test.mjs
```

使用明确标记的合成夹具和注入 transport，无真实 Chrome/PSI 请求；既不证明主题评分，也不用于验收。不要把 npm run test:site 当离线测试，它会跑真实 Lighthouse。

兼容性例外：apply/rollback 未提供 --out 时，stdout 仍保留完整操作回执，避免丢失部分写入/恢复记录；正常工作流应提供 --out，以只返回回执路径。回执输出失败的原保底机制不变。

离线批处理的进程组截止控制支持 macOS/Linux；Windows 不执行该离线子进程阶段。
