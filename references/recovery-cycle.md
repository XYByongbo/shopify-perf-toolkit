# 执行恢复闭环与资源预算

`improve-cycle` 消费现有会话和一组源码绑定的实现配置，实际执行重新诊断、生成补丁、核对审阅、应用、同步核验、探索实验和正式采集。它不是新的评分器，也不调用模型：所有步骤复用 `improve` 的源文件指纹、失败历史、原收益门槛和预算。

```sh
node scripts/perfkit.mjs improve-cycle --config /absolute/cycle.json --out /absolute/new-cycle
```

配置见 [示例](../assets/examples/recovery-cycle.json)。每个 option 包含：

- `id`：唯一名称。
- `prepare`：现有 prepare 配置中的具体 candidateId、method、rationale，以及 recipe/demand/split/domain/official/plan 之一。不要提供 action/previous，也不使用 next 通配符。源码、页面和设备绑定由会话重新验证。
- `reviewedPlan`：显式选择的、已完整审阅的计划文件。执行时重新生成计划，比较完整源码、差异、依赖、证据、参数和验证要求，只忽略生成 UUID、时间与派生 generatorPlanHash。不同内容不得沿用审阅。此文件不是签名或工具自动做过人工审阅的证明。
- `experiment`：已配置两份独立源码/预览的实验配置或其绝对文件路径。
- `formal`：可选的 measurement、scenarios、review、interactionEvidence、liquidEvidence。缺少时停在 formal-validation-required；不会把探索结果当正式通过。
- `verification`：可选的正式证据修复配置（对象或绝对 JSON 路径）。提供后直接调用 verify，不再调用 collect；after 省略时使用会话固定的 formalAfter。regression、review 可为对象或绝对 JSON 路径，interactionEvidence、liquidEvidence 沿用 verify 的格式。该配置优先于 formal，不要在首次采集时提供占位 verification。

没有 reviewedPlan 时，会真实生成下一份 plan，然后停在 review-required，输出 plan 与 reviewContentHash。审阅文件后从返回的 session 续接。不可在循环中自动填充 review 布尔值。

## 自动继续与停止

首轮由 refresh 运行诊断。发生探索或正式拒绝后，cycle 先同步已回滚的基线到声明的候选预览，再通过 reprofile 实际重采集运行时/Liquid 证据，之后重新诊断，包括读取失败实验的原始成本证据。默认从已有 profile 的页面、设备、交互步骤、DOM 绑定及实验的 after.deployment 推导请求；没有 profile 时使用基线矩阵。可通过顶层 evidence 数组显式提供 1..10 个 profile-domain 配置（最多一个 Liquid 上下文）。不会把旧 profile 的重新计算算作重采集。候选按当前诊断排序，仅选择绑定该候选、尚未失败的机制。随后调用真实生成器并应用。探索无收益/退步时，原会话回滚并记录失败，循环继续选择不同机制；正式无收益/回归、已证实的资源预算超限同样进入下一轮。

同一补丁改名、已失败的同因果机制、源码漂移、缺少审阅、无效实验、同步失败、预算耗尽均不能通过。无效实验先停止修复证据，不自动试另一补丁。正式采集后的缺证据也停止，使用已有样本继续 verify。

该入口执行调用方已提供的实现集合，不凭空生成任意复杂主题代码。没有剩余可执行实现时返回 no-supported-alternative，保留实际生成的计划、失败样本及 recovery 文件。保留中间收益后返回 improved-below-target，要求采集新源码的 profile；不能把旧源码 profile 用于下一轮。

## 预览同步

未配置 sync 时，执行器只核验当前预览是否已经匹配候选。可在调用方明确配置后使用一个同步适配器：

```json
{"command":"/absolute/node","args":["/absolute/sync-unpublished-preview.mjs"],"timeoutMs":60000}
```

程序以无 shell、关闭 stdin、限制输出和超时的方式执行，最后一个参数为工具写出的 sync-request.json 路径。请求包含 project、sourceHash、deployment、pages 和 publish:false。调用方负责审阅程序、限定到指定的未发布预览并保证幂等；工具未内置推送或发布命令，不自动执行任意示例脚本。凭据使用本地既有认证/环境，不写在参数或产物里。

