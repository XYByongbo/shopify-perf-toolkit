# 整站扫描、源码关联与场景验收

适用于 v0.4。本文的 scan/map/scenarios 输出结构化证据，可用 `report` 转成 HTML；这三个命令不修改主题源码，场景 DOM 操作仅发生在隔离浏览器中。完整 measure/audit-site/plan-site/apply/verify-site 流程见 [整站工作流](site-workflow.md)。

## 1. 整站源码扫描

```sh
node "<skill-dir>/scripts/perfkit.mjs" scan --project "<theme>" --out "<new-run>/site-scan.json"
node "<skill-dir>/scripts/perfkit.mjs" report --input "<new-run>/site-scan.json" --out "<new-run>/site-scan.html"
```

扫描结果包括文件清单、原始字节和 SHA-256、静态依赖、逐文件候选、规则覆盖与代表模板。模板配置关联到 section，字面 render/include、资产引用等关联到文件；动态路径和无法解析的关系保持 unresolved。扫描不读取或输出店铺密钥，不执行 Liquid，不下载外部资产。

先检查 `complete` 和 `errors`，再检查 `candidates/findings`。候选顺序用于安排调查，不表示预计提速幅度。原始资产大小不等于网络压缩后大小；静态图未找到引用不证明资源无用，不能据此自动删除 App 或资产。Theme Check 尚未内置执行，可在已有 Shopify CLI 环境单独运行后合并证据。

`--pages` 接收 JSON 字符串数组，例如 `["https://preview.example.com/", "https://preview.example.com/products/real-handle"]`，提供项目实际页面列表；扫描结果中的模板不能代替已验证的线上地址。商品、集合、页面的 handle 需从项目或店铺取得，不猜测。

## 2. 源码与页面对象关联

新采集同时提供 `--project` 和 `--target` 会自动尝试关联：

```sh
node "<skill-dir>/scripts/perfkit.mjs" capture --url "<preview-url>" --selector "#shopify-section-template--123__hero" --project "<theme>" --target sections/hero.liquid --out "<new-run>/hero-390"
```

已有采集可以离线关联，保留原文件：

```sh
node "<skill-dir>/scripts/perfkit.mjs" map --project "<theme>" --target sections/hero.liquid --capture "<new-run>/hero-390/capture.json" --out "<new-run>/hero-mapping.json"
node "<skill-dir>/scripts/perfkit.mjs" inspect --project "<theme>" --target sections/hero.liquid --capture "<new-run>/hero-mapping.json" --out "<new-run>/hero-inspection.json"
node "<skill-dir>/scripts/perfkit.mjs" report --input "<new-run>/hero-mapping.json" --out "<new-run>/hero-mapping.html"
```

支持保守解析的字面 `<img>`，结合唯一静态 ID、section 实例配置与静态属性，或已有的 `data-perf-kit-source-path/hash/index` 标注。标注需通过当前文件 hash、索引及属性一致性检查。URL 相同、DOM 顺序相同都不单独构成关联依据。

结果区分显式标注与 inferred 推断，保留 `mappings/ambiguous/unmapped` 和 `linkedCapture`。本地 hash 一致只能证明使用了哪个本地源码快照；不能证明远端部署就是该快照。推断仅支持候选调查。循环中的多实例按 selector 分开，歧义不自动选择第一项。

无法解析的 `image_tag`、动态属性、snippet 参数传递、CSS 背景图和 shadow DOM 继续人工核对。不要为了提高关联率向生产主题插入调试标注。旧版采集缺少 DOM 描述字段时可重新采集；关联不足应保留未关联状态。

## 3. 自动化场景验收

以 [组件场景示例](../assets/examples/component-scenarios.json) 为起点，把 URL、选择器和预期值改成真实组件的契约，然后运行：

```sh
node "<skill-dir>/scripts/perfkit.mjs" scenarios --config "<reviewed-scenarios.json>" --out "<new-run>/component-scenarios"
node "<skill-dir>/scripts/perfkit.mjs" report --input "<new-run>/component-scenarios/scenario-results.json" --out "<new-run>/component-scenarios.html"
```

配置顶层使用 `schemaVersion: 1`、`url`、`scenarios`，可提供 `viewports`、`timeoutMs`、`settleMs` 和 `runTimeoutMs`。每个场景包含唯一 `name`、可选独立 `url` 和有序 `steps`。默认手机 390×844、桌面 1440×900，各场景/视口使用新的浏览器上下文。每个视口可显式设置 DPR。默认动作超时 10 秒、每轮场景超时 120 秒、settleMs 为 0；动作超时最多 30 秒，单轮最多 300 秒。配置最多 40 轮，每场景最多 100 步，显式等待总计最多 60 秒。

