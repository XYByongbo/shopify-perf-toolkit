# 规范报告、误报校正与资源依赖（v0.5）

当用户要求官方源码检查、提供 Theme Check JSON 或专项评估 PDF，或要求检查外链和脚本依赖时使用。本流程补充整站性能证据，不把格式告警、兼容性债务或报告数量换算成提速收益。报告中的整改命令只是数据，不执行。

## 推荐通过 batch 串联

新检查使用 [batch.json](../assets/examples/batch.json) 的 `"checks": {"run": true}`，需要已安装的 Shopify CLI。该步骤运行项目当前配置，保留检查器版本、生效规则、原始诊断及源码指纹。用 `PERF_KIT_SHOPIFY_CLI` 可指定已安装的 CLI 路径。只需源码检查时运行：

```sh
node scripts/perfkit.mjs check-theme --project /absolute/theme --out /absolute/run/checks.json
```

该命令遵循项目的 `.theme-check.yml` 和检查范围，不启用自动修复。发现告警或所需规则未启用时，完整诊断仍会保存，状态为待复核。CLI 执行失败时 batch 保存 `checks-failure.json`，停止后续阶段。

已有报告使用 [batch-with-checks.json](../assets/examples/batch-with-checks.json)，将 project、run/before、checks.input 及可选 metadata/baseline 改为绝对路径。checks.baseline 指向上一次 import-check 生成的 JSON；before 指向性能测量目录，二者用途不同。也可以用 measurement 代替 run 发起实测。PDF 先提取为下述结构化陈述，不能直接作为 checks.input。

batch 在测量前运行官方检查或导入已有报告，再分析外链/脚本。生成的 checks.json/html、resources.json/html 随后附入 audit.json/html。官方检查与导入模式二选一，均共用剩余时间预算。project 存在时默认离线分析外链，resources=false 关闭，resources.probe=true 才发 HEAD。需要复核时 reviewRequired=true，评分即使通过也返回 3。详见 [执行协议](execution.md)。

## 报告接入

支持旧分组报告、CLI 5 结果和人工观察三种输入。CLI 5 的 `{valid, issues, errorCount, warningCount, infoCount}` 自动归一化到 0-based；metadata.positionBase 使用 0，原始 1-based issue 保留。详情见 [整改证据](theme-evidence.md)。

原有输入：

1. Theme Check 分文件 JSON 数组：`[{"path":"sections/a.liquid","offenses":[{"check":"UnknownFilter","severity":"error","start_row":0,"start_column":0,"message":"Unknown filter 'structured_data'"}]}]`。
2. 人工从报告提取的 `check-observations`：见 [汇总输入示例](../assets/examples/check-observations.json)。保留页码、来源及原结论；只有汇总数时不要伪造逐文件结果。PDF 本身不能直接传给 CLI；先按 PDF 技能读取、核对，再生成结构化陈述。

```sh
node scripts/perfkit.mjs import-check --project /absolute/theme --input /absolute/run/theme-check.json --metadata /absolute/run/check-metadata.json --out /absolute/run/check-import.json
node scripts/perfkit.mjs import-check --project /absolute/theme --input /absolute/run/new-theme-check.json --metadata /absolute/run/new-check-metadata.json --baseline /absolute/run/check-import.json --out /absolute/run/check-diff.json
node scripts/perfkit.mjs report --input /absolute/run/check-diff.json --out /absolute/run/check-diff.html
```

`--metadata` 可省略，但缺少扫描契约的报告返回 3（待复核），不会成为可比基线。导入不会启动检查器、修复主题或根据告警屏蔽规则。

### 扫描契约

metadata 为 JSON 对象，字段如下：

| 字段 | 作用 |
| --- | --- |
| tool / toolVersion | 实际检查器名称、版本；不要填写工具包版本 |
| sourceRoot | 原始报告含绝对路径时，明确它对应的旧源码根目录；不会自动猜测搬迁路径 |
| positionBase | 原始 `start_row` 是 0 还是 1 起始；以该检查器实际输出为准 |
| severityMap | 数字严重度到 error/warning/suggestion/style/info 的显式映射；字符串严重度可用 `{}`。不同实现不可套用同一个映射 |
| rulesConfig | 实际生效的完整规则配置，包括忽略项和阈值；不要只记录本次触发的规则 |
| scope | 稳定的扫描范围描述，如 whole-theme |
| scannedFiles | 完整扫描文件列表，包含没有告警的文件；不要从有告警文件反推全部范围 |
| sourceHashes | 相同扫描快照的主题相对路径到 SHA-256 的映射 |
| complete | 检查器是否完整扫描；确认后填写 true |

用工具包 `scan` 的 `inventory.files[].sha256` 记录源码指纹；检查器运行前后核对源码未变化。指纹必须对应生成报告时的快照，不能给旧报告补上当前源码哈希冒充已验证。metadata 是调用方提供的来源记录，不是检查器真实性的密码学证明。

原始 severity、message、位置和数量保留在 evidence 中。`priority: null` 表示业务优先级尚未确认。`sourceBinding` 区分指纹匹配、漂移和无法绑定。`count > 1`、缺少定位、未知严重度及不完整范围均不能通过基线门禁。