返回码 0 仅代表适配器完成；随后仍通过远端源码拉取和浏览器主题身份独立核验。陈旧预览不能进入实验。同步失败保留已应用的本地候选，返回 awaiting-preview-sync；按返回 session 继续，或通过 improve rollback 回滚。本地回滚不会偷偷同步远端；下一次测量前必须再次核验。

## 正式采集与持久预算

`improve` 的 `sync`、`reprofile` 和 `collect` action 可独立使用，也由 cycle 调用。

```json
{"schemaVersion":1,"action":"collect","previous":"/absolute/experiment/session.json","formal":"/absolute/formal.json"}
```

collect 要求 promising 和已有正式基线，使用独立 collector 采集原矩阵、执行场景和部署验证，然后由会话调用唯一一次最终验收。正式导航尝试会计入会话总预算，未知进度保守计入全部预留次数；同步、采集的主动执行时间也计入会话时间。采集前保存 intent；即使后续场景失败也固定首份可读样本。一旦启动导航，再次 collect 被拒绝（仅明确零导航的预检失败，或保存的部署拒绝记录证明尝试/报告/报告目录全部为空，才可修复后继续采集），须用已有 acceptance 目录与修复后的证据调用 verify，不能换一批分数。

cycle.json 每步保存最新 session，异常时还保留 pending 步骤目录；崩溃后先查看该目录的 session/intent/receipt 与父级 next-step.json，不能删除占用记录后重跑。所有会话步骤沿用单写入方保护。

## 资源预算语义

`verify-optimization.budget` / `optimize.budget` 是资源验收约束；`measurement.budget` 和 `improve start.budget` 是执行预算，两者不能混用。

在 improve start 使用 resourceBudget 固定全会话资源门槛：

```json
{"maxTotalTransferBytes":1000000,"maxRequests":60,"maxByType":{"script":250000,"image":600000,"third-party":150000}}
```

- 每页面、每设备、每次采样独立检查，全部符合才通过；不累计采样，不用中位数掩盖单次超限。
- 字节和请求数直接读取 Lighthouse resource-summary 的 total 行。third-party 是与类型重叠的统计，不能再次加到总量。
- maxByType 使用指定分类行。零上限有效；未知键、负数、小数、非有限数、空配置拒绝。
- 缺失/重复/无效行、缺少 total 或指定分类，不视为零资源，返回 invalid-evidence。
- 已配置预算是硬门禁。它不替代原分数、收益、行为和部署身份验证，也不能在后续 verify 中被放宽。

## 验证

`npm run test:recovery-cycle`：预算计算、正式验收入口、真实文件补丁/回滚、多轮持久会话、同步失败、审阅变化、正式无收益后的新方案、禁止重新采样和预算继承。分数与远端身份使用明确标注的合成合同。

`npm run test:recovery-cycle-live`：本地人工慢 CSS 主题，真实 Chrome/Lighthouse，固定 5 次正式基线、两轮各 3+3 次探索、获准进入正式阶段后固定 5 次候选。运行中不并行其他性能测试，不重跑同一候选求通过。先做注释负对照，再由 cycle 重新生成 critical CSS、验证内容与第一次点击并正式验收。已知夹具声明替代商家人工视觉审阅；远端源码传输是本地复制适配器。该实验不能证明 Shopify 服务器或商家收益。

本地脚本可用 `--resume /absolute/latest/session.json` 从原会话继续，沿用原始端口、正式基线、探索样本和已审阅计划；不重新执行历史候选，也不覆盖第一次失败记录。

## 模块职责与续跑约束

