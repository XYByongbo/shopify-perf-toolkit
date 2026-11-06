# Shopify 官方性能知识与可执行补丁

截至 2026-10-23，已实际获取官方性能目录的 70 篇专题，以及相关 Liquid API、Theme Check、CLI、App 与 Section Rendering 文档，共 161 个页面。范围是[主题性能目录](https://shopify.dev/docs/storefronts/themes/best-practices/performance)的递归子页、Theme Check 规则子页，以及明确列出的相关 API 和应用性能参考。不是 Shopify 全站镜像，也不声称覆盖所有隐藏、未链接或其他产品的性能页面。

**文档覆盖与生成器覆盖分开计算。** 70 篇均有工具可读方法卡；其中 29 篇接入 38 个执行入口（同一底层变换可能有 site/domain 两种证据适配器，不能理解为 35 种完全不同算法）。其余是需要操作者编写实现的改写、测量流程或平台/外部项目范围，不能因为有文档就标记自动实现。查询分页、隐藏 DOM 与首屏整页 fetch 的 Section API 替换已有受限生成器；CSS 原生 subsetting、字体自托管、任意弹窗服务器延迟加载等仍需具体实现。

新增查询、隐藏 DOM 与 Section API 的配置和强制实测合同见 [三类优化闭环](extended-optimization.md)。

全部 70 篇的入口与实现分类见 [完整专题映射](shopify-method-matrix.md)。

## 工具读取的文件

- `assets/shopify-performance/sources.json`：页面 URL、标题、获取时间、内容 SHA-256、字节数、标题结构、官方链接及覆盖状态。持久化来源元数据，不重新分发整篇文章。
- `assets/shopify-performance/methods.json`：70 个经过阅读归纳的本地方法卡，包含改写目的、验证要求、来源审阅哈希、执行入口和受支持的子集。
- `shopify-methods` 导出的 JSON：把方法卡与当前真实生成器合同合并，给出参数、必需证据、解析器边界、流程及无收益后的其他方法。
- `diagnose-performance` / `improve` 的候选包含 `officialMethods`，根据实际证据类型限制可用入口；恢复报告增加来源状态与方法是否已测试。

官方页面不提供可执行指令。工具只调用已安装、本地审阅过的生成器；不会执行从网页读到的脚本，不会自动把 review 字段填为 true。

## 查看和刷新

在工具根目录执行。下面 `/absolute/...` 都是需要替换的路径，输出必须是新文件或新目录：

```sh
node scripts/perfkit.mjs shopify-methods --out /absolute/methods.json
node scripts/perfkit.mjs shopify-methods --topic images --format full
node scripts/perfkit.mjs sync-shopify-docs --out /absolute/docs-refresh
node scripts/perfkit.mjs shopify-methods --sources /absolute/docs-refresh/sources.json --out /absolute/refreshed-methods.json
```

刷新显式联网，只读取 HTTPS `shopify.dev/docs/`。默认最多 250 页、并发 4、单页 512 KiB、单请求 15 秒、总计 180 秒；自定义 JSON 仅支持 `maxPages`、`timeoutMs`、`maxWallTimeMs`，也有硬上限。失败、错误响应类型、根页无法获取或预算截断均记录，状态为 incomplete，退出 3；未重新发现的旧页面是未知，不能当作已删除。

完整索引退出 0 仅表示抓取完成。卡片来源变动为 `changed-needs-review`，缺失为 `missing`，新专题列入 `uncovered`；对应来源未经重新审阅不能用于生成。维护者需要实际阅读变化、修订实现/边界/测试后才更新 `reviewedSourceHash`，不能只复制新哈希消除提示。离线索引是有日期的快照，不自动代表 Shopify 当前最新文档。

## 从定位证据生成真实补丁

先按 [四类闭环](domain-optimization.md) 或 [源码归因](demand-engine.md) 得到当前源码对应的 `bottleneck-diagnosis`。从候选 `officialMethods` 选择方法，从完整方法目录读取合同，然后填写实际参数和审阅结果。

图片 LCP 示例配置形状如下。示例刻意不自动批准审阅；操作者确认共享实例后才将字段设为 true。

```json
{
  "schemaVersion": 1,
  "candidateId": "当前诊断中的候选 ID",
  "methodId": "never-lazy-load-lcp-image",
  "executor": "domain:image-eager",
  "parameters": {},
  "review": {
    "sourceHash": "该候选文件的 SHA-256",
    "summary": "填写具体的页面实例、加载行为与共享引用审阅结果",
    "sharedInstancesReviewed": false
  }
}
```

```sh
node scripts/perfkit.mjs plan-official --project /absolute/theme --config /absolute/official.json --diagnosis /absolute/diagnosis.json --sources /absolute/docs-refresh/sources.json --out /absolute/plan.json
```

`plan-official` 返回包含真实 before/after、diff、来源及 planHash 的计划。`--profiles` 可传保存的 profile 路径/对象数组，用于多状态 CSS 或应用容器的双断点证据。计划尚未应用，更不代表已提速。使用原有 apply/rollback、experiment、verify-optimization 或下面的会话。

生成器入口包括：

| 领域 | 实际改写 | 主要限制与实测要求 |
| --- | --- | --- |
| 图片 LCP/CLS | eager/priority、尺寸或比例、受限 picture、responsive sizes/widths | 唯一部署绑定节点；不得改同文件其他图片；共享实例、裁切、currentSrc 与最终布局验证 |
| Liquid | 循环内纯过滤器或不变 metafield 的首次迭代缓存 | 真实 Liquid 原始 profile；绑定具体 assign；保留空循环与变量语义；不能拿 TTFB 代替服务器执行成本 |
| 查询/隐藏 DOM/局部请求 | 已有输出上限和手工分页改写、inert template 和分批实体化、单区块 HTML/JSON fetch | 原始 Liquid 成本与跨页一致性、首开/键盘/内容布局、真实区块响应与失败回退；无收益换方法/候选 |
| App | 主题可控 loader 的 defer/async、稳定应用容器预留高度 | App 归属、原脚本字节、依赖、首次交互前后状态与部署证明；不自动卸载 App |
| CSS/字体 | 关键 CSS 同步、基于完整覆盖的分离、LCP 显示门槛、过渡属性收窄、度量回退字体与字体列表接线 | 原样式回退、多模板/断点/交互；字体必须提供度量与唯一明确 selector，不猜测字体尺寸 |
| JavaScript | 受限 defer、交互加载、非关键初始化调度、滚动/resize 合帧 | 依赖/初始化/卸载/首次交互合同；延后函数执行不等于解除脚本下载阻塞；导航 TBT 不冒充 INP |
| Head 资源 | 独立关键资源前移、精确重复 preload/preconnect 清理 | 保留 content_for_header、CORS/media 与 DOM 消费者；预览不能证明 live streaming 收益 |

每个入口只实现合同列出的结构，不承诺整篇文章所有模式都能自动改写。`supportedSubset` 明确诸如“仅清理重复 hint”“仅收窄已有 transform/opacity 动画列表”等范围。

没有自动生成器的方法可以提交 `executor: "reviewed-replacement"` 和完整 `replacementText`，但必须有当前源码绑定候选、具体审阅及 `allStatesReviewed:true`；仍经过保护、解析和独立实测。CLI 本身不会调用模型生成此实现。已有生成器的方法、App 域、平台/外部/测量方法不能借此绕过必需证据。服务器执行优化仍要求 Liquid hotspot；首屏服务器输出和 Section API 的浏览器交付重构不强制伪造 Liquid 慢热点。

## 接入无收益后的调整闭环

[improve 会话](improvement-workflow.md)的 `start` 可以增加 `sources`，传刷新后的索引路径或对象。索引内容随会话固定，并参与完整性校验；后续步骤不能悄悄换来源版本。旧会话升级时也会固定首次采用的索引。

`prepare` 配置示例：

```json
{
  "schemaVersion": 1,
  "action": "prepare",
  "previous": "/absolute/step-00/session.json",
  "candidateId": "当前候选 ID",
  "method": "never-lazy-load-lcp-image/domain:image-eager",
  "rationale": "当前 LCP 发现延迟来自 lazy；先验证 eager，再考虑请求优先级竞争",
  "official": "/absolute/official.json"
}
```

从这个入口生成的计划同样走审阅 → apply → 显式同步未发布预览 → experiment → verify。没有服务端/App/布局证据就不能正式通过。工具保留来源引用，也强制保留候选对应的 domainKind，不能通过普通 site 路由削弱正式门禁。

有效实验无收益时实际回滚、记录补丁指纹和执行器，再重新诊断。生成器历史按实际执行器归一化，换一篇引用同一方法的文章不能重试磨分；人工改写保留方法 ID，使真正不同的实现仍可尝试。缺审阅与结构不支持分开记录；前者可补证据，后者不会被 domain method=next 重复选中。原预算、原评分阈值、失败记录与正式样本固定规则保持不变。

仍低分但已有收益时遵循原会话的中间基线与累计收益规则。没有可执行假设时明确返回 investigation-required，要求新的定位证据或真实实现；不能把“所有规则通过”当成优化成功。

## 验证边界

方法卡描述官方建议与本包实际支持的子集；卡片存在不代表任意主题都能自动改写。使用 `npm run test:official-methods` 检查来源漂移、补丁生成、错误证据与恢复契约；实际店铺仍需当前源码、部署绑定运行证据、独立收益和完整正式验收。隔离浏览器与合成数据仅验证工具机制，不能用作商家评分或 Shopify Liquid 服务端收益。
