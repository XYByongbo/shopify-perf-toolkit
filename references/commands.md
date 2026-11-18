# 命令参考（v0.20.0）

在工具根目录执行 `node scripts/perfkit.mjs --help` 查看全部参数。--out 要求新文件/新目录，不覆盖旧证据；唯一例外是 improve 的 action=recover，必须使用 next-step.json 指向的原中断目录，原子补齐缺失的 session.json。--project 是主题源码根目录，--target 是其内相对路径。doctor 检查可用性，不代表浏览器启动或网络已验证。

用 `perfkit <命令> --help` 或 `perfkit help <命令>` 查看单个命令的参数。方括号表示可选项，有多种合法值的参数会列出可选值。对于接受 `--config` 的命令，可先检查 JSON 配置：

```sh
node scripts/perfkit.mjs validate-config --command measure --config /absolute/measurement.json
```

`validate-config` 检查配置的字段、值和可在本地判断的约束，返回 JSON 到标准输出。部分采样命令会返回预计样本或场景数量，超出尝试预算时给出提示。通过时退出 0，配置错误退出 2。`optimize verify` 会计算探索和正式采样的总尝试次数，预算确定不足时返回 `insufficient-budget` 并退出 3。校验无需 `--out`，也不会启动任务、创建输出、启动浏览器或执行 Shopify 命令。证据引用的内容、环境能力、源码指纹和部署身份由正式命令校验。`improve-cycle` 中引用的本地官方方法配置会按需读取，以核对方法和执行器是否一致。

