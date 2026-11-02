# 工具包功能升级：范围、执行与验收

本轮将整改报告的经验转化为通用工具能力，沿用现有诊断、可逆计划、独立实验和正式验收。报告陈述不直接授权主题补丁。这些能力自 0.14.0（2026-11-02）随源码发行包交付。观察契约为 version 2；旧报告需重建基线，显式归属必须绑定当前 sourceHash，资源替换要求字面唯一 id。

## 六项交付

| 计划 | 入口与实现 | 验收边界 |
| --- | --- | --- |
| 统一排序 | candidate-priority，diagnose-performance / recovery 共用 | 不同成本口径不直接比较，不把时长当作节省预测；收益上限阻断、目标、线上影响、证据、执行范围优先 |
| 资源成本 | audit-performance.intelligence.resources；audit-resources 配置 URL | 逐采样保留请求数、唯一 URL、源码引用、发起链、传输和 CPU；配置 URL 可能是导航链接，只是候选 |
| 资源健康 | runtime-profile、theme workflow | img 解码与 picture 实际选源；背景图保留未验证状态；截断、未触发和未绑定失败显式报告；自动修复仍限原直接 img 子集 |
| 字体闭环 | intelligence.fonts、analyze-code、liquid-font-display | computed stack 不能证明实际字形字体；保留字体身份与所有其他参数；独立实验、内容/几何/视觉回归仍必需 |
| 豁免与归属 | import-check、audit-performance --checks / --ownership / --baseline | 规则禁用与修复分开；性能规则观察独立运行；归属线索不授权修改；哈希变化不推断覆盖原因 |
| 结构依赖 | audit-performance / audit-quality intelligence.structure | 顶层与 block 设置分计、直接引用、settings 别名、动态访问、visible_if 及调用关系；不授权删除，不推断性能收益 |

## 审计与比较

```sh
node scripts/perfkit.mjs audit-performance --project /absolute/theme --profiles /absolute/task/profiles.json --out /absolute/task/audit-before.json
node scripts/perfkit.mjs audit-performance --project /absolute/theme --profiles /absolute/task/profiles-after.json --baseline /absolute/task/audit-before.json --checks /absolute/task/check-import.json --ownership /absolute/task/ownership.json --out /absolute/task/audit-after.json
node scripts/perfkit.mjs report --input /absolute/task/audit-after.json --out /absolute/task/audit-after.html
```

profiles 是已有 runtime-profile 的对象/绝对路径数组。仅消费当前源码和前后部署证明有效的 profile；缺少这些数据时保留拒绝/未测，静态分析仍可用。观察基线只在完整、同项目、同规则与运行证据范围契约下比较。改变规则或输入范围后建立新基线，不把 absent 当成修复证明。原始完整报告留存，不补填旧源码指纹。

ownership 文件格式：`[{"file":"sections/example.liquid","sourceHash":"当前文件实际 SHA-256","owner":"generator","evidence":"经核对由 PageFly 管理，修改应在生成器端执行"}]`。owner 支持 theme/generator/app；同文件不能重复，sourceHash 必须匹配当前文件。生成器调用共享文件只标为 generator-referenced-candidate，不推断该共享文件由生成器托管。审计输出 intelligence.ownership 可作为 plan-site 的 recipe.ownership，计划核对变更文件的原始哈希；源码漂移时重新审阅。既有 apply/rollback 的源码冲突保护继续有效。

## 字体与资源配方

先 analyze-code 获取字体 outputStart 和待审要求。liquid-font-display 参数为 `{ "outputStart": 0, "display": "swap" }`，支持 swap/optional，证据为当前 sourceHash、具体 summary、fontUsageReviewed 和 fallbackMetricsReviewed。布尔值仅在实际审阅后填写。动态 font_display、位置参数或重复参数拒绝生成。

liquid-rehost-resource 参数为 `{ "tagStart": 0, "replacementUrl": "https://approved.example/resource.js", "originalBodyHash": "实际 SHA-256", "replacementBodyHash": "相同 SHA-256" }`。证据要求 identicalResponseBytesReviewed、dependenciesReviewed、contentTypeReviewed、corsAndIntegrityReviewed，以及当前 sourceHash/summary。仅支持具有字面唯一 id 的 script、资产 link、直接 img 的字面外链，拒绝事件处理器、srcset/sizes、picture/template/循环上下文、重复及动态属性。检查依赖相对 URL、CSP、SRI、CORS、授权内容与实际 GET，工具不自动获取或搬迁素材。