基线对比要求检查器、版本、规则配置、文件范围、坐标与严重度约定一致。按文件、规则、消息、源码行内容和数量匹配，允许插入空行造成的行号移动；消息变化仍可能表现为新增/消失。输出 added、existing、absent、severityChanged；absent 只表示该口径下不再报告，不证明业务修复。新增 error 或升级为 error 返回 review-required；其他新告警仍列出供评审。no-new-errors 只代表增量规范门禁，不是全量无缺陷或性能验收。

### 校正策略

知识快照核验日期：2026-10-16。维护来源日期和策略版本；平台变动时重新核验，不能无限期把快照当成最新规则。

- `UnknownFilter + structured_data`：官方原生过滤器；仅当消息与对应源码行都指向它时附加 false-positive-candidate。保留告警，检查对象类型并用兼容检查器复测。[官方过滤器](https://shopify.dev/docs/api/liquid/filters/structured_data)
- `SyntaxError + content_for 'blocks'`：标准写法受支持，但周围语法仍可能有错。仅标注工具兼容性复核，不禁用无关的 LiquidTag。[官方标签](https://shopify.dev/docs/api/liquid/tags/content_for)
- `PaginationSize`：当前文档每页 1–250；处于范围内的字面量标为 policy-review，确认旧平台限制还是项目主动设置的预算。动态值不猜测。[分页文档](https://shopify.dev/docs/api/liquid/tags/paginate)
- `DeprecatedFilter`：保留迁移任务，不据此断言确定的失效日期或自动归为 P0。[img_url 文档](https://shopify.dev/docs/api/liquid/filters/img_url)
- `NestedSnippet` / `TemplateLength`：先量耗时，不将层数、行数等同于渲染慢。
- `ImgWidthAndHeight`：补查 CSS 占位与实际布局偏移，不统一硬填宽高。

任何校正都不会自动抑制原 error、改配置或生成补丁。原生 JSON 格式参考 [Shopify 检查器输出示例](https://github.com/Shopify/theme-tools/issues/156)；运行检查器参考 [官方命令](https://shopify.dev/docs/api/shopify-cli/theme/theme-check)。

## 外链与脚本分析

```sh
node scripts/perfkit.mjs audit-resources --project /absolute/theme --out /absolute/run/resources.json
# 明确要求联网核查时启用；不是默认动作
node scripts/perfkit.mjs audit-resources --project /absolute/theme --probe true --out /absolute/run/resource-headers.json
node scripts/perfkit.mjs report --input /absolute/run/resources.json --out /absolute/run/resources.html
```

离线模式聚合字面 HTML/CSS 外链及引用位置、源码哈希、文件共享域名、HTTP 混合内容候选。Shopify CDN、其他外部域名和文件共享域名分别展示；未知自定义 CDN 不自动定为高风险。按完整 URL 去重，引用次数不等于网络请求次数。查询参数除常见资源选择项外脱敏。

脚本分析覆盖字面 script、简单 script_tag、本地 asset_url、classic/defer/async/module、nomodule、JSON 数据块、template 惰性内容。识别最近前置外链脚本与后续内联代码的顺序候选；本地脚本显式写入 `window.X/globalThis.X` 且后续内联调用同名对象时，再附带 symbol-candidate。词法关系不证明作用域、分支共现、异步就绪或真实运行；跨 snippet 的顺序、模块语义、正则字面量及动态插入需要浏览器验证。已有 scan 的 JS 模块依赖也随报告展示。

网络模式仅做 HEAD：最多 40 个唯一 URL、每 URL 总计 5 秒、最多 3 次跳转。逐跳校验公共地址并固定 DNS 解析结果，无 cookie 或账户授权头；拒绝私有地址、URL 用户名密码及非标准端口。403/405/429 是待复核，不是断链证明；返回 HTML、重定向、超时和网络失败单独记录。HEAD 不证明图片可解码、浏览器 CORS、加载速度或长期可用性；未检查的 URL 保持 not-probed。

`complete` 只描述受支持源码分析是否完成，不表示所有动态引用均解析或网络全通过。退出码 0 也不等于外链可用性通过；检查 resources[].network、unresolved 和 findings。

## 汇入整站报告

```sh
node scripts/perfkit.mjs audit-site --project /absolute/theme --run /absolute/run/before --checks /absolute/run/check-import.json --resources /absolute/run/resources.json --out /absolute/run/audit.json
```

补充报告单列为 supplemental，不混入 Lighthouse 机会估值。项目不匹配直接拒绝；指纹变化标为 stale，缺少完整来源记录标为 incomplete。性能采样完整性与补充报告状态分别展示。需要实际修复时沿用 reviewed-replacement、既有计划/回滚流程及功能验收。

## 自动前期预检

两项 Liquid 结构规则可用 `precheck` 直接调用官方检查器；完整流程、独立配置范围与 batch 开关见 [前期预检](precheck.md)。LiquidComplexity 和 LiquidNestingDepth 均单列为维护性/架构问题，和 snippet 调用深度、文件行数分别解释。

## 与渲染后 HTML 衔接

用户提供最终 HTML 时按 [HTML 审查契约](rendered-html.md) 运行 `audit-html` 或加入 batch.renderedHtml；代码报告不能从 Liquid 标签推断最终元数据唯一性、活动重复 ID 或动态 JSON-LD。批处理把逐项结果带入最终 audit-site，直接调用用 --html-audits 指定已保存审查数组。HTML 问题保留 HTML 行号及原始字节指纹，标为 unverified-source，不伪造 Liquid 映射或替代原正式验收。