| 命令 | 主要参数 | 结果 |
| --- | --- | --- |
| doctor | 无命令专属参数；不支持 --out | 当前版本与本机能力，输出到 stdout；不替代实际启动和回归 |
| validate-config | --command、--config | 只读配置预检。用 `validate-config --help` 查看支持的命令 |
| check-theme | --project、--out | 实际项目 Theme Check 的版本、规则列表、生效配置、原始诊断与源码绑定；不自动修复 |
| plan-sampling | --audit、--finding、--url、--out；可选 --device、--selector、--theme-id、--store、--settle-ms | 从性能审计生成 profile-runtime 或 profile-domain 配置，保留发现与源码指纹 |
| plan-verification | --config、--out | beforeFiles/afterFiles/scope 推断最低验证级别及未运行清单 |
| import-pageotter | --input、--out；--project/--baseline 可选 | 提议的 handoff v1 外部观察导入；同范围显式复测对比，不替代正式验收 |
| diagnose-performance | --project、--profiles；--run/--checks/--ownership/--performance-baseline 可选，--out | 统一候选排序、资源/字体调查、归属与结构上下文 |
| profile-domain | --config，--out 新目录 | 测量前后部署身份绑定的 runtime/Liquid 证据 |
| optimize | --config，--out 新目录 | prepare/apply/verify；verify 的 resourceProfiles 接入采样前及正式验收 |
| verify-optimization | --config，--out | 按所选策略验收目标收益、身份、功能、视觉及适用的资源/规范证据；省略 acceptancePolicy 保留原分数门禁 |
| plan-resource-repair / verify-resource-repair | --project/--profile/--config，或 --config；--out | 受限坏图修复与独立内容恢复验收，不计性能收益 |
| improve-cycle | --config，--out 新目录 | 审阅、同步、采集和正式验收的可恢复执行 |
| audit-html | --input 绝对 HTML 路径；--fragment true/false、--lcp-id 可选，--out | 保存的渲染 HTML 检查；错误/警告退出 3，不证明源码身份或性能验收 |
| theme-diff | --before、--after 主题目录，--out 新文件 | 全量哈希与 JSON 字段/内嵌代码差异；本地快照，不推断部署或提速 |
| audit-quality | --project；--checks 可选，--out | 代码、SEO、结构依赖与归属的静态候选分析 |
| sync-shopify-docs | --config 可选，--out 新目录 | 有界获取官方文档元数据；失败/截断保留 incomplete |
| shopify-methods | --sources、--topic、--out 可选 | 导出方法卡、真实生成器参数与来源审阅状态 |
| plan-official | --project、--config、--diagnosis、--out；--profiles、--sources 可选 | 当前证据绑定的官方方法补丁；见 shopify-knowledge.md |
| improve | --config，--out 新目录；action=recover 使用原中断目录 | 可恢复的实测优化会话及显式中断恢复；保留预算、证据和历史，副作用阶段中断先回滚；见 improvement-workflow.md |
| batch | --config，--out 新目录 | 报告导入/外链脚本分析/测量/审计验收；预算/早停 |
| summarize | --run，--out 可选 | 全部单次分数与警告的精简摘要 |
| evaluate-iteration | --config，--out 可选 | 候选历史收益、负向、噪声门槛及早停 |
| scan | --project，--pages 可选 URL 数组 JSON，--out | site-scan：库存、依赖、候选、未解析关系 |
| check-performance | --project，--config 可选 timeoutMs JSON，--out | 独立官方性能检查，冻结 Liquid/JSON/JS/CSS 快照；与两规则 precheck 并存 |
| audit-performance | --project，--profiles、--baseline、--checks、--ownership 可选，--out | Shopify P0/P1 的 27 组候选、按能力区分的覆盖状态与未完成项 |
| import-check | --project，--input，--metadata/--baseline 可选，--out | 规范报告、校正注记、同口径增量门禁 |
| audit-resources | --project，--probe true/false 可选，--out | 外链、脚本顺序与符号依赖候选；默认离线 |
| inspect | --project，--target，--capture 可选，--out | 文件级诊断 |
| map | --project，--capture，--target 可选，--out | 源码关联及不确定项 |
| measure | --config，--out 新目录 | run.json、各组原始 LHR 和失败记录 |
| audit-site | --project，--run 测量目录，--checks/--resources/--ownership/--performance-baseline 可选，--out | 实测指标、资源、优先候选及证据 |
| code-strategies | --out 可选 | 可执行策略、参数、证据与回归要求 |
| analyze-code | --project，--target，--out 可选 | 单文件结构候选、拒绝原因、未填写的 recipe；不改源码 |
| plan-site | --project，--recipe，--out | 多文件差异、指纹和完整快照 |
| apply / rollback | --project，--plan，--out 可选 | 应用/回滚 receipt；兼容单文件计划 |
| capture | --url，--selector，--out 新目录 | capture.json、截图、可选 mapping.json |
| scenarios | --config，--out 新目录 | 移动/桌面场景运行与显式断言 |
| verify | --before capture.json，--after capture.json，--out | 内容/几何比较，不是评分 |
| verify-site | --before 测量目录，--after 测量目录，--thresholds 可选 JSON，--out | 完整矩阵评分 |
| report-pdf | --config，--out 新绝对目录 | report.pdf 与完整源码证据 report.json |
| report | --input JSON，--out HTML | 离线 HTML |
| plan-image | --project，--target，--image 源码索引，--sizes，--widths，--out | 简单响应式图片计划 |
| plan-component | --project，--target，--replacement，--rule，--reason，--out | 已审阅单文件候选计划 |
| lighthouse | --before 原始报告目录，--after 可选，--out | Python 汇总，不启动测量 |
| score-target | --before 原始报告目录，--after，--minimum/--target 可选，--out 可选 | 单页/单设备门槛 |

capture 可指定 --width 390 --height 844 --dpr 1 --wait-ms 1500 --timeout-ms 30000；--project 与 --target 用于源码关联。尺寸与状态应在前后保持相同。

保存 doctor 输出可用 `node scripts/perfkit.mjs doctor > /absolute/run/doctor.json`，目录须已存在，目标应为新文件；`seokit doctor` 同样不支持 --out。Shell 重定向不提供 CLI 的防覆盖保护。

