# 规范对齐第二、三批

本次扩展性能包；不修改 PageOtter 插件仓库、不发布主题。130 条草案仍是参考目录，新增 `standards-v1` 是用户显式选择的工具验收策略，不代表草案已由部门批准。第一批兼容记录见 [基础说明](standards-foundation.md)。

## 两种正式验收策略

省略 `acceptancePolicy` 时，原 score 默认值、分数门槛、收益判定、部署、业务/视觉、回滚及 CLI 退出语义保持原样。

显式使用 `acceptancePolicy: "standards-v1"` 时：

- 必须指定 `goal: {kind: "loading", metric: "lcp"}` 等具体指标，或原有 interaction 目标；不能默认使用 score。
- 分数与原分数门槛仍输出供诊断，但不决定此策略的通过。目标指标必须有超过既有噪声/最小幅度要求的实测改善；其他导航指标不得退步。interaction 仍必须提供独立交互证据。
- 正式每页每设备前后至少五次、环境匹配、源码/部署身份、单补丁实验、功能、内容视觉及已配置资源预算继续有效。不降低现有单补丁探索门禁。
- 必须提供部署绑定的 `regression.integrityProfiles`，检查 LCP 身份、重复请求与初始化；缺少或异常均拒绝。
- 增加 Theme Check 前后差异门禁和按源码改动范围要求的观察记录。必要项目 `NOT RUN` 不能通过。
- `field-follow-up` 在全局改动中明确列为上线后补充的 E3 项，缺失仍显示 `NOT RUN`，但不阻止开发主题的实验室验收。通过不代表真实用户 CWV 达标，也不授权发布。

`policy: "delivery-v1"` 是另一项交付适配器策略，可与 `acceptancePolicy` 同时使用；不互相替代。

`verify-optimization`、`optimize verify`、`improve collect` 和 `improve verify` 均接入新字段。collect 在正式导航前检查规范证据，缺失时不浪费测量预算。improve 第一次正式验证选择的策略会固定在会话中，后续不能换策略绕过失败。缺失证据可以补齐后继续复用已固定的样本。

## Theme Check 使用真实项目配置

```sh
node scripts/perfkit.mjs check-theme --project /absolute/baseline-theme --out /absolute/run/check-before.json
node scripts/perfkit.mjs check-theme --project /absolute/candidate-theme --out /absolute/run/check-after.json
```

该入口依次执行已安装 Shopify CLI 的 version、theme check --version、--list、--print 和 --output json --fail-level error。使用项目的实际 `.theme-check.yml`，不生成替代配置、不启用自动修复。保存原始输出、实际版本/配置、命令日志、源码清单与哈希；执行前后校验源码和配置未变。退出码 0 表示完整且无需复核，3 表示需复核，2 表示执行失败。

`precheck` 的两条结构规则、`check-performance` 的性能子集和 `import-check` 原有行为保持不变。新入口完整执行当前配置；策略要求的规则列表来自 `requiredThemeChecks`。版本不支持、默认未启用而未出现在有效配置中的规则记为未运行；显式禁用记为失败。不要自动升级或关闭规则来消除结果。

例如，体积检查通常需要项目显式启用；部门约定值与实际传输字节是不同口径：

```yaml
AssetSizeCSS:
  enabled: true
  thresholdInBytes: 100000
AssetSizeJavaScript:
  enabled: true
  thresholdInBytes: 10000
```

`standardsEvidence.themeCheck` 为：

```json
{
  "before": {"artifact": "/absolute/run/check-before.json", "sha256": "真实文件SHA256"},
  "after": {"artifact": "/absolute/run/check-after.json", "sha256": "真实文件SHA256"},
  "warningReviews": [{"fingerprint": "新增warning的fingerprint", "reason": "逐项处理或保留理由", "reviewer": "实际审阅人"}]
}
```

保留两份被检查的源码目录，验证时会重新导入原始诊断并核对部署清单、完整覆盖和源码指纹，不信任保存报告里的 PASS/complete。前后版本、配置、严重级别和范围须相同；新增 error 拒绝，新增 warning 必须审阅。原有问题保留在 existing。新增内联禁用不能通过；除 node_modules 外的 ignore 模式会显示覆盖未完成。配置改变应重新建立同口径基线。

## 范围清单和人工记录

`plan-verification --config /absolute/scope.json --out /absolute/plan.json` 接受 `{beforeFiles, afterFiles, scope}`。清单项格式为 `{file, sourceHash}`；可复用 sourceSnapshot / source-graph 的清单。`scope` 可包含 `level` 和显式 `pages`。

按变化文件保守推断最低级别：配置/模板 JSON 为一级，section/block Liquid 为三级，layout、共享 assets、snippets、locales 和无法确定的文件为四级。仅凭哈希不能证明“只改样式”，因此不会把 Liquid 改动自动归为二级；可以提高级别，不能降低。调用方仍须声明所有受影响页面，静态推断不证明覆盖全主题。

二级起要求 375、768、1024、1280、1920 px 五个宽度；三级增加多实例、编辑器生命周期、键盘与减少动态效果；四级增加页面/语言/同意状态矩阵及 E3 后续项。实际需要的清单写在结果中。

