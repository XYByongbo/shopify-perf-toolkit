# 可执行代码优化策略

这些策略读取真实 JS、CSS、Liquid 源码，生成可审阅的修改，接入已有 plan-site → apply → rollback。不是仅生成建议，也不自动上传或发布主题。结构匹配只证明可生成候选，不能证明它是瓶颈或会提高分数。

在工具目录执行 npm ci --ignore-scripts，安装锁定的 Acorn/PostCSS 与 Shopify Liquid HTML 解析器；LiquidJS 仅用于工具回归测试。不要把依赖装到主题中。

## 调用流程

准备主题代码候选前读取 [主题代码生成技能](../theme-code-generation/SKILL.md)。生成计划后复核候选的长度、复杂度、嵌套与重复逻辑；采用该技能预算时，显式同步 precheck 与完整 Theme Check 的阈值。此步骤是操作者工作流，策略 CLI 不会自动加载 Markdown 或执行全部项目预算检查。

```sh
node scripts/perfkit.mjs code-strategies --out /absolute/run/strategies.json
node scripts/perfkit.mjs analyze-code --project /absolute/theme --target assets/main.js --out /absolute/run/code.json
node scripts/perfkit.mjs plan-site --project /absolute/theme --recipe /absolute/run/recipe.json --out /absolute/run/plan.json
node scripts/perfkit.mjs apply --project /absolute/theme --plan /absolute/run/plan.json --out /absolute/run/apply.json
# 发生回归时使用原计划；当前文件已漂移则拒绝覆盖
node scripts/perfkit.mjs rollback --project /absolute/theme --plan /absolute/run/plan.json --out /absolute/run/rollback.json
```

所有输出路径必须尚不存在。analyze-code 只分析一个指定文件，不联网、不下载素材、不写主题。结果包含 sourceHash、候选位置、拒绝原因以及未填写的 recipe。将确认要做的候选放入 schemaVersion:1、changes 数组，并填写 reason 和 evidence；分析器不会自动把审阅标志填为 true。

参考 [原四种策略的 recipe 格式](../assets/examples/code-strategies.json)。示例的哈希是占位符、审阅标志为 false，不能直接应用。registrationStart 和 loopStart 是当前源码的 UTF-16 字符偏移，应复制分析结果，不能使用行号或字节偏移。源码变化后重新分析。

## 支持范围