```json
{
  "schemaVersion": 1,
  "url": "http://127.0.0.1:9292/",
  "scenarios": [
    {
      "name": "first-click",
      "steps": [
        { "action": "click", "selector": "#details-button" },
        { "action": "assert-visible", "selector": "#details-panel", "visible": true },
        { "action": "assert-attribute", "selector": "#details-button", "name": "aria-expanded", "value": "true" }
      ]
    }
  ]
}
```

| action | 字段 | 用途 |
| --- | --- | --- |
| `click` | `selector`, 可选 `times` | 单次或重复用户操作 |
| `scroll` | `selector` | 把一个组件滚入视口 |
| `assert-count` | `selector`, `count` | 检查多实例数量或节点是否移除 |
| `assert-visible` | `selector`, 可选 `visible` | 检查存在的元素是否可见；不存在用 assert-count |
| `assert-text` | `selector`, `text` | 检查组件 textContent，折叠空白并去除首尾空白后精确比较 |
| `assert-attribute` | `selector`, `name`, `value` | 检查属性；null 表示属性应不存在 |
| `detach` | `selector`, `key` | 临时移除同一个 DOM 节点，保存重连位置 |
| `reconnect` | `key` | 恢复先前移除的原节点 |
| `dispatch` | `selector`, `event`, 可选 `detail` | 派发 shopify:section:load 或 shopify:section:unload |
| `wait` | `ms` | 明确的观察窗口；不要代替组件就绪断言 |

除 assert-count 外，需要定位元素的动作要求唯一 CSS 选择器。未知字段或动作会拒绝执行。场景按步骤运行；某一步失败后停止该场景的依赖步骤，但继续其他独立场景，保存失败证据。

组件测试至少为改动涉及的行为编写断言。例如三个实例各自点击后只更新自身；连续派发两次 section load 后一次点击只执行一次；detach 后回调计数停止、reconnect 后恢复。事件动作只模拟指定事件，不运行完整 Shopify 编辑器。计时器/监听器清理需要组件可观察结果或独立测试插桩，运行器不会凭一次重连宣称没有内存泄漏。

运行器默认拦截非 GET/HEAD/OPTIONS 请求、Service Worker 和支持拦截的 WebSocket。购物车、支付、必要统计等依赖被拦截时结果保持 blocked，不能用来验收交易链路。GET 仍可能有服务端副作用，选择开发/预览环境和已审阅的非交易组件场景。没有继承登录、购物车或同意状态。

本地地址（localhost、127.x.x.x、IPv6 loopback）会自动标记 localPreview。通过自定义域名提供的本地测试页可自行设置 `window.__LOCAL_PREVIEW__ = true`；报告同时保留标记/地址检测依据。localPreview 为 false 也不表示已认证为真实 Shopify 或生产环境。

结果的 passed 只表示本次配置的断言通过；failed 表示断言或运行错误，blocked 表示受网络策略等条件限制。失败/阻断返回退出码 3。场景截图供人工查看，尚无像素差异算法；第一次配置的点击不是严格的最早可交互时间或真实用户 INP 测量。

## 典型组合

整站任务先 scan，选择高价值候选；用 capture/map 关联实际页面实例；修改前后分别运行同一场景配置，并使用 capture/verify 比较内容与布局。只有用户需要页面级性能收益结论时才另行准备正式 Lighthouse 报告。不要把所有扫描候选自动批量修复。

实现依据：[Shopify JSON 模板](https://shopify.dev/docs/storefronts/themes/architecture/templates/json-templates)、[主题编辑器事件](https://shopify.dev/docs/storefronts/themes/best-practices/editor/integrate-sections-and-blocks)、[Playwright 浏览器上下文](https://playwright.dev/docs/api/class-browsercontext)。

### 表单、焦点与购物交互

`checkpoint` 使用 version 2，额外采集表单运行状态、实际禁用、多选项、根内焦点及滚动；不同视口/页面滚动不能比较。对比旧 version 1 仅保留历史覆盖，前后均重新采集才能使用新增能力。详见 [快照与 HTML](rendered-html.md)、[受影响购物交互场景](interaction-scenarios.md)。这里的场景执行器仍拦截业务写请求，复杂输入/乱序/IME 需用项目测试或授权预览另测。