`standardsEvidence.checks` 只引用真实记录，不直接接受 `passed: true`：

```json
{"id":"responsive-layout","artifact":"/absolute/run/responsive.json","sha256":"真实文件SHA256"}
```

对应观察文件：

```json
{
  "schemaVersion": 1,
  "kind": "standards-check-observation",
  "checkId": "responsive-layout",
  "sourceHash": "候选源码指纹",
  "evidenceLevel": "E4",
  "status": "PASS",
  "reviewer": "实际审阅人",
  "observedAt": "实际检查的ISO时间",
  "observation": "实际观察、检查步骤和结论；不是待办文字",
  "conditions": {"pages": ["实际页面URL"], "widths": [375,768,1024,1280,1920]}
}
```

每项证据层使用生成清单中的 `evidenceLevel`。人工记录是带哈希、范围和审阅人的观察声明，不是工具独立重放浏览器的证明。只有组件隔离、多实例、编辑器、键盘/动画四项可以有明确理由地声明 N/A；页面输出和响应式检查不能以“不方便执行”为由跳过。业务与原有视觉证据仍需通过原验证器。

## 检测与报告

新增八项 settled DOM 观察，现有性能规则从第一批的 31 项扩到 39 项，映射版本为 2：

| 观察 | 规范编号 | 结论边界 |
| --- | --- | --- |
| 多张高优先级图片 | PERF-IMG-03 | 待确认优先级竞争 |
| sizes 声明与渲染宽度差异大于两倍 | PERF-IMG-08 | 仅明确 px/vw；复杂表达式未运行 |
| 隐藏图片已下载 | PERF-IMG-09、PERF-MOB-01 | 排除已识别轮播候选，仍需业务确认 |
| 图片缺少宽高属性 | PERF-IMG-10 | 需核对 CSS 预留空间，不直接归因 CLS |
| 完全相同的活跃样式表重复引用 | PERF-CSS-04 | 相同 URL/media 的 DOM 重复，不等于重复传输 |
| head 同步外部脚本 | PERF-JS-01 | settled DOM 不能证明原始解析时序 |
| 窄屏文档溢出 | PERF-MOB-03 | 使用布局视口宽度；实测当前状态 |
| 缺少 viewport 声明 | PERF-MOB-06 | 当前 DOM 声明情况 |

不改动原 LCP 背景、弹窗、lazy/high priority 检测。新记录有数量上限，缺失、截断、复杂表达式不会被默认为通过。旧 runtime-profile 继续可读，但不会补造新证据。

HTML 报告先显示“要修、待确认、未测”，再给详细位置和规范编号；已通过和不适用折叠。计数是检查/任务行，不是已覆盖的规范条数。静态候选和外部证据都列为待确认。

## PageOtter 导入契约

```sh
node scripts/perfkit.mjs import-pageotter --input /absolute/handoff.json --project /absolute/theme --baseline /absolute/prior-import.json --out /absolute/import.json
node scripts/perfkit.mjs report --input /absolute/import.json --out /absolute/import.html
```

这是**提议的 handoff v1 接口**。原插件改版方案没有确定 JSON schema，不能声称 PageOtter 0.9.3 已能直接导出；现有插件应按此适配，未知格式会拒绝。示例见 `assets/examples/pageotter-handoff-v1.json`。

输入包括 schemaVersion=1、kind=pageotter-handoff、producer、capturedAt、identity、ruleScope、checks。identity 必须含 URL、themeId、themeRole（live/preview/development）、pageType、language、currency、viewport。每项 check 为 ruleId、subject、status、summary，以及实际执行时的 evidenceLevel（E1/E2/E4）和 evidence（含 observation）；NOT RUN/N/A 必须有 reason。

可选 sourceCandidate 包含 file、confidence（annotated/inferred/user-selected）和 sourceHash，只允许 sections/snippets/blocks 下的单文件 Liquid 候选。即使本地哈希匹配也不证明远端部署，更不会自动修改源码。

所有结果标为外部观察，保留 original/inputHash，不能代替正式验收。对比要求更晚的时间、同页面/主题角色/语言币种/视口/规则范围；只有相同 subject 显式再次 PASS 才列已修复。元素消失、检查关闭、范围变化或 N/A 均不能算修复。选中规则缺失记录会自动列 NOT RUN。

## 索引复用与验收

统一诊断用请求内的源码索引会话复用解析结果，供瓶颈、域候选与样式审计使用。每次读取仍对当前文件内容重新计算指纹；内容变更失效，调用方修改返回对象不污染缓存。缓存最多四个项目、随请求释放，不持久化跨任务的旧源码。

测试入口：`node --test tests/standards-upgrade.test.mjs`；真实浏览器和已安装官方 CLI 分别用 `PERF_KIT_BROWSER_TESTS=1`、`PERF_KIT_THEME_CHECK_TESTS=1` 运行 `tests/standards-browser.test.mjs`。`validate:delivery` 已包含上述实机环节，另外执行全量 Node/Python、原浏览器、交付浏览器、站点及按需加载流水线。发行 ZIP 与 validation.json 的源码指纹须一致。