正式优化的配置位置、两种策略及采样要求见 [新旧验收策略](standards-upgrade.md#两种正式验收策略)。只设置 goal 不会切换策略；verify-site / score-target / batch.acceptance / ci-check 保留原评分行为，最终优化结论来自 verify-optimization。

退出码：0 表示该命令完成/该门槛通过；2 表示无效输入、证据或执行错误；3 表示诊断不完整、回归、未达标或需复核；4 表示相关浏览器依赖缺失。scan/audit-site 返回 0 不是性能通过，inspect 也不证明无瓶颈。measure 的 complete 仅表示本轮采样有效，评分由 verify-site 判断。

apply/rollback 操作和 receipt 输出分开处理；输出写入失败仍需检查 stdout 的真实 receipt 和 stderr，不能只因退出非零就推断源码未改动。

环境变量：PERF_KIT_BROWSER_EXECUTABLE（Chrome 绝对路径，本地测量亦支持 CHROME_PATH）、PERF_KIT_PLAYWRIGHT_MODULE（已有模块）、PERF_KIT_PYTHON、PERF_KIT_LIGHTHOUSE_CLI（自定义本地 CLI，必须绝对路径）、PERF_KIT_PSI_API_KEY（只用于 PSI）。不要将密钥写入配置、recipe 或报告。

默认 --format summary，--format full 可取完整 stdout；--out 文件始终完整。measure 默认 --progress quiet，也支持 group/attempt。预算、探索和原始证据协议见 [execution.md](execution.md)。

兼容性例外：apply/rollback 未提供 --out 时，stdout 仍保留完整操作回执，避免丢失部分写入/恢复记录；正常工作流应提供 --out，以只返回回执路径。回执输出失败的原保底机制不变。

报告输入格式、扫描契约和联网边界见 [规范与资源检查](code-quality.md)。import-check 缺少可比证据或基线门禁需复核时返回 3；audit-resources 的 0 只表示受支持分析完成，网络状态需单独查看。

batch 的 status=complete 仅表示执行完成。reviewRequired=true、停止/失败或评分未通过时退出 3；读取 diagnostics 与 acceptance 各自结论。配置校验失败仍退出 2。提供 project 默认离线资源分析，resources=false 关闭，resources.probe=true 显式联网。

- `audit-quality --project <theme> [--checks <check-import.json>] --out <new-quality.json>`：只读代码、SEO、JS/CSS 与架构分析；结构化结果保留未解析范围。

## 代码提分引擎

新增 profile-runtime、profile-devtools、profile-liquid、verify-deployment、verify-gain、verify-optimization、plan-split、optimize。精确参数见 CLI --help；JSON 配置、策略边界、分阶段闭环及例子见 [执行引擎](performance-engine.md)。audit-site 支持 --runtime；batch 支持 runtimeProfiles/liquidProfile/devtoolsProfile/recipe；measure 支持 deployment。

0.10.0 新增 source-graph、diagnose-performance、plan-demand、experiment、verify-patch、verify-preservation。batch 的 bottlenecks 可导入已有 profile 并与本轮 runtimeProfiles 合并，demand 可输出待审补丁。scenarios 新增 checkpoint、project、expectedThemeId。格式与限制见 [单补丁执行流程](demand-engine.md)。
## 0.11.0 P0/P1 命令扩展

新增 `import-field`、`audit-stylesheets`、`attribute-apps`、`measure-interactions`、`verify-interactions`、`ci-check`；`diagnose-performance` 增加 --field/--owners/--goal，`verify-gain` 增加 --goal。optimize、experiment、verify-patch、verify-optimization 可声明 goal，交互目标另需 interactionEvidence。格式、完整架构、采样标准、CI 模板和边界见 [P0/P1 实施说明](evidence-driven-architecture.md)。省略 goal 时保留原评分模式。

0.11.1：scenarios 支持 `{"action":"press","selector":"#control","key":"Enter"}`；交互正式验收必须覆盖 goal.target 的同类操作及紧随的 UI 断言。旧交互采样缺少动作目标/时间等新增证据时重新采集，原评分 LHR 可继续使用。交互契约见 [目标与交互采样](evidence-driven-architecture.md#交互采样)。


## Liquid 前期预检

`precheck --project <absolute-theme> [--config <options.json>] --out <new-report.json>`：只读官方两规则扫描，详细契约见 [precheck.md](precheck.md)。`audit-site` 可用 `--precheck <precheck.json>` 加入独立补充证据。

## 部署绑定的专项优化

- `profile-domain --config <config.json> --out <new-directory>`：runtime 或 live Liquid，采集前后核验部署源码。
- `plan-domain --project <theme> --config <config.json> --diagnosis <diagnosis.json> [--profiles <paths.json>] --out <plan.json>`：生成图片、布局、Liquid 或 App 候选补丁。
- `experiment-liquid --config <pair.json> --out <new-directory>`：交替采集真实 Shopify 服务端 profile，输出可重算证据。

配置、审阅契约、会话集成及实测门禁见 [四类优化闭环](domain-optimization.md)。

0.14.0 的 batch 顶层支持 ownership 与 performanceBaseline；diagnose-performance 支持 --checks、--ownership、--performance-baseline。optimize verify / improve collect formal 用 resourceProfiles 传入前后部署绑定采样，直接 verify-optimization 仍从 regression.resourceProfiles 读取。完整契约与迁移要求见 [功能升级](toolkit-evolution.md)。

0.15.0：`batch.renderedHtml` 为 1–12 项 `{input, fragment?, lcpId?}`，逐项保存 JSON/HTML 并保留 reviewRequired；只消费显式保存的 HTML，不导航或代替评分。`scenarios.checkpoint` 默认输出 version 2；新增表单、焦点和滚动状态，旧 version 1 仅保留历史覆盖，新旧不可混比。见 [HTML 与快照](rendered-html.md)、[购物交互](interaction-scenarios.md)。

0.15.1：多份 HTML 独立保存 `rendered-html-N.transport.json`，完整汇总保存 `rendered-html.json`。`audit-site --html-audits <该数组文件>` 将其作为 `unverified-source` 补充证据带入最终报告，保留具体问题，不混入源码归因或评分。批处理与直接调用均校验 HTML 审查契约；失败/超时保留已完成项及未完成范围。

## 独立 SEO 命令

源码仓库运行 `node scripts/seokit.mjs --help`。SEO 发行包安装为 seokit，包含 doctor、audit-source、audit-html、batch、report、report-pdf。配置及结果契约见 [独立 SEO 工具](seo-toolkit.md)。上面的 perfkit 旧命令继续兼容。

## 源码 SEO 修复和自定义性能实现（0.17.0）

`seokit plan/fix/apply/verify/rollback`、`perfkit request-implementation/plan-custom` 及 `improve prepare implementation` 的参数、配置与完整执行流程见 [源码修复流程](source-repair-workflow.md)。旧命令和原验收门槛保持。

0.18.0：CLI 5 检查格式适配、失败证据、JSON 内嵌审计与两主题对照见 [整改证据](theme-evidence.md)。

## 运行完整性复核（0.19.0）

`audit-runtime-integrity --input <runtime-profile.json> --out <NEW-integrity.json>` 从原始字段重算，退出 0/3/2 分别为窗口内未见异常/需复核或缺证据/输入执行错误。`profile-runtime` 新增 initializationEvents / expectedLcpSelectors；显式 integrityProfiles 正式门禁及完整边界见 [运行完整性](runtime-integrity.md)。


## 交付与持续治理（0.20.0）

- `toolkit-manifest --out <manifest.json>`：发行白名单内容指纹。
- `theme-capabilities --project <theme> [--config <identity-context.json>] --out <capabilities.json>`。
- `resolve-adapter --config <registry.json> --out <resolution.json>`。
- `verify-business --config <business-import.json> --out <verification.json>`。
- `audit-window-budget --config <window-budget.json> --out <budget.json>`。
- `audit-policy --config <policy-audit.json> --out <audit.json>`。
- `strategy-contract --config <contract.json> --out <contract-plan.json>`。
- `field-monitor --config <monitor.json> --out <new-run-directory>`。

详细字段、边界、示例和迁移见 [delivery-governance](delivery-governance.md)。apply 带主题适配器的计划须提供 `--adapter-context <current-context.json>`；optimize/improve apply 使用 adapterContext。真实业务证据另行接入，scenarios 不开放写请求。
