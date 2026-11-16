# 从主题整改问题到可执行优化

版本 0.13.0 将 WOLFBOX 整改报告中的资源失效、重复样式、嵌套 render、动态 JS Liquid 和无收益重试问题接入现有工具。静态告警用于发现线索；部署绑定、原始成本、实际补丁、内容交互和独立收益共同决定是否接受。格式告警减少、链接减少、坏图恢复都不能单独证明性能收益。

## 执行顺序

`diagnose-performance` 和 `diagnose-recovery` 的 `workflow` 输出八步状态、源码绑定候选、生成入口及下一步：

1. 固定基线：主题源码哈希、未发布预览、页面与设备、原目标、独立样本。
2. 恢复失效资源：实际浏览器 GET/解码失败，确认原资源内容后生成修复；验收后建立内容正确的新基线。
3. 首屏图片与内容：按 LCP 发现、下载和渲染成本选择图片方法；首屏依赖 Ajax 时用已有 Liquid 输出，保留后续 Section API 更新。
4. CSS 与字体：核对实际使用、级联、断点和交互；重复 snippet 样式成对修改，其他模式走原关键 CSS/字体生成器。
5. JavaScript 与 App：核对生产者和消费者、脚本归属、首次交互及业务响应；支持受限动态 Liquid 资产映射，不能按文件名猜源码。
6. Liquid 与查询：真实 Shopify profile 定位调用路径；纯转发 render 保留隔离作用域，已有输出上限的查询才可裁剪。
7. 隐藏内容：核对真实初始成本、CSP、首次展开、键盘、编辑器和无 JS；必须证明优化控制器确实运行。
8. 独立验收与重诊断：探索收益比较至少每侧 3 次，正式前后按原矩阵每组至少 5 次；单补丁实验保留原门禁，完整验收按 [新旧策略](standards-upgrade.md#两种正式验收策略) 检查。旧流程保留原分数目标，新策略将分数仅作诊断；两种策略的具体指标达到回退门槛均拒绝。

已有方法的完整配置见 [四类优化](domain-optimization.md)、[分页/隐藏内容/Section API](extended-optimization.md)、[按需加载](demand-engine.md) 和 [持久化会话](improvement-workflow.md)。本页说明新增实际能力。

## 重复样式：调用方和 snippet 一起修改

官方依据：[Reduce stylesheet count](https://shopify.dev/docs/storefronts/themes/best-practices/performance/reduce-stylesheet-count)。仅支持一个非嵌套循环内、唯一 id 容器中的一次字面量 render，snippet 开头为 `asset_url | stylesheet_tag`，对应 CSS 资产存在。必须捕获同容器重复样式链接、完整顺序和真实样式重算；与其他样式交错、media 不匹配、load handler、disabled 或采集截断均拒绝生成。

生成 `stylesheet-once`：调用方在循环前初始化局部标记，在**首次实际 render 后**更新；snippet 按传入参数决定输出样式。被条件过滤的第一项不会导致后续卡片缺样式，空循环不输出样式，其他直接调用仍默认输出。保留原 Liquid 空白裁剪行为；不使用全局 URL 去重。

```json
{
  "schemaVersion": 1,
  "candidateId": "诊断中的 stylesheet 候选 ID",
  "method": "stylesheet-once",
  "review": {
    "summary": "填写具体级联、CSSOM、共享调用和状态审阅结果",
    "cascadeAndOrderReviewed": false,
    "cssomIndependent": false,
    "sharedCallersReviewed": false,
    "allStatesReviewed": false
  }
}
```

```sh
node scripts/perfkit.mjs plan-domain --project /absolute/theme --diagnosis /absolute/diagnosis.json --config /absolute/style.json --out /absolute/plan.json
```

示例审阅字段刻意为 false，实际审阅后再填写。计划包含两个文件的 before/after/diff 和未修改 CSS 的哈希依赖。应用前后、测量前后均检查依赖。内容检查仅允许生成器明确证明的容器内重复 LINK 差异；原内容、其他资源、计算样式和布局仍逐项比较。场景必须在指定根容器 checkpoint，并核对初始样式数量由 N 变为 1。

交互目标还要求 profile 中只有一个实际 click/press，匹配原目标的 EventTiming，且该操作窗口有完整样式重算证据。独立 `measure-interactions` / `verify-interactions` 仍是交互收益验收，不能拿初始样式耗时冒充 INP。导航收益不足时也不能自动改目标为交互来通过验收。

## Liquid 转发和带 render 的查询

官方依据：[Avoid nested renders](https://shopify.dev/docs/storefronts/themes/best-practices/performance/avoid-nested-renders)、[render 作用域](https://shopify.dev/docs/api/liquid/tags/render)、[查询分页](https://shopify.dev/docs/storefronts/themes/best-practices/performance/limit-product-queries-with-pagination)。

`liquid-collapse-forwarder` 只绕过完整内容仅为单次 render 的包装 snippet；命名参数逐个原样传递，叶子仍通过 render 调用，保留隔离。带额外文本、赋值、变量重命名、with/for、环境循环元数据等结构不自动改写。需要真实 profile 中包装层与当前调用行的调用关系，不能把任意同名 snippet 热点映射到所有调用方。验收比较调用方/包装/叶子的合计 self time 和整体 render 成本；包装消失不能当作成本归零。

`query-limit-render` 支持完全裁剪空白的 `for … if forloop.index <= N`，N 为 1–50，输出为普通表达式和隔离 render。生成显式 `limit:N`，保持既有输出数量；递归解析并固定字面量 snippet 依赖，拒绝缺失、递归、动态 render、共享作用域及会读取外层完整循环长度的结构。不能把任意 paginate 250 改成 50，也不能删掉分页之外的商品来提分。

两者都走 `plan-domain`，方法名分别为 `liquid-collapse-forwarder` / `query-limit-render`。从 `shopify-methods --format full` 读取审阅合同，不自动填 true。LiquidJS 等价测试只证明受限输出语义；Shopify 服务器收益必须由独立原始 Liquid profile 证明，之后仍需浏览器独立测量和内容回归。

## 动态 JavaScript Liquid 资产

原始 `assets/theme.js.liquid` 可与浏览器 `theme.js` 响应建立可重放的 AST/设置值映射。目前仅支持独立赋值位置的 `{{ settings.key | json }}` 标量，保留配置默认值与 current 设置证据，并映射多行模板前后的源码坐标。任意控制流、字符串内部插值、动态模板或不一致配置显式拒绝。

可在该子集生成 `js-idle-init`、`js-raf-listener`、`js-passive-listener`。变换只触及静态 JS，禁止搬移、复制或修改 Liquid 值表达式。动态资产不因此获得任意拆包或按需模块化能力；分析器、官方方法建议和真正执行入口保持一致。

## 坏图恢复：有补丁，有单独验收

`resource-audit` 的 HTTP HEAD 仅作调查。可执行恢复需要 `profile-domain` 捕获当前源码绑定的直接 `<img id>` 解码失败。暂不自动改写 picture/srcset、动态 image_tag、带 load/error handler 的图片。配置示例：

```json
{
  "schemaVersion": 1,
  "target": "sections/main.liquid",
  "offset": 123,
  "replacementUrl": "https://cdn.example.com/approved-original.png",
  "approvedAssetHash": "填写确认的原始图片响应字节 SHA-256",
  "review": {"summary": "确认图片对应的内容、用途和版权来源", "originalAssetConfirmed": false}
}
```

```sh
node scripts/perfkit.mjs plan-resource-repair --project /absolute/theme --config /absolute/repair.json --profile /absolute/before-profile.json --out /absolute/repair-plan.json
```

审阅并应用到未发布候选后，再用 `profile-domain` 采集，将 `profile.hashResourceUrls` 设为该替换 URL。工具只哈希浏览器实际拿到的指定图片响应，不另行下载资源，也不持久化图片内容。`verify-resource-repair` 配置为 `{"plan":"/absolute/repair-plan.json","before":"/absolute/before-profile.json","after":"/absolute/after-profile.json"}`，核对唯一 src 修改、部署、真实解码和批准文件的 SHA-256。返回 `correctness-restored`，不返回性能通过；该修复不能送入性能实验充当收益。

## 无收益后的真实约束

会话保留补丁指纹、失败机制和源码上下文。等价方法按机制归一：`query-limit` / `query-limit-render` 都是限制已有输出上限，不能改名重试；旧隐藏 template 两种调度不充当新优化机制。无关文件更新或目标前新增注释造成的行号漂移，不会清除已失败的目标/依赖/交付上下文；相关代码、依赖或交付图变化后才允许重新诊断。此上下文是保守重开条件，不是完整的浏览器因果证明。

恢复成本严格按 pageId + device 和对应 URL 读取；多个同设备页面不会串用第一组数据。分数距 100 的最大空间低于原最低收益时，会话拒绝该得分目标继续试补丁。没有其他测量绑定候选时明确停止生成并要求缺失证据，不能把回滚、改参数、换规则名称或重复测分称为优化成功。

本次本地夹具的固定 3 对 Lighthouse 实测：重复样式数减少后评分中位数仍为 98，FCP 约 1804.7 → 1802.8ms，改善约 1.9ms，低于原 100ms 门槛，正确拒绝并保留负样本。真实 Chrome 功能验证另核对了布局、首击、源码恢复和坏图解码。夹具采用 LiquidJS 和本地源码复制运输，不能证明 Shopify 服务器收益或商家主题提分；WOLFBOX 未发布预览与主题源码尚待提供。

可复现验证：`npm run test:theme-workflow`、`npm run test:theme-workflow-browser`、`npm run test:theme-workflow-live`。浏览器命令需要 Chrome 与本地端口权限；live 命令只生成固定样本的隔离夹具证据，临时目录会打印到终端。