- `optimization-collection.mjs`：只采集样本、行为回归和部署证据；不应用/回滚主题，也不裁决正式通过。
- `optimization-verification.mjs`：读取既有证据，检查原评分、收益、资源预算和行为门槛；不发起新导航。
- `improvement-state.mjs`：验证会话链、来源目录、累计预算和历史完整性；`improvement-session.mjs` 负责动作转换、预算记账和产物固定。
- `optimize.mjs`：兼容原命令接口，prepare/apply 显式改源码，verify 组合一次采集和一次验收。
- `theme-source.mjs`：独立源码快照与浏览器路径能力，打断 runtime → measure → deployment → runtime 的静态依赖环。

官方 methodId/executor 与归一化执行名通过同一函数关联；恢复既有 active 会话无需重新生成第一份计划。候选标识忽略预览主题 ID；已核验源码的资源以文件和内容 hash 绑定，避免 CDN 版本 URL 变化打断续跑，页面业务查询参数、源码位置和设备仍保留；部署主题身份仍独立严格核验。

重新采集必须有新时间戳、前后远端源码证明、相同项目/store、声明的主题与页面设备。保留原已采集的额外视口（例如 CSS 的 desktop 覆盖），不扩大评分验收矩阵。每个 profile 请求计入持久 maxAttempts，整组预留检查在采集前完成；部分失败不替换已使用的诊断输入。成功后记录对应失败历史长度，审阅暂停后续跑不会再次采集同批证据。新证据中瓶颈消失就停止该方案，不能借用旧诊断继续改代码。

重采集可能改变生成补丁或证据；完整计划与已审阅版本不一致仍需审阅新计划。自动执行只使用调用方提供的生成器/替换配置，不伪造审阅，也不绕过源码绑定。跨版本升级导致旧候选 ID 不再匹配时，应按新诊断重新绑定配置并审阅；不会猜测迁移到其他位置。

## 二次审查：新证据如何影响代码

恢复时保留原来声明的页面、设备、state、动作顺序、settleMs 下限、额外 DOM selectors、脚本哈希采集目标及 Liquid 上下文。返回 profile 必须与请求契约一致，动作有完成记录和合法时序；受阻请求、采集错误或截断 trace 不得进入下一轮。显式 evidence 不能靠缩减状态覆盖率得到更小的补丁。profile-domain 合并显式 selectors 与源码绑定 selectors，不再覆盖前者。

当前证据重新决定候选排序。生成器收到的是重采集后的 profiles，例如 critical CSS 会将新状态实际使用的规则写入补丁；覆盖率证明已无足够可移除阻塞 CSS 时，记录 NO_REMAINING_BLOCKING_CSS，转向其他配置方案。此类准备失败按源码、候选、机制及输入证据 hash 保存，同一批证据续跑不会重复准备；不同证据仍需经过生成器和原门槛。旧 reviewedPlan 与新生成结果不一致时，必须审阅新差异，不能沿用旧批准。

recipe/reviewed-replacement 是调用方提供的固定实现，不会因重采集而自动重写 replacementText。它只能在当前诊断仍支持该候选时参与选择，并接受源码及收益验证。自动重新生成能力来自 demand/domain/official 等已有生成器；工具不声称能自行创造任意未知主题的实现。

## 正式拒绝与证据修复

- 已核验的导航退步/无收益、资源预算超限、明确内容审阅拒绝，或绑定正确预览的实际断言失败：保留原样本、记录 formal-rejected、回滚，再重采集并选择不同机制。
- 正式交互或 Liquid 的至少五次独立样本已证实无收益/退步：预检独立重算后即可拒绝，不再发起没有必要的导航测分。history.formalEvidence.stage 为 before-navigation，不把这类拒绝称为完成了导航验收。
- 无效样本、错误源码/store/页面、缺字段、未执行动作或断言超时：repair-evidence，保留候选和原样本，不把不完整证据写成已失败的优化机制。

formal-recovery.json 保存本次分流依据。首次可读取且源码身份匹配的正式导航样本即固定，不等所有附属门禁通过才固定。正式交互还固定两侧原始 manifest/sample 哈希；补审阅、补场景或修工具不能更换已有效的样本。缺少证据仍须按已有样本 verify，不反复 collect 求高分。

