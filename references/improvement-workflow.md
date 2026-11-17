# 低分、无收益与重新诊断

`improve` 是可恢复的优化会话，复用真实测量、源码归因、补丁生成、apply/rollback、单补丁实验和完整验收。它不仅输出建议：apply 会修改本地主题，experiment 会运行真实浏览器与 Lighthouse/PSI，失败后执行回滚并重算诊断。复杂实现仍由操作者根据证据编写；CLI 不调用模型，不承诺任意主题必然提分。

官方资料的实际阅读范围、来源与实现映射见 [Shopify 资料清单](shopify-recovery-sources.md)。原有 batch、optimize、experiment 命令继续可用。

官方方法执行与来源版本固定见 [官方知识库](shopify-knowledge.md)。

可执行的多轮入口、预览适配器与正式采集见 [恢复执行器](recovery-cycle.md)。`improve-cycle` 会生成并核对已审阅方案，实测失败后自动转到未测试机制；沿用原会话与全部门禁。

## 会话步骤

正式验收的策略与证据位置见 [新旧验收策略](standards-upgrade.md#两种正式验收策略)。省略 acceptancePolicy 保留原流程；显式 standards-v1 时，collect 的 formal 或 verify 的 verification 中传入策略和 standardsEvidence，goal 沿用会话。第一次正式选择会固定，后续不能切换；新策略不放宽单补丁 experiment/verify-patch 的原门禁。

每一步使用新的输出目录，除 start 外传入上一步的 `session.json`。输出必须位于主题目录之外。所有配置使用 `schemaVersion:1`。

```sh
node scripts/perfkit.mjs improve --config /absolute/start.json --out /absolute/step-00
node scripts/perfkit.mjs improve --config /absolute/prepare.json --out /absolute/step-01
node scripts/perfkit.mjs improve --config /absolute/apply.json --out /absolute/step-02
node scripts/perfkit.mjs improve --config /absolute/experiment-step.json --out /absolute/step-03
```

| action | 输入与实际执行 | 输出状态 |
| --- | --- | --- |
| start | project、run、可选 profiles/liquidProfile/field/owners/goal/budget/sources；读取当前源码与部署绑定的原始测量，计算各页面/设备的中位数、MAD 和指标丢分，运行统一诊断 | ready-for-plan / investigation-required |
| refresh | previous、可选 run 和新采集的 profiles 等诊断输入；重新分析当前基线，保留全部历史和预算 | ready-for-plan / investigation-required |
| prepare | candidateId、method、rationale；recipe、demand、split、plan、domain、official 六选一；生成或验证实际补丁和 diff | review-required |
| apply | previous、reviewedPlanHash；校验整份计划和当前源码后实际写入 | awaiting-preview-sync |
| sync | previous、preview；显式适配器同步或直接核验预览源码 | awaiting-preview-sync，成功后 previewSyncRequired=false |
| collect | previous、formal；预算内采集正式矩阵及回归并执行原 verify；不允许重复采集 | 原正式验收结果或待修复证据 |
| experiment | previous、experiment 配置或配置文件路径；运行两组已准备预览的交替测量、checkpoint 与目标收益验证 | formal-validation-required，或回滚后重新诊断 |
| verify | previous、verification 配置或路径；重算正式验收及相对最初基线的累计收益 | optimization-accepted / improved-below-target / 待补证据 |
| rollback | previous；回滚当前 active 补丁，失败时保留冲突回执 | 重新诊断 / rollback-conflict |

start 示例：[improvement-start.json](../assets/examples/improvement-start.json)。基线至少三个独立、完整、无警告样本并有测量前后部署证明。正式验收仍需前后每组至少五次，所以仅有探索基线时，需要另外采集相同源码的正式基线，在 refresh.run 或 verify 的 verification.before 中接入。会话仅允许把探索基线升级为正式基线，并校验源码、店铺、矩阵、引擎、版本与环境一致、保留替换记录；已有有效正式基线不可换成另一批低分样本，历史和预算不重置。不能把探索记录标成正式记录。

prepare 示例：[improvement-prepare.json](../assets/examples/improvement-prepare.json)。先读取 `recovery.json`，选取当前源码的有效 candidateId。默认按未测试假设、声明目标、对应线上影响、实测指标丢分排序；不同文件和页面的观察耗时不相加。未知 Lighthouse 版本且没有 auditRefs 时，丢分保持未知。

recipe 继续使用 `plan-site` 的契约：每个变更的 evidence 必须含该 candidateId 和 diagnosisSourceHash；新增资产也需绑定同一假设。不会自动填写策略审阅标志。已有计划必须与当前源码及假设匹配。demand 自动复用现有生成器；split 按原契约显式携带诊断依据。

```json
{"schemaVersion":1,"action":"apply","previous":"/absolute/step-01/session.json","reviewedPlanHash":"实际审阅过的计划哈希"}
```

应用后由调用方同步预览。同步完成后：

```json
{"schemaVersion":1,"action":"experiment","previous":"/absolute/step-02/session.json","experiment":"/absolute/prepared-experiment.json"}
```

prepared-experiment.json 沿用 [patch-experiment.json](../assets/examples/patch-experiment.json) 的 before/after、regressionBefore/After、runs 等配置。候选 deployment.project 必须等于会话 project；两侧店铺、引擎必须属于会话基线，页面及设备必须匹配所选假设并在基线矩阵内。独立 experiment 的采样前检查和离线验证也会核验假设范围。会话固定 plan、diagnosis、candidateId、goal、history 和剩余预算，防止改配置后实验另一份补丁。基线源码必须另有未修改副本；不能把已经应用候选的目录同时当作基线。

实验的 `promising` 只代表可进入正式验证。准备完整 after 测量、regression、review 后：

```json
{"schemaVersion":1,"action":"verify","previous":"/absolute/step-03/session.json","verification":"/absolute/formal-verification.json"}
```

verification 接受 after、before、regression、review、interactionEvidence、liquidEvidence、budget，以及 policy、businessEvidence、acceptancePolicy、standardsEvidence。plan、expectedSourceHash、goal、patchEvidence 由会话固定，不接受调用方覆盖；before 默认为当前基线，显式提供其他 before 时先执行同源码正式基线校验。regression/review 可提供绝对 JSON 文件路径。首次提供的资源 budget 即固定并跨方案继承；省略不取消，执行预算与计数不能通过 verification 重设。本命令重算已有正式证据，不代替外部采集。缺失内容视觉审阅仍不能通过；缺失审阅文件也不能解除已有效导航、交互或 Liquid 样本的固定。

## 无收益之后做什么

| 结果 | 自动处理 | 操作者下一步 |
| --- | --- | --- |
| invalid-evidence | 保留失败记录，回滚候选，提示证据修复 | 修复身份、环境、覆盖范围或警告；允许同补丁重试，但照常计入预算 |
| no-measurable-gain / hypothesis-not-confirmed | 回滚、记录失败假设、重新排序候选 | 换因果机制或下一个假设；不能重复同一补丁磨分 |
| performance-regressed / functional-regressed | 回滚并记录实际回归 | 修复功能或性能问题后形成不同补丁 |
| promising | 保留候选，要求正式验证 | 完整矩阵、回归、独立内容视觉审阅 |
| 正式阶段缺少功能/视觉证据或评分器错误 | 不接受，也不把缺证据等同于实测退化；保留候选待补证据 | 修复证据后继续 verify，或主动 rollback |
| 正式阶段无收益或回归 | 回滚、重新诊断 | 改变方案，保留原始失败证据 |
| improved-below-target | 仅当除原评分门槛外的正式门禁全部通过，且累计收益成立，才保留为中间基线 | 新采集当前源码 profiles 后 refresh；原始基线和历史不变 |

中间基线推进目前仅支持 score/loading。interaction 保留原有独立交互验收，暂不支持累计多轮交互基线推进。

没有可执行候选时，`executionCoverage` 会明确标记 no-executable-hypothesis；`investigations` 给出特定页面/设备需要回答的问题、采集入口、可用补丁路线和官方出处。这不表示主题已到极限。当前会话接受源码映射成立的 CPU、阻塞资源、交互 CPU，以及部署绑定的图片 LCP、图片/应用容器 CLS、Liquid 和主题可控 App loader 候选。新增定位、生成、双重实测门禁与 method=next 见 [四类闭环](domain-optimization.md)。不能仅凭自填 method/rationale 创建假设；复杂动态结构和平台所有资源仍保留明确边界。

阻塞资源支持 LCP、FCP 和 Speed Index 目标，计划与独立实验绑定同一个声明指标；CPU 候选支持 TBT，交互候选仍需要独立交互证据。指定 loading 目标时，不再输出指标不匹配、必然被实验拒绝的候选。同文件在不同页面、设备、状态的假设保持独立；同一范围重复观察采用最大耗时，不相加。critical CSS 的共享状态分析分别统计 profile 与页面，避免把同页面的多个断点误判成页面独占规则。

## 历史、预算与恢复

- 同补丁指纹不能在有效实验后重复测试；同源码下的同假设/同 method 不能反复尝试。仅换 method 名称无法绕过相同补丁指纹。
- 原有独立 experiment 的连续无收益早停保持不变。会话负责自己的全历史、总轮数、尝试/失败预算和方案去重，因此内部实验不重复套用另一个独立候选队列；不得通过新建会话删除失败历史。
- budget 在全部步骤中累计，不随 resume 重置。时间统计为 CLI 主动执行耗时；外部同步、人工等待、独立 profile/正式采集的耗时与尝试数不在该计量内，必须另行设置各采集命令预算。
- 配置调用方模型用量文件时，已观察到的 usedTokens 随会话保存；下一步读到更小的计数会停止，不能在 resume 之间重置计量文件。该文件仍是调用方报告，并非模型计费证明。
- maxAttempts 统计会话执行的实验导航尝试；runner 异常且进度未知时，保守消耗该轮全部预留次数，记录失败并回滚，不能免费重试。maxCandidateRounds 在进入 apply 写入前计数；应用异常进入 apply-recovery-required，不能重复 apply。无效、无收益实验及正式退化均计入失败预算。到预算即停止新试验，但保留 rollback 和已有证据的 verify。
- 每步写入独立 session.json；父链哈希防止无意修改或预算回退，next-step.json 独占占用阻止同一步被并发消费。续接必须从原输出目录进行，复制 session.json 不能绕过后继占用。哈希不是签名或批准证明。
- 新会话固定基线、探索实验及提交过的正式测量的 manifest 和每份原始 LHR 内容指纹，后续步骤发现文件变化就拒绝继续；rollback 不受证据损坏阻挡。首份评分/收益证据有效的正式候选样本集固定，补功能或视觉审阅不能换一批更高分样本。已验证收益仍低于目标时，仅允许真实 targets-not-met，评分器失效或 review-required 不会推进中间基线。
- 配置或验证错误会保存 error，继续时必须使用最新输出的 session.json。进程中断按下述 recover 流程恢复；不删除 next-step.json 或盲目重复执行。
- 本地回滚不同步远端。每次新实验仍实际核验两侧部署身份。保留的历史补丁都有独立 plan，完整回退时按保留顺序逆序处理并同步预览。

## 进程中断恢复

会话入口 `improvement-session.mjs` 负责接续、调度和提交。动作准入与状态变化集中在 `improvement-transitions.mjs`，`improvement-evidence.mjs` 固定并校验来源与证据，`improvement-budget.mjs` 管理尝试数和时间。实际步骤由 `improvement-actions.mjs` 和 `improvement-formal.mjs` 执行。原 `session.json` v1、检查点、意图文件与回执继续沿用原格式。

新步骤先原子保存 `checkpoint.json`，再独占发布父会话原目录的 `next-step.json`。通过符号链接访问同一父会话也共用这把锁。应用、回滚、采样及同步前保存执行阶段和已占用预算，最终 `session.json` 也以完整文件原子发布。

原进程退出后，读取最后一个完整会话目录中的 `next-step.json`，使用它记录的原输出目录。恢复配置如下，`previous` 仍指向中断步骤的父会话：

```json
{"schemaVersion":1,"action":"recover","previous":"/absolute/step-02/session.json"}
```

```sh
node scripts/perfkit.mjs improve --config /absolute/recover.json --out /absolute/interrupted-step-03
```

`recover` 是输出目录必须已存在的唯一会话动作。它核对父链、检查点、原目录和本机进程归属，再补齐该目录的 `session.json`；重复或并发恢复复用同一结果。原进程仍存活、无法确认退出、检查点损坏或目录不符时拒绝恢复。恢复返回待处理状态（CLI 退出码 3），不声明优化通过，也不执行源码修改、同步或采样。

- 只读步骤中断后，从恢复出的 `session.json` 显式执行下一步；源码漂移和原预算约束仍然有效。
- 在应用、回滚、同步、实验、正式采集或验证阶段中断且仍有活动补丁时，恢复会话只允许 `rollback`。先检查 intent、receipt、源码，并确认原采集/同步子进程已停止，再显式回滚；回滚冲突保持待处理，不覆盖外部修改。
- 若源码已经恢复、进程在保存回执前中断，恢复后重试回滚会确认已恢复的文件并补齐回执。
- 已预留的尝试数和候选轮次保留。采样/验证中断写入失败历史，同一补丁不能通过改名重新试验；已有正式样本路径和父会话证据锁保留，不自动重新采样。当前恢复入口采用保守回滚，不直接续跑中断的正式验收。
- 无法确定实际退出时刻，因此恢复将检查点之后的墙钟时间（含停机等待，最多计至会话时间预算）保守计入耗时；预算耗尽后仍可回滚。恢复不会重置模型用量计数。
- 旧版本的中断目录没有 `checkpoint.json` 时，保留原人工核对 intent/receipt 和源码恢复方式，程序不会猜测会话状态。首个 `start` 尚未产出会话且没有父链时，可检查其只读产物后在新目录重新开始。

## 测试

`npm run test:improvement` 使用明确标注的合成测量，实际执行补丁、回滚、证据校验和多轮状态转换。包括低收益、错误页面/陈旧 profile、重复候选、预算、并发占用、源码漂移、缺少审阅、累计验收。

`npm run test:improvement-live` 启动人工本地主题，用真实 Chrome/Lighthouse 验证：负对照补丁 → 无收益回滚 → 重诊断 → critical CSS 补丁 → 新实验。只有 Shopify 远端源码传输由隔离副本替代；输出在系统临时目录。它不发布主题、不伪造人工视觉审阅、不把探索结果当作实店正式通过。测量可能因机器负载出现不稳定，失败记录保留，不自动重复采样直到通过。

使用 `npm run test:improvement-live -- --goal fcp` 或 `--goal speedIndex` 可预先声明相应加载目标；resume 不允许切换目标。

2026-10-22 本机验证：CSS 注释负对照前后移动端中位分数 93→93，判定 no-measurable-gain 并实际回滚；调整 critical CSS 后三次独立候选均为 100，前侧三次均为 93，LCP 中位数约 2103→758 ms，判定 promising。第一次准备 critical CSS 因缺少交互状态覆盖率被拒绝，补采后通过 `--resume /absolute/step-N/session.json` 继续，复用已有基线和负对照历史。这是人为设置慢样式资源的隔离实验，不是生产主题收益或完整正式验收。
