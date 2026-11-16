# 代码与实测收益引擎

0.10.0 提分任务优先走 [源码归因、按需加载与单补丁实验](demand-engine.md)，下述原有策略和正式验收继续适用。

先按 [新旧验收策略](standards-upgrade.md#两种正式验收策略) 确定目标和口径，再定位影响目标的成本、追到代码、形成补丁、验证收益。省略 acceptancePolicy 保留原分数流程；显式 standards-v1 使用指标及规范证据验收。文件变小、告警变少、报告生成成功都不是性能收益证据。所有项目输出放到工具目录之外的新任务目录。

## 接入能力

| 能力 | 入口 | 实际行为 |
| --- | --- | --- |
| 调用栈、网络发起链、JS/CSS 覆盖率 | profile-runtime | 独立 Chrome；保存 CPU profile、trace、V8 函数/分支覆盖和 CSS 使用范围。保存 JS/CSS 响应哈希，不保存媒体响应正文或截图。 |
| 官方 LCP insights | profile-devtools | 固定版 Chrome DevTools MCP + SDK；独立浏览器、冷加载 trace、LCPBreakdown/DocumentLatency/RenderBlocking/LCPDiscovery。文件访问限定本次输出目录，关闭工具遥测和 CrUX 查询。 |
| 官方 LCP skill | [debug-optimize-lcp](../integrations/skills/debug-optimize-lcp/SKILL.md) | 固定上游提交，含来源与许可证。由本工具 skill 路由，不修改全局 MCP 配置。建议须结合主题约束，不能自动触发素材下载。 |
| Liquid 服务端热点 | profile-liquid | 执行 Shopify theme profile --json，或导入 Speedscope；输出 self/inclusive 时间、文件、行号。登录不可用明确失败。 |
| Shopify 官方 Liquid HTML parser | analyze-code / plan-site / plan-split | 使用 AST 源码位置处理 HTML/Liquid；Acorn 处理 JS，PostCSS 处理 CSS。解析失败或不满足边界拒绝生成。 |
| 代码拆分 | plan-split | 首屏/非首屏 CSS 拆分；具备 activate/destroy 契约的组件按首次点击加载；新文件一起应用、回滚。 |
| 候选身份 | measure.deployment | 指定远端主题仅拉取 Liquid/JS/CSS/JSON 到临时目录比哈希，核对各页 Shopify.theme.id 与 Shopify.shop；随后清理临时源码。不拉图片、不覆盖本地主题、不推送。 |
| 性能验收 | verify-gain / verify-optimization / optimize | verify-gain 检查收益；完整验收按所选策略检查目标收益、关键指标无实质退步、候选身份、功能回归、内容视觉及适用的规范证据。 |

在工具目录执行 `npm ci --ignore-scripts`。使用已有 Chrome，可设 PERF_KIT_BROWSER_EXECUTABLE；使用已有 Shopify CLI 登录，可设 PERF_KIT_SHOPIFY_CLI。浏览器正常请求网页资源，但不额外下载图片原件。限写采集不能证明真实加购、支付或统计成功。

## 浏览器诊断

```json
{
  "schemaVersion": 1,
  "url": "https://example.myshopify.com/?preview_theme_id=123",
  "project": "/absolute/theme",
  "device": "mobile",
  "state": "menu-open",
  "settleMs": 1500,
  "timeoutMs": 45000,
  "readOnly": true,
  "expectedThemeId": "123",
  "actions": [{"type": "click", "selector": "button[data-menu]"}]
}
```

actions 支持 click/hover/focus（selector）、scroll（y）、wait（ms，最多 5000），最多 30 个动作、120 秒。各模板、设备、菜单/变体/购物车状态分开采集；一次记录没用到不等于全站没用到。

```sh
node scripts/perfkit.mjs profile-runtime --config /absolute/run/runtime.json --out /absolute/run/runtime-mobile
node scripts/perfkit.mjs profile-devtools --config /absolute/run/devtools.json --out /absolute/run/devtools
```

DevTools 配置仅接受 schemaVersion、url、device（可选 mobile/desktop）、timeoutMs。runtime 输出 trace.json、cpu.cpuprofile、profile.json。插桩时间不能代替正式 Lighthouse；覆盖率以 UTF-16 偏移记录，另算 UTF-8 字节。缺失源码、跨域 TAO 不可见时间保留 unavailable/null。

`audit-site --runtime profile.json` 关联真实响应到源码。JS/CSS 支持正文或完整 AST 结构核验并映射位置，静态内联脚本按唯一正文/AST 关联到 Liquid。CSS 覆盖率在结构相同的前提下保守映射到本地整条规则。不能凭同名或 CDN 域名猜测。变量改名、复杂 CDN 改写、动态 Liquid 输出和重复内联片段仍可能无法关联。cpu/cpu.cpuprofile 为导航到首次 settle；interactionCpu/interaction-cpu.cpuprofile 为之后的交互阶段，不将点击后的 CPU 冒充首屏 TBT。

## Liquid 分析

导入配置：`{"schemaVersion":1,"project":"/absolute/theme","input":"/absolute/run/liquid.speedscope.json"}`。

在线配置：`{"schemaVersion":1,"project":"/absolute/theme","store":"example.myshopify.com","themeId":"123","urlPath":"/products/example","timeoutMs":60000}`。

```sh
node scripts/perfkit.mjs profile-liquid --config /absolute/run/liquid.json --out /absolute/run/liquid-profile.json
```

支持 evented、带 weights 的 sampled Speedscope，正确换算时间单位。父级 inclusive 包含子级，不相加。优先检查高 self time 的 lookup/filter、产品/变体循环和嵌套 render。文件/行号匹配是候选，导入旧 profile 仍须核验远端版本。Liquid 时间、TTFB、LCP 分开报告，不直接承诺提分。

## 执行策略与拆分

`code-strategies` 提供十九项策略及参数、证据要求，见 [策略说明](code-strategies.md)。原十项策略保留，另有五项 P0 和四项 P1 [Shopify 性能策略](shopify-performance-rules.md)，覆盖图片、head、metafield、LCP 显示，以及重复资源提示、关键 CSS 同步、passive 输入监听器和过渡属性收窄。

`plan-split --project ... --config ... --out ...` 接受 schemaVersion、mode、source、newAsset、loaderTarget、tagStart、reason、evidence：

- mode:css：source 为现有 CSS，newAsset 为新 assets/*.css，tagStart 精确选中 asset_url 样式链接；criticalRuleStarts 选择 PostCSS 顶层节点。保留首屏样式，其余移新文件，生成延后链接和 noscript 回退。拒绝 @import/@layer/@namespace/@charset 及特殊加载属性；需实证确认多状态覆盖、级联与 CSP。
- mode:interaction：source 模块导出 activate(root, {event, trigger, signal}) 和 destroy(root)，newAsset 为新 JS；rootSelector/triggerSelector 定位组件按钮。保留第一次原始事件，串行处理后续点击，重复初始化去重，支持 Shopify section load/unload。只接管 button type=button，不伪造点击、不拦表单。任意旧单体 JS 须先按契约重构，不能声称自动拆解所有依赖。

evidence 包含当前 sourceHash、loaderHash、summary、dependencyReview/allStatesCovered/cascadeAndOrderReviewed；CSS 另需 inlineLoadHandlerAllowed，interaction 另需 activationContractReviewed。审阅标志来自实际检查，不能为过校验自动填 true。

新文件 recipe kind:create-asset 只接受直接 assets/*.js、*.mjs、*.css，先解析，再整批预检。已有同名文件一律拒绝，包含相同内容，因此这类计划不能重复 apply。rollback 仅删除与计划内容完全一致的新文件；漂移则拒绝。逐文件原子写入和失败恢复不等于跨文件事务。

## 分阶段执行

1. measure 收集正式基线，配置加 `deployment:{"project":"/absolute/theme","store":"example.myshopify.com","themeId":"123","timeoutMs":120000}`。测量前后核验身份；不通过则不采样或无法完成验收。
2. batch 可配置 runtimeProfiles（最多 12 个状态配置）、liquidProfile、devtoolsProfile、recipe，串行产出诊断与待审补丁；探索样本也进入 audit-site。原 checks/resources/quality/验收保留。
3. optimize prepare 配置 schemaVersion/action:"prepare"/project/recipe，生成 plan.json。审阅完整 diff。
4. optimize apply 配置 action:"apply"/project/plan（绝对路径）/reviewedPlanHash，按计划改本地，输出 awaiting-preview-sync。哈希绑定计划，不是批准签名。随后同步到未发布预览；工具不 push/publish。
5. optimize verify 配置 action:"verify"/project/plan/reviewedPlanHash/before/measurement/scenarios/review。measurement 为带 deployment 的正式配置；scenarios 覆盖每个测量 URL、mobile/desktop 命名视口和断言。先 3 次探索，有收益才正式 5–10 次；exploreFirst:false 可直接正式测量。
6. review 包含 sourceHash/contentPreserved/visualsPreserved/summary，须有实际内容视觉证据。可显式 rollbackOnFailure:true 在失败或无收益后回滚本地；远端仍须单独同步。

verify-optimization 直接验证已有数据：before、after、expectedSourceHash、regression（optimization-regression 对象）、review、可选 plan。缺项即不接受。未核验的历史基线不能补签身份，必须真实重测。

`plan/regression/review` 是已读取的 JSON 对象。完整 `regression` 包含 `kind:"optimization-regression"`、候选 `sourceHash`、原始 `scenarios` 结果对象和回归结束后取得的完整 `remote` 部署核验对象。单独运行 scenarios 时，配置需包含候选 `project`、`expectedThemeId` 及完整声明矩阵；使用 optimize verify 时自动绑定这两项，显式冲突会在采样前拒绝。旧回归记录缺少源码稳定性、店铺/主题、文档稳定性和 finishedAt 时重新采集，不补签时间或通过标志。

可先运行自动验证并保存 `not-accepted`，审阅内容/视觉后用 verify-optimization 复核已有证据，无需重复 Lighthouse；完整流程和本轮拒绝测试见 [架构端到端验证](architecture-e2e.md)。

## 判定收益

两种策略的正式验收都要求每组前后各至少 5 次。旧流程保留移动每次最低 75/中位 80、桌面 85/90；standards-v1 不以分数门槛或分数退步决定正式通过，但保留具体指标保护。verify-site 与独立 score-target 仍执行原评分契约，不能代替 verify-optimization。

verify-gain 至少 3 次独立样本、同引擎/版本/配置/页面设备矩阵。默认分数改善至少 3 分；LCP/TBT/CLS/FCP/SI 退步阈值为 200ms/50ms/0.02/100ms/200ms，分别与前后 MAD 的 3 倍取大值。任一组实质退步都拦截，完整保留原始分布。MAD 是决策噪声带，不是统计显著性或因果证明。

优先级先看 LHR 指标权重和丢分，再按 metricSavings 与匹配版本的非线性评分曲线估算收益；缺数据保持 unknown。多个机会有重叠，不相加；SEO 告警和文件字节量不直接当分数损失。

## 回归与依据

npm test、npm run test:lighthouse 验证离线与协议；npm run test:browser 用临时本地页面验证 Chrome 覆盖率/CPU/请求映射、首次点击和编辑器生命周期、官方 MCP。这些证明工具能力，不证明 outdoor 已提分。

依据：[Shopify 性能](https://shopify.dev/docs/storefronts/themes/best-practices/performance)、[Liquid profiler](https://shopify.dev/docs/api/shopify-cli/theme/theme-profile)、[Theme Inspector](https://shopify.dev/docs/storefronts/themes/tools/theme-inspector/using-the-theme-inspector)、[Lighthouse 评分](https://developer.chrome.com/docs/lighthouse/performance/performance-scoring)、[LCP 分段](https://web.dev/articles/optimize-lcp)、[Playwright Coverage](https://playwright.dev/docs/api/class-coverage)、[Shopify parser](https://github.com/Shopify/theme-tools/tree/main/packages/liquid-html-parser)、[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)。
