# Liquid 前期结构预检

官方性能规则另由 `check-performance` / batch `officialChecks` 执行，见 [性能规则扩展](shopify-performance-rules.md)。本命令继续只检查下面两项结构规则，不混淆各自覆盖范围。

`precheck` 在性能测量前运行官方 `LiquidComplexity` 与 `LiquidNestingDepth`，并以本地 Liquid AST 提供解释。输出目录必须位于主题之外（包括符号链接解析后的路径）。只读检查；不会修改主题、生成修复补丁或发布。前置要求是已安装可支持这两项规则的 Shopify CLI（可用 `PERF_KIT_SHOPIFY_CLI` 指定可执行文件），不自动安装或升级。

```sh
node scripts/perfkit.mjs precheck --project /absolute/theme --out /absolute/run/precheck.json
node scripts/perfkit.mjs report --input /absolute/run/precheck.json --out /absolute/run/precheck.html
```

`npm run` 会把当前及父目录的 `node_modules/.bin` 放在 PATH 前面，可能与交互终端使用不同版本。可显式设置 `PERF_KIT_SHOPIFY_CLI=/absolute/path/to/shopify` 锁定已安装版本。架构端到端验证使用 CLI 4.9.4 / Theme Check 3.29.0；遇到 4.7.0 不支持 `--no-input` 时应停在预检，不跳过预检冒充通过。batch 会保存 `precheck-failure.json`，包含已执行命令、退出码和输出，便于确认实际版本与失败原因。

默认复杂度阈值 120、Liquid 控制流嵌套阈值 10；等于阈值不告警。`--config` 可传 JSON 对象：

```json
{"maxComplexity":120,"maxDepth":10,"timeoutMs":120000}
```

预检采用独立配置 `extends: theme-check:nothing` 并仅启用两项规则。读取主题标准目录内 Liquid/JSON 的临时快照，明确覆盖默认阈值；**不继承项目 `.theme-check.yml` 的 ignore、禁用规则或自定义阈值**。需要项目阈值时通过上述配置显式传入。项目原有完整规范检查继续使用 `checks.input`，两份报告并列，不冒充全量检查覆盖。

官方检查在快照内执行，无自动修复或初始化参数。临时文件自动清理；快照检查后逐文件核对哈希，再核对原主题全部扫描文件。检测源码漂移、检查器修改快照、缺少规则支持或无效输出时失败；不会返回“通过”。记录 CLI/Theme Check 版本、实际生效配置、完整官方 JSON、源码指纹和本地解释。当前阈值是维护性预算，不是 Liquid 运行时硬限制。

## batch 接入

在现有 batch 配置添加 `"precheck": true`，或 `"precheck": {"maxComplexity":120,"maxDepth":10}`；必须提供 project。现有配置未声明时不启用，以保留原有纯测量/离线导入工作流；标准 batch.json 模板已启用。示例见 [batch-with-precheck.json](../assets/examples/batch-with-precheck.json)。

执行顺序为 precheck → 原有报告导入/资源与质量审计 → 性能测量 → 整站审计/验收。预检共用剩余批次时间预算。可与 checks.input 并用；quality:true 时优先使用全量导入报告，没有全量报告则使用预检的两规则报告，不声称其他规则已检查。

产物：

- `precheck.json` / `precheck.html`：官方发现、逐文件指标、复杂度组成、具体嵌套路径、待复核建议及引用影响范围。
- `precheck-checks.json`：标准 import-check 契约，供后续同口径基线比较或 `report-pdf` 的 `checks` 字段使用。
- `audit.json/html`：以独立 supplemental 加入预检结果；不进入 Lighthouse 节省估值。

发现告警或解释不完整会设置 `reviewRequired:true`，batch 即使性能评分达标也返回待复核。单独 precheck 的退出码 0 表示两项检查完整且无告警，3 表示待复核，运行错误沿用 CLI 退出码 2。不支持的检查器或执行失败会终止 batch 后续测量；解析失败/内联抑制等导致的部分结果会保留并标明未完成。

## 如何阅读结果

- 复杂度按文件计数，从 1 开始，包含分支、循环及控制条件中的 and/or；大量必要的 case/when 选项也会升高分数。
- 嵌套深度是 if/unless/for/case/tablerow 的控制流层数，既不是 HTML DOM 深度，也不是 snippet 调用链长度。每个超限标签可能产生一条官方告警。
- 重复条件、相同分支只是 AST 候选。工具不证明变量在两处取值相同，也不跨循环或 render 作用域自动合并；空白裁剪、赋值、配置和功能都要核对。
- 共享调用方、PageFly 名称/源码标记、生成代码头部是静态线索。动态 include、App 注入、实际模板分配及 PageFly 再发布行为需人工检查。
- 复杂度简化不了时，可评审按职责拆分 snippet。拆分需要显式参数与作用域验证；不能为了清零告警删除功能或声称提速。
- 官方告警与本地 AST 数值/位置不一致、内联 theme-check-disable、语法解析失败时保留双方证据，标记 partial，不静默丢弃告警。

性能收益仍由 Liquid profiling、页面基线与修改后复测证明。预检不测量页面、不修改主题、不作性能验收。