补丁改变后，两类审阅分别校验：reviewedPlan 比较完整语义内容；formal.review 绑定应用后的整份主题源码 hash。已提供但指向旧源码（或缺少 sourceHash）的正式审阅在采集前返回 formal-review-required 和 reviewSourceHash，不预留或消耗导航次数，不自动重写审阅。也可以省略 formal.review，先采集一次，再审阅实际页面证据并通过 verification 续跑。工具不替代人的内容/视觉审阅。

正式采集后缺证据，或采集器已保存样本但后续行为阶段失败时，将修复配置放在当前 option 的 verification，并把顶层 previous 指向最后返回的 session：

```json
{"regression":"/absolute/repaired-regression.json","review":"/absolute/current-source-review.json"}
```

若会话还没有可读取的 formalAfter，须显式提供原采集任务的 after；不能另采一批替换。指定其他 after、修改已固定原始样本、放宽资源预算仍由会话拒绝。verify 不增加导航次数：通过则正式接受，缺证据则继续 repair，已证明无收益则保留拒绝样本、回滚、重采集证据并选择下一机制。新方案仍需独立审阅，暂停后可接续至完整正式验收，旧方案的 verification 不会传给新方案。

补证据失败也要保留已经提交的有效样本：导航先固定原始 manifest/report 哈希，交互独立重算并固定 manifest/sample 哈希，Liquid 独立重算并固定完整原始 profile。之后才读取内容审阅和行为文件；这些文件缺失不能成为换样本的机会。collect 预检同样固定已经提供的有效交互/Liquid 证据，不因此提前发起导航。旧候选源码的导航记录不会被固定成新候选的 formalAfter，旧审阅与旧行为记录也不能替代新候选的证据。

资源预算优先使用 start.resourceBudget。未在 start 配置而首次在 verify 提供有效 budget 时，保存为 verificationBudget，后续省略不移除、更改被拒绝，新方案的 collector 继承同一约束。执行预算的 attempts/failed/rounds、时间和 token 记账继续沿用原会话；只读 verify 不增加导航次数，也不能覆盖这些字段。会话链额外检查已记录的原始证据哈希、同一 active 计划的样本绑定和新增资源约束不能在子步骤消失或改变。哈希提供完整性校验，不是人工审阅签名或对整个本地历史恶意重写的认证。

collect 与 verify 共用交互/Liquid 固定逻辑，各类证据独立处理：导航目录暂时不可读时，仍保存能独立核验的其他样本和资源预算，然后报告读取错误，不进入验收。交互范围优先使用已读取的正式矩阵；无法读取时只使用保存的正式采集配置或已固定的候选探索配置，不猜测预览身份。最终验收仍要求完整正式矩阵与所有原门禁。

采集器即使在写样本或写最终回执后直接抛错，finally 也会固定已落盘证据，未知进度保留全部预留次数并记录失败。只要 formalCollection 已建立，verify 就只能读取该任务的 acceptance 目录；读取失败、缺报告或缺回执不授权改用另一目录。仅已有的零导航证明规则可以解除旧采集任务。

formal-sample-lock.mjs 单独保存可读 run.json 和报告文件的原始字节哈希；一份报告缺失不解除其他文件的固定。可以恢复缺失的原报告或补附属证据，不能重写已有分数。采集器上报次数小于落盘记录显示的次数时拒绝退款、保留原目录并报错；后续只读 verify 可使用同批样本继续，不能重新 collect。会话链同时检查采集目录、测量配置、观察到的次数和原始文件锁的继承。

新增回归包含：改变成本后选中另一源码；新 CSS 覆盖率改变真实生成文件并阻止旧审阅；新覆盖率令方案不可行；交互和 Liquid 正式无收益的预检拒绝；证据错配不误杀方案；修复证据不能更换正式样本。recovery-adaptive-browser.test.mjs 使用真实 Chrome、实际覆盖率、生成器、apply 和内容/计算样式/点击回归，源码拉取使用本地复制适配器。它不提供商家评分或 Liquid 服务器收益证明。