当前通用策略共 19 项。P0 的 `liquid-image-tag-loading`、`liquid-picture-pair`、`liquid-hoist-head-resource`、`liquid-cache-metafield`、`css-lcp-reveal` 见 [P0 策略](shopify-performance-rules.md#五项新增补丁策略)。P1 新增 `liquid-dedupe-resource-hint`、`liquid-critical-css-sync`、`js-passive-listener`、`css-transition-properties`，详见 [P1 检查与优化](shopify-performance-rules.md#p1-检查与优化)。运行事实不能由源码推断，这些规则的待审任务放在 `analyze-code.reviewTasks`，与结构可转换的 `candidates` 分开；待填 recipe 不等于已通过结构或运行验证。

| kind | 实际修改 | 参数与必要审阅 |
| --- | --- | --- |
| js-raf-listener | 把 window scroll/resize 回调合并到每动画帧一次；匹配的 removeEventListener 同步更换回调并取消待执行帧 | registrationStart；timingChangeReviewed、listenerLifecycleOwned、handlerReadsLatestState |
| css-dedupe-declarations | 删除同一规则内相邻、内容完全相同的普通声明，保留最后一条 | parameters:{}；cssomIndependent |
| css-offscreen-rendering | 给选定屏外区块添加 content-visibility:auto 和 contain-intrinsic-block-size:auto Npx | selector、intrinsicBlockSize；offscreen、nonLcp、containmentReviewed |
| liquid-limit-guarded-loop | 把完整的 for/if forloop.index <= N 输出限制改为 for limit:N，减少不输出内容的循环 | loopStart；loopScopeReviewed |

每项还必须提供当前文件 sourceHash、非空 evidence.summary 和 reason。布尔证据由实际代码与页面检查得出，不能为了通过校验一律填 true。

### JS

使用 AST 定位一个顶层注册语句及本文件同步、零参数函数声明。拒绝回调别名、直接调用、多处注册、重赋值、同名绑定、事件参数、this/arguments/event 依赖，以及 once、signal、非默认 capture 等模式。支持默认参数、false 或 {passive:true}。匹配卸载语句时同时取消待执行帧，帧 ID 为 0 也能处理。

合帧会改变执行时间与次数；仅适用于读取最新状态的视觉更新。计数、每事件业务逻辑和必须同步完成的处理不适用。检查首个事件、多次事件、卸载、重新加载及其他脚本是否引用该回调。不能给全站脚本统一套 defer 或 RAF。

### CSS

去重只处理相邻且序列化内容完全相同的普通声明；保留不同值的回退声明、注释隔开的声明、自定义属性和规则顺序。若业务依赖 CSSOM 枚举结果，不能使用此策略。字节减少不等于分数提高。

屏外渲染只接受唯一顶层平坦规则中的单个类选择器，且规则必须已有一条 display:flow-root，拒绝已有 containment 或 position 声明。必须通过页面证据确认目标在首屏外、不是 LCP，并测得占位高度。分析器不会仅凭 CSS 自动建议这项改动。

源代码条件不能证明最终计算样式：其他规则、断点、内联样式仍可能覆盖 display。必须复验实际 display、外边距折叠、内容高度、滚动、聚焦、页内搜索、定位子元素与 CLS。初次浏览器测试发现普通区块会因外边距折叠变化产生偏移，因此策略收紧为已有布局边界的区块。

### Liquid

仅转换下面这种四个边界标签都双向裁剪空白的结构：

```liquid
{%- for product in collection.products -%}
  {%- if forloop.index <= 8 -%}
    <h3>{{ product.title | escape }}</h3>
  {%- endif -%}
{%- endfor -%}
```

生成 limit:8 循环并保留正文；N 限定 1..50、集合使用简单变量路径。正文允许输出表达式，拒绝嵌套标签、else、assign、render 等副作用，以及已有循环选项。forloop 只允许 index/index0/first；length/last/rindex 等依赖完整集合的值拒绝转换。raw/comment/schema/javascript/stylesheet/doc 中的文本不会作为候选。

仍需审阅循环变量在周围代码中的使用，并比较空、短、长集合的输出。工具的 LiquidJS 测试覆盖受支持子集，不能替代 Shopify 预览回归。

## 计划与验证

生成计划带有原文、修改后全文、diff、指纹和 verificationRequired。apply/rollback 会依据原文、参数和证据重新运行生成器，校验生成结果；仅修改 after 再重新计算哈希不能绕过它。哈希和布尔标志不是语义安全证明。

同文件只允许一个 change；需要合并多种策略或不满足边界时，审阅组合结果并使用原有 reviewed-replacement。原图片策略、报告导入、外链/脚本依赖、batch、预算和正式评分门槛保持兼容。

先验证受影响功能，再同步预览做小样本探索；有实测收益后按原标准做正式验收。本地测试成功、合帧次数减少或文件变小，都不能写成真实店铺分数已提高。

工具维护者可运行 npm test、npm run test:lighthouse，以及配置 Playwright/Chrome 后运行 scripts/validate_code_strategies_browser.mjs --out 新目录。浏览器脚本使用本地合成 HTML、阻止外网请求，检查 390/1440px 的 CSS 内容/几何/聚焦与 JS 事件合帧和卸载。它不运行店铺 Lighthouse。

设计依据：[CSS containment 规范](https://www.w3.org/TR/css-contain-2/#content-visibility)、[Shopify for 标签](https://shopify.dev/docs/api/liquid/tags/for)。

## 0.9.0 新增执行策略

以下六项也通过 plan-site → apply → rollback 执行；完整参数和必需证据以 code-strategies 输出为准。

| kind | 修改 | 参数 |
| --- | --- | --- |
| js-idle-init | 延迟已审阅的非关键顶层初始化调用 | statementStart、timeoutMs（1..5000） |
| liquid-defer-script | 对明确无内联依赖的外部经典脚本添加 defer | tagStart |
| liquid-scope-resource | 按 request.page_type 限定组件 JS/CSS 加载 | tagStart、pageTypes |
| css-font-display | 给唯一字体 face 设置 swap/optional | family、display |
| css-font-fallback | 新增实测 fallback 字体并接入所选字体列表 | selector、family、local、sizeAdjust、ascentOverride、descentOverride、lineGapOverride |
| liquid-cache-loop-filter | 在 forloop.first 计算纯循环不变量，后续迭代复用 | assignStart |

Liquid 使用 Shopify 官方 parser 定位。循环缓存拒绝局部循环变量输入、动态 lookup、写入依赖、共享作用域及 break/continue；空集合不新增赋值，保留现有变量。字体 fallback 定义须在相应 font-family 栈里实际引用（同文件组合改动用 reviewed-replacement），不能只增加无用 CSS。

任意单体脚本、动态 Liquid、特殊 CSS 级联不自动重写。CSS 拆分和组件 activate/destroy 加载器见 [执行引擎](performance-engine.md)，这些计划同样需要多页面/断点/状态及首个交互证据。