通过 plan-site → 审阅 → apply → 显式同步 → experiment → 正式 verify 使用。已有关键 CSS、作用域加载、脚本策略仍为资源成本诊断后的主要入口。不要仅凭外部域名或未覆盖状态删除资源。

资源替换正式验证在原 regression 对象增加：

```json
{"resourceProfiles":{"before":["此处实际应放完整部署绑定 runtime-profile 对象"],"after":["同样为完整对象"]}}
```

以上字符串是格式提示，不是可通过的证据。正式输入需要 profile 对象数组，每个导航页面/设备均覆盖相同状态。图片/字体通过 profile.hashResourceUrls 明确采集浏览器实际响应的哈希；脚本/样式沿用现有采集。验收重算源码、页面、设备、店铺、主题与采集顺序，要求前后完成的 GET、响应 SHA-256 和与元素用途相符的 MIME 相同，并绑定实际唯一 DOM 节点；前后声明及实际操作必须一致，源码差异仅来自计划。缺证据返回未接受；内容 checkpoint 只允许确定性生成器所声明的 URL 属性变化，其他内容、样式和几何仍须一致。源站响应等价不证明依赖等价，功能和视觉审阅继续保留。

## 验证

`node --test tests/toolkit-evolution.test.mjs` 验证排序、缺失/截断状态、逐采样计数、两种生成器、可逆计划、部署等价、结构依赖、观察基线与报告。`PERF_KIT_BROWSER_TESTS=1 node --test tests/toolkit-evolution-browser.test.mjs` 在真实 Chrome 隔离页面验证 200 HTML 坏图、picture 实际选源、字体显示与文本尺寸。全量仍使用 npm test 与 Python 报告测试。

测试夹具不代表 Shopify 店铺测分或主题全量 Theme Check；商家主题与未发布预览实际优化仍需提供真实源码/运行证据并通过原正式门槛。

## 全流程接入与复审修复

batch 支持顶层 `ownership`（带当前 sourceHash 的归属数组）及 `performanceBaseline`（独立性能审计的绝对路径）。这些输入传入诊断与最终 audit-site，recipe 未单独携带归属时自动用于准备计划。通过 bottlenecks.profiles 提供的已保存采样也会传给最终审计，不能只在诊断中使用后丢弃。audit-site / diagnose-performance CLI 分别支持 --ownership、--performance-baseline，诊断另支持 --checks。

所有 plan-site 准备都会重读当前归属上下文，检查器候选只说明生成器引用关系，不授予修改权限；显式旧归属的 sourceHash 不匹配时拒绝继承。批处理报告同时呈现观察差异与豁免覆盖，不用一个表覆盖另一个。

`optimize verify` 和 improve collect 的 formal 配置接受 `resourceProfiles`。它可以是含 before/after 的对象或 JSON 文件路径，两侧为完整 profile 对象或文件路径数组。采集器在开始测分前校验并加载这些证据，随后完整保存到 regression.resourceProfiles；verify-optimization 的直接输入仍使用 regression.resourceProfiles。健康快照缺版本、缺 images 或采样截断时不能作为完整观察基线；解码超时与选源变化保留未知状态。

`tests/toolkit-evolution-review.test.mjs` 包含真实主流程的合成合同回归：资源证据从采集到正式验收、丢证据拒绝、归属从 batch 到计划/最终报告、无关请求/节点和未完成 GET、同 URL 其他节点不得获得内容豁免、作用域与 visible_if 误判等。合成合同回归不代表商家性能实测。

多页面资源验收允许有完整 DOM 采集且前后均无目标节点/请求的页面保持“未受影响”；截断或旧采集缺少范围记录时不能推断未使用。每项资源替换仍必须至少在一个受影响页面取得真实完成 GET 与响应等价证据，不能用整套未使用页面证明提速。资源成本按原始 URL 关联后才脱敏，CPU 在 resourceGroups 内只计一次；耗时已观察但未绑定源码的资源进入工作流调查任务，不能冒充可执行补丁。资源审计保留配置 JSON 路径，无可靠行号时使用 null，并识别 `.js.liquid` 对编译后 `.js` 的解析关系。
