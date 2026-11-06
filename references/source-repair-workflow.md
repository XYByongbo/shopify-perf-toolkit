# 源码 SEO 修复与自定义性能实现（0.17.0）

## SEO：以主题代码为输入完成真实修改

源代码流程不需要 URL、浏览器、Python 或评分基线。先安装包内依赖，读取目标主题指令及 `theme-code-generation/SKILL.md`。只读请求用 audit-source；修复请求执行下面的写入流程。保存 HTML 的审查保持兼容，但不参与源码修复验收。

```sh
node scripts/seokit.mjs plan --project /absolute/theme --out /absolute/task/plan.json
node scripts/seokit.mjs apply --project /absolute/theme --plan /absolute/task/plan.json --out /absolute/task/apply.json
node scripts/seokit.mjs verify --project /absolute/theme --plan /absolute/task/plan.json --out /absolute/task/verification.json
node scripts/seokit.mjs rollback --project /absolute/theme --plan /absolute/task/plan.json --out /absolute/task/rollback.json
```

明确请求修复时，`fix --project /absolute/theme --out /absolute/task/new-fix` 合并计划、写入及复核，验证失败会尝试还原。每次输出必须为工具与主题目录外的新路径。独立 apply 仅表示写入完成，必须再 verify。源码改动导致冲突时保留现场和 receipt，不覆盖别人改动。

自动候选覆盖缺失 title、description、canonical、html lang、基础 og:title，以及空 title/description、明显无效 canonical href；使用 Shopify 对象。不会凭空生成产品描述、图片语义、评分或结构化数据。缺失数据、动态输出是否真实有效仍保留观察。

自动处理后仍有问题时，Codex 继续阅读被定位文件、引用关系和已有数据，编写完整候选，以 JSON 的 `--config` 交回 plan/fix：

```json
{
  "schemaVersion": 1,
  "summary": "绑定主题已有的产品图片替代文本，保留图片和业务内容",
  "targets": [{"file": "snippets/product-media.liquid", "ruleId": "Q-ALT"}],
  "changes": [{"target": "snippets/product-media.liquid", "replacementText": "这里填写该文件的完整修改后源码"}]
}
```

每个目标必须来自本次审查。候选先在临时副本验证：全部选定问题消失、没有新增规则问题、覆盖完整，才生成 ready 计划。写入前重新核对源码和规则；写入后重建前态复核，不信任计划中自报的修复数量。按所选规则对比 AST：只允许相应元数据、alt、href、lang、静态 JSON-LD 修改；保留 schema、店铺占位符及其条件上下文、正文、资源地址、HTML 和 Liquid 原生脚本/样式。不能用变成未知动态 JSON-LD 的方式抵消解析错误。其他业务改写需单独完成并验证，不夹带在 SEO 补丁中。只接受现有 Liquid 文件，不改商家配置或线上主题。

`source-fix-verified` 只证明当前规则下选定源码问题已修复，及候选 Liquid 可解析；不证明动态值非空、模板每条分支、业务功能、线上抓取、索引或排名。`partially-repaired` 会列出剩余问题，不能当作全部完成。缺少可确定的业务数据时应说明具体缺项，不虚构文本。无 layout、动态/丢失 snippet 或覆盖截断会阻止写入，先解决覆盖问题。

## 性能：从瓶颈到自定义代码，再用实际分数决定保留

内置策略不够时，继续编写适合当前主题的实现。CLI 不调用模型；Codex 负责分析请求中的源码并产生候选，CLI 负责来源绑定、生成计划和执行验证。

