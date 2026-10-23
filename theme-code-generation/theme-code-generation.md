# Shopify 主题代码生成规范

版本：1.1（试行）  
官方文档核验日期：2026-10-20  
适用范围：新增或本次修改的 Shopify Liquid 主题代码。既有问题建立基线，不因局部任务自动重构全站。主题 App Extension 应采用对应配置，不能直接套用本目录的普通主题模板。

本文件维护共享规则、预算和生成后检查。**日常新建 Section 或增加能力，先执行 [Section 生产规范](section-production.md)**：在内容模型、schema、Liquid、CSS 和 JS 的编写阶段采用标准，再用本文件验收。两部分属于同一个 `theme-code-generation` skill。

## 1. 规则来源与执行级别

| 标记 | 含义 | 处理方式 |
| --- | --- | --- |
| OFF-PLATFORM | 官方平台限制或语言语义 | 遵守当前平台契约 |
| OFF-CHECK | 官方 Theme Check 规则 | 保留官方规则名；按实际版本、启用项和配置判断 |
| OFF-GUIDE | 官方推荐实践 | 结合使用场景落实，不声称所有建议都是运行硬限制 |
| PROJ | 本项目试行约定 | 明确预算、适用范围、复核方式和例外 |

官方 warning 不等于平台拒绝运行，error 严重级别也不代表每条都是上传硬限制。项目可以收紧检查，但必须记录配置差异。源码行数、控制流嵌套、snippet 调用层数、HTML DOM 深度、字节体积和运行耗时是不同指标。

## 2. 官方依据

下表选择与生成质量直接相关的规则，不是完整官方规则清单；仍需执行目标主题配置启用的检查。