1. 按现有 improve start/refresh 建立实测基线与源码绑定诊断，从 recovery.json 选择候选。
2. `request-implementation --previous /absolute/step/session.json --candidate <candidateId> --out /absolute/task/request.json` 导出瓶颈、当前源文件、目标及历史失败。需要关联文件时加 `--files /absolute/paths.json`，值为相对主题路径数组。
3. 按主题代码规范改写请求中的源码，提交候选 JSON。使用新的 `custom/<机制名>`，说明因果机制和受影响功能检查，不重复已失败实现。
4. `plan-custom --request /absolute/task/request.json --candidate /absolute/task/candidate.json --out /absolute/task/plan.json` 生成完整 diff，检查代码、内容、画面和验证范围。
5. 使用下方 prepare 配置接回原会话，再依次 apply → 同步已授权预览 → experiment → collect/verify。应用需要该会话生成的精确 planHash。外部计划的 UUID/hash 不能代替新会话计划。

候选格式：

```json
{
  "schemaVersion": 1,
  "requestHash": "请求文件中的 requestHash",
  "method": "custom/cache-repeated-work",
  "rationale": "复用同一输入的重复计算，保留原输出和失效时机",
  "checks": ["变体切换后的价格、库存和加购结果一致"],
  "changes": [{"target": "assets/product.js", "replacementText": "该文件完整修改后源码"}]
}
```

`checks` 是待执行检查，不是通过证明。替换仅允许请求携带的文件；新增 JS/CSS 资源可加 `kind: "create-asset"`，仍经原创建路径、所有权与回滚检查。Liquid、JS、CSS 候选分别解析；动态编译及业务语义仍须预览验证。单次最多 20 个改动，每文件不超过 2 MiB。请求可携带主文件及最多 20 个关联文件，序列化总量上限 32 MiB；商家配置可作为只读上下文，不能作为修改目标。App、隐藏 DOM、Section 请求、Liquid 查询等专项需要原有行为契约：每个 change 可携带 evidence，但候选/源码/页面绑定由请求覆盖锁定。缺少原契约时 plan-custom 即拒绝，使用 plan-domain 或补齐真实专项证据，不通过改名绕过门禁。

prepare 配置：

```json
{
  "schemaVersion": 1,
  "action": "prepare",
  "previous": "/absolute/step/session.json",
  "candidateId": "请求中的 candidateId",
  "method": "custom/cache-repeated-work",
  "rationale": "与候选文件相同的说明",
  "implementation": {"request": "/absolute/task/request.json", "candidate": "/absolute/task/candidate.json"}
}
```

原 `recipe` / `plan` 入口继续支持。`implementation` 只用于 improve prepare；improve-cycle 使用 plan-custom 产物作为 prepare.plan（cycle 会刷新诊断，因此不能使用绑定旧 session 的 implementation）。improve-cycle 无可选实现时保留原状态，并输出 nextAction 指向当前会话和可用候选；Codex 按该请求生成新的实现后继续。无实测来源、无收益空间或预算耗尽仍不可强行宣称完成。

无收益/回归沿用原回滚；有探索收益进入正式采样。正式检查仍核对所有样本、部署、关键指标、功能与内容视觉。分数目标保持原值；不能靠减少测量样本、隐藏页面内容、屏蔽业务或修改报告获得通过。未提供真实主题与预览 URL 时只验证工具流程，不报告店铺提分结果。

## 0.17.0 复审验证

共享写入器读取只读依赖的原始字节指纹，支持受保护的商家配置及二进制资源；这些文件仍不能被 SEO 修改。源码复核结束后再次扫描真实目录，避免临时副本复核期间的修改被遗漏。磁盘/回执写入失败不会阻止修复流程尝试还原；冲突保留外部修改，并返回失败及存储问题。

自定义计划走旧 plan 入口时，方法名、候选和源码身份仍必须匹配；重新计算计划哈希不能跳过语法检查。专项方法写入历史，custom 命名不能重置已失败的专项机制。模板必须保留 content_for_layout。

开发验证：`node --test tests/seo-repair.test.mjs tests/custom-implementation.test.mjs`；`node scripts/validate_improvement_pipeline.mjs --custom` 使用隔离主题和真实 Chrome/Lighthouse 检查负对照回滚、正候选实测以及进入正式验收。正式接受/拒绝/缺证据使用固定合成样本回归验证，不能写成真实店铺或线上 SEO 结果。