| 编号 / 来源 | 官方含义 | 生成时的要求 |
| --- | --- | --- |
| OFF-CHECK-01 [LiquidComplexity](https://shopify.dev/docs/storefronts/themes/tools/theme-check/checks/liquid-complexity) | 每文件从 1 计数；分支、循环、elsif/when 及控制条件中的 and/or 增加复杂度；默认上限 120，warning | 组织独立职责，减少重复判断；项目采用更低复核线，见第 3 节 |
| OFF-CHECK-02 [LiquidNestingDepth](https://shopify.dev/docs/storefronts/themes/tools/theme-check/checks/liquid-nesting-depth) | 统计 if/unless/for/case/tablerow 嵌套；else/elsif 不增加深度；默认上限 10，warning | 避免持续叠加控制流；不能把它当作 DOM 或 render 调用深度 |
| OFF-PLATFORM-01 / OFF-CHECK-03 [MaxFileSize](https://shopify.dev/docs/storefronts/themes/tools/theme-check/checks/max-file-size) | 按路径检查字节上限；如 sections Liquid、snippets 为 256 KB；非 assets 文件不计 schema 内字节 | 遵守各路径上限；schema 和业务代码的维护性仍分别检查 |
| OFF-CHECK-04 [ExcessiveSettingsCount](https://shopify.dev/docs/storefronts/themes/tools/theme-check/checks/excessive-settings-count) | 默认最多 40 个顶层带 id 的设置；不计 header/paragraph 和嵌套 block 设置 | 不因未超这个计数就无限添加配置；项目同时复核 block 内配置 |
| OFF-CHECK-05 [检查目录](https://shopify.dev/docs/storefronts/themes/tools/theme-check/checks) | 包含语法、schema、缺失资源、未定义对象、未知过滤器、废弃用法等检查 | 使用真实存在的资源、对象和主题接口，修复本次引入的错误 |
| OFF-CHECK-06 [AssetSizeCSS](https://shopify.dev/docs/storefronts/themes/tools/theme-check/checks/asset-size-css) / [AssetSizeJavascript](https://shopify.dev/docs/storefronts/themes/tools/theme-check/checks/asset-size-javascript) | 对相应样式或脚本资源执行体积检查 | 查看当前版本的具体计量和阈值；不能用源码行数或 MaxFileSize 替代 |
| OFF-PLATFORM-02 [render](https://shopify.dev/docs/api/liquid/tags/render) | 外部创建的局部变量需传参；snippet 内赋值不向调用方返回；部分全局和上下文对象仍可访问 | 提取 snippet 前列出输入、输出和副作用，不依赖跨 render 修改局部变量 |
| OFF-PLATFORM-03 [JavaScript / stylesheet tags](https://shopify.dev/docs/storefronts/themes/best-practices/javascript-and-stylesheet-tags) | 原生 javascript/stylesheet 标签内不求值 Liquid；打包脚本按文件而非实例注入 | 动态值通过实例标记/数据传递；按目标主题机制初始化每个实例 |
| OFF-GUIDE-01 [性能实践](https://shopify.dev/docs/storefronts/themes/best-practices/performance) | 减少不必要代码与资源，按真实加载和执行成本优化 | 复用组件、保留脚本依赖和首屏资源时序；拆分或减少告警不等于提速 |

检查目录未列出通用行数限制。不要直接从旧报告或配置示例复制 `TemplateLength` / `NestedSnippet` 并假定当前 CLI 支持；以实际规则列表为准。

## 3. 项目预算：控制代码过长和嵌套复杂

以下全部为 **PROJ 试行复核线，不是 Shopify 官方默认值或平台限制**。目标主题已有明确预算时优先采用并记录。超过复核线必须检查原因并处理或记录例外，不自动判定功能不合格。

| 编号 | 指标 | v1 复核线 | 计量范围 |
| --- | --- | --- | --- |
| PROJ-LEN-01 | Section / block / layout / Liquid template 主体 | >300 行 | 单文件 Liquid + HTML，排除独立 schema、样式、脚本区域 |
| PROJ-LEN-02 | snippet 主体 | >150 行 | 同上，不因提取后文件变小而忽略调用方与总量 |
| PROJ-LEN-03 | 组件 CSS | >200 行 | 单组件外置文件或内联样式区域；不套用到整站聚合样式 |
| PROJ-LEN-04 | 组件 JS | >200 行 | 单组件外置文件或内联脚本区域；同时复核单个函数是否混合职责 |
| PROJ-CPLX-01 | 单文件 Liquid 复杂度 | >60 | 使用官方规则结果，不自创同名计算公式 |
| PROJ-NEST-01 | Liquid 控制流嵌套 | >5 层 | 使用官方规则结果；本次新增嵌套优先保持在 3 层以内 |
| PROJ-SCHEMA-01 | 配置体量 | 顶层 >40 项触发官方检查；其余按必要性复核 | 另记录 schema 行数和各 block 设置数量，不给 JSON 格式化行数设硬上限 |

### PROJ-LEN-05：一致的行数口径

按主题既有格式化风格统计非空物理行，包含注释；多行语句每行计数。区域分开归属，同一行跨区域无法准确划分时记录统计方法与不确定性。Liquid 文件另记录总行数和 schema 行数，避免只报告“主体很短”掩盖配置膨胀。不要为降低指标改成多语句一行、删除必要说明或压缩 schema。

第三方库、构建压缩产物和页面构建器托管代码不套组件行数预算，应标明来源并检查本次改动及资源成本。不能把本次手写代码标成“生成产物”来豁免。

### PROJ-STRUCT-01：拆分依据

先识别重复逻辑、独立子组件和不必要配置。Section 组织配置与内容；snippet 承担有清晰输入和渲染职责的片段；CSS/JS 沿用主题现有组织方式。只有职责、复用或加载收益明确时才拆分。

不要统一要求 CSS/JS 全部外置。原生 stylesheet 的作用域、动态 Liquid 样式、共享资源、首屏样式时序和实例初始化可能需要不同方案。提取到新文件后检查调用方、资源引用与作用域。

禁止生成仅为降低分数的 `part-1` / `part-2` 片段链、无职责的薄包装，以及每个小 HTML 标签一个 snippet。在汇总中同时观察文件数量、总代码量和新增调用关系，避免把复杂度转移隐藏。

### PROJ-STRUCT-02：简化条件的语义边界

只有确认求值、作用域和输出等价时才合并条件。Liquid 的条件表达式按其语义处理；不要套用 JavaScript 的括号、三元运算、赋值比较表达式或任意 `return` 写法。

以下是可合并的简单条件示例，前提是内部只有该输出，没有 else、赋值或循环副作用：

```liquid
{% if section.settings.show_title %}
  {% if section.settings.title != blank %}
    <h2>{{ section.settings.title | escape }}</h2>
  {% endif %}
{% endif %}
```

```liquid
{% if section.settings.show_title and section.settings.title != blank %}
  <h2>{{ section.settings.title | escape }}</h2>
{% endif %}
```

合并后嵌套变浅不代表复杂度一定下降。复杂的 and/or 混合判断需要逐项验证，不能仅为数字达标重写。

## 4. 项目约定：减少重复代码

| 编号 | 触发场景 | 处理要求 |
| --- | --- | --- |
| PROJ-DUP-01 | 准备新增卡片、媒体、按钮、弹层、轮播等组件 | 先查已有实现及调用方，确认接口和样式可用后复用 |
| PROJ-DUP-02 | 同一职责、相同语义的连续片段约 20 个非空行，出现至少 2 次 | 作为人工复核线，比较参数差异与状态；优先数据驱动循环、复用函数或 snippet |
| PROJ-DUP-03 | 桌面和移动端复制整套内容/交互 | 优先共用语义结构与响应式样式；不同资源、顺序或可访问性确有要求时允许保留并说明 |
| PROJ-DUP-04 | 相同组件在页面出现多次 | 初始化按实例作用域执行，防止重复事件绑定；卸载清理监听器、观察器和计时器，验证重新加载 |
| PROJ-DUP-05 | CSS 出现相似或重复声明 | 核对选择器、层叠顺序、断点和浏览器回退；不能全局按字符串相等删声明 |
| PROJ-DUP-06 | 多个位置重复输出脚本/样式资源 | 核对主题已有加载归属，避免重复注册或执行；不能假设浏览器缓存会消除重复执行 |

20 行 / 2 次只是项目复核线，v1 没有重复率自动判定器。相似外观不证明语义相同；少量稳定重复可比引入大量布尔参数的通用组件更清楚。JSON schema 中必要的重复结构不强行抽成 Liquid。

复用 snippet 时显式表达所需的局部数据，例如在已有 `product-card` 且接口匹配的主题里：

```liquid
{% render 'product-card', card_product: product, show_vendor: section.settings.show_vendor %}
```

不得凭此示例假定目标主题必有该 snippet 或参数。优先适配现有接口；新增时同时交付依赖，并检查空数据、转义、ID 唯一性和调用作用域。

## 5. 生成与验收流程

### 生成前

- 确认实际主题、目标文件、任务范围和当前配置。新增能力先列文件职责与复用点；局部修复不要求长篇设计。
- 对修改已有主题的任务，保留相同配置和工具版本的检查基线，区分历史问题和本次引入的问题。
- 只新增需求必要的 schema 设置；已有 setting ID、block 类型和持久化配置不得仅为减行随意迁移或删除。

### 生成后

1. 对实际候选执行长度、嵌套、复杂度和重复片段复核；结构预算超限记录原因和处理。
2. 在完整主题上下文运行 Theme Check。孤立文件缺少 snippet、asset、翻译等依赖时，不将其结果当完整主题验收。
3. 修复本次引入的 error；新增 warning 逐项处理或记录理由。历史告警不要求本任务全部清零，本次导致的恶化必须单列。
4. 按影响验证空/有数据、相关配置、移动/桌面布局，以及多实例和编辑器重载（涉及交互时）。没有可用预览时明确这些项目未测。
5. 本次修改修复并复核后结束；仍无法消除的告警附具体证据与剩余风险，不通过反复放宽预算或禁用规则制造通过。

### 官方检查命令

先检查本机版本和已启用规则。以下绝对路径是使用者需要替换的示例；输出目录应事先创建，并位于主题之外：

```sh
shopify version
shopify theme check --path /absolute/theme --version
shopify theme check --path /absolute/theme --list
shopify theme check --path /absolute/theme --print
shopify theme check --path /absolute/theme --output json --fail-level error > /absolute/run/theme-check.json
```

命令依据：[官方 CLI](https://shopify.dev/docs/api/shopify-cli/theme/theme-check)。记录原始退出码、stderr、版本、生效配置和扫描范围；不能把检查失败或空输出当通过。默认 error 门禁不会阻止所有 warning，因此退出码 0 后仍需复核 warning 和项目预算。检查能力不足时标明“未检查”，不要静默删掉不支持的规则。

配置模板见 [assets/theme-check.yml](assets/theme-check.yml)。按[官方配置说明](https://shopify.dev/docs/storefronts/themes/tools/theme-check/configuration)与目标主题配置合并，保留既有规则、ignore 和扩展关系，并检查它们是否意外排除了新代码。若使用 `--config`，它会覆盖默认配置选择，不代表自动合并。

禁止通过新增全文件 `theme-check-disable`、全目录 ignore 或提高阈值掩盖本次问题。确有工具误报时保留原告警和兼容性证据；必要的局部抑制需说明范围与理由。

### 可选：接入 shopify-perf-toolkit

在工具包目录调用，替换为实际绝对路径：

```sh
node scripts/perfkit.mjs precheck --project /absolute/theme --config /absolute/theme-code-generation/assets/precheck.json --out /absolute/run/precheck.json
```

此预检只运行复杂度和嵌套，不继承主题 `.theme-check.yml`。默认本技能配置为 60/5；若目标主题另有预算，需同步传入，不能以工具包默认 120/10 的通过代替。预检输出 0 表示两规则完整无告警，3 表示待复核；并不代表完整规范通过。

完整 Theme Check 报告可通过 `checks.input` 或 `import-check` 接入工具包；可比基线还需按该工具的扫描契约保存配置、版本、范围和源码哈希。

性能工具包内的候选仍遵循原本 plan → apply → verify 流程。新建 snippet 等超出 `plan-site` 支持范围的工作应使用已授权的正常文件编辑并验证，不伪装成 `create-asset`。性能任务继续执行其原有实测验收；本规范没有修改评分门槛。

## 6. 交付记录与例外

用简短表格记录本次相关指标，不要求为小改动生成庞大报告：

| 文件 | 主体 / CSS / JS / schema 行数 | 复杂度 / 嵌套 | 重复候选与处理 | 例外或未测项 |
| --- | --- | --- | --- | --- |
| 实际变更路径 | 实测值；不适用标 N/A | 官方值；未运行标未测 | 复用对象、保留依据或无发现 | 具体原因与验证范围 |

超限例外至少包含：规则编号、文件及范围、实际值、为什么当前结构更合适、已验证项目。遵循目标项目既有例外审批方式；普通结构判断由已获授权的操作者完成，不凭本规范额外要求用户逐项批准。

分别报告：官方检查完成情况、本次新增 error/warning、项目预算复核、功能验证、性能是否实测。不能把“检查器通过”“行数下降”“告警减少”写成“页面已提速”。

## 7. 维护

CLI 或规则版本变化时复核本文件链接、默认值和模板；不要无依据把更高阈值当作修复。新旧报告版本或配置不同，应重新建立可比基线。

试行后用真实生成样本校准预算，优先检查是否减少无意义复制、职责混杂与修改成本，而非只看文件长度。调整时保留官方默认值与项目选择的区别。
