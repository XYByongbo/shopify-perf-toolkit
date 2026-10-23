# 图片、布局、Liquid 与应用的实测闭环

`profile-domain → diagnose-performance → plan-domain → apply → experiment` 接通这四类问题。也可由 `improve prepare` 的 `domain` 字段调用同一个生成器，之后复用会话的回滚、重诊断、不同方案选择与正式验收。静态告警或一次 profile 不证明收益。

查询分页、隐藏 DOM 和 Section Rendering 的新增执行器见 [扩展闭环](extended-optimization.md)，复用本文的部署绑定和 Liquid 测量合同。

## 定位与生成范围

| 候选 | 必须具备的定位证据 | 实际改写 | 不自动处理 |
| --- | --- | --- | --- |
| image-lcp | 实际 LCP 元素/URL、初始视口、部署源码与唯一解析器节点 | `image-eager`；`image-priority` 另加高优先级；支持直接 img 与 image_tag | 多实例循环、动态 loading、CSS 背景图、未核实的共享上下文 |
| image-cls | 图片尺寸增长与无输入布局偏移时间相关、原始尺寸 | `image-dimensions` 写宽高；`image-aspect-ratio` 写比例 | picture 艺术裁切、动态裁切、不可推导的响应式比例；相关性仍需实验确认 |
| liquid-hotspot | 当前部署的 Shopify CLI 原始 profile 精确到文件/行，配套页面运行 profile | `liquid-cache-loop-filter`、`liquid-cache-metafield` 复用语义受限的缓存变换 | 动态依赖、非不变表达式、无法证明循环作用域；TTFB 不能替代服务端采样 |
| app-loader | 主题可控 script、精确 host/path 归属、真实请求或 CPU 成本、脚本内容哈希 | `app-defer`；独立执行审阅后 `app-async` | content_for_header、平台 ScriptTag、未知归属、任意移除/屏蔽 App |
| app-space | 容器增长与偏移时间相关、唯一 id、移动/桌面稳定几何数据 | `app-reserve-space` 写入局部断点 min-height | 高度变化、悬浮/绝对定位、全站统一预留猜测值 |

支持范围以解析器和变换器的校验为准。准备失败会保留原因，不制造替换；修正配置/审阅可以重试。结构本身不受支持时选择另一个提供的方法，或经审阅的定制替换。禁止将 missing review 自动补成 true。

## 采集部署绑定的运行证据

```json
{
  "schemaVersion": 1,
  "mode": "runtime",
  "deployment": {"project":"/absolute/baseline-theme","store":"example.myshopify.com","themeId":"123"},
  "url": "https://example.com/products/example",
  "profile": {"device":"mobile","settleMs":2000}
}
```

```sh
node scripts/perfkit.mjs profile-domain --config /absolute/profile-config.json --out /absolute/profile-mobile
node scripts/perfkit.mjs diagnose-performance --project /absolute/candidate-theme --profiles /absolute/profile-paths.json --owners /absolute/owners.json --out /absolute/diagnosis.json
node scripts/perfkit.mjs plan-domain --project /absolute/candidate-theme --diagnosis /absolute/diagnosis.json --config /absolute/plan-config.json --profiles /absolute/profile-paths.json --out /absolute/plan.json
```

profile-paths.json 是各次输出 `profile.json` 的绝对路径数组。profile-domain 在采集前后执行真实 Shopify CLI source pull 和浏览器主题身份核验；强制使用声明的 preview_theme_id。CLI 登录和主题权限需要预先可用。原 profile-runtime 或离线导入的 Liquid 数据继续可用于调查，但不能冒充这种部署绑定。

默认按唯一字面 id 或唯一 script URL 关联源节点。没有字面 id 时，可在 profile-domain 配置中显式提供 `bindings:[{"file":"sections/hero.liquid","offset":123,"sourceHash":"完整文件 SHA-256","selector":"#shopify-section-example .hero","review":"具体 DOM 与源码对应依据"}]`。浏览器必须证实选择器仅匹配一个元素，文件哈希/解析器偏移也必须一致；这仍是操作者审阅的映射，不是通过 URL 猜测 Liquid 位置。歧义、源码变化或部署变化均不生成候选。

计划配置示例（审阅值必须来自实际检查）：

```json
{"schemaVersion":1,"candidateId":"诊断实际返回的 ID","method":"image-priority","review":{"summary":"填写共享实例和首屏用途的实际审阅结果","sharedInstancesReviewed":true}}
```

图片尺寸另外需要 responsiveRatioReviewed。App loader 需要 dependenciesReviewed、nonCritical、documentWriteAbsent、businessEventsReviewed，以及 businessAssertions 业务 UI 选择器数组；async 另需 independentExecutionReviewed。容器预留需要 allStatesReviewed、contentSizeStable、responsiveGeometryReviewed，提供目标主题已有 breakpoint 和同页两个设备的 profiles。Liquid 需要 profileHotspotConfirmed、loopScopeReviewed，metafield 另需 metafieldImmutable。

生成计划后审阅完整 diff 和 verificationRequired，使用既有 apply/rollback。独立 experiment 需要真实准备好的基线与候选预览，不能将本地文件改动当成远端同步。每个候选仍需前后各三个交替导航样本、相同 checkpoint、首个交互和断言；App 两侧必须成功获取原脚本，实际响应体 SHA-256 必须与诊断一致；测量前后部署检查采集到的脚本字节也须一致。点击/按键前先记录下一条断言的实际状态，操作后紧接业务断言且状态必须发生预期变化；操作前已满足断言不能证明功能正常。正式回归也重新检查 App 契约。域候选的回归采集必须位于对应源码的部署证明之间，不能先跑回归、再补一次身份核验。候选出现有部署证明支持的断言失败时，记为 functional-regressed 并停止导航采样；环境/身份/脚本漂移仍记为 invalid-evidence。受限只读回归不能证明真实支付、加购或统计写操作正确；这类用途还须外部业务验证，不能仅依 UI 断言批准延后统计。

尺寸预留改变的是加载过程中的几何尺寸；最终布局 checkpoint 应先用 `{"action":"assert-image-loaded","selector":"#hero"}` 确认相同图片已完成加载且原始尺寸非零，不能比较“基线尚未加载”与“候选已预留”的瞬间并判定最终布局改变。首次加载的偏移与 LCP 仍在无此等待干预的独立 Lighthouse 导航中测量。App 解析阻塞默认提出 FCP 假设，明确 loading 目标时遵从该指标；不能看到分数上涨后替换原实验的目标指标。

## Liquid 先证实服务端收益，再花费导航样本

将 profile-domain 的 mode 改为 liquid，通过 Shopify CLI 实际采集原始 Speedscope。diagnose-performance 使用 `--liquid /absolute/liquid/profile.json`，同时传入该页面的部署绑定 runtime profiles，以确定需要验证的设备范围。

当前 Shopify CLI 的 profile 需要已登录账户会话，不支持 Theme Access/Admin API token 替代该会话。缺权限或 CLI 不支持 JSON 时报告采集失败，不把导入的文件改标为实测。

应用并同步后运行：

```json
{
  "schemaVersion":1,"runs":3,
  "before":{"schemaVersion":1,"mode":"liquid","deployment":{"project":"/absolute/baseline-theme","store":"example.myshopify.com","themeId":"123"},"url":"https://example.com/products/example"},
  "after":{"schemaVersion":1,"mode":"liquid","deployment":{"project":"/absolute/candidate-theme","store":"example.myshopify.com","themeId":"456"},"url":"https://example.com/products/example"}
}
```

```sh
node scripts/perfkit.mjs experiment-liquid --config /absolute/liquid-pair.json --out /absolute/liquid-pair
```

把生成的 liquid-evidence.json 路径放入 experiment 配置的 `liquidEvidence`。工具核验交替采集顺序、源/主题/页面、独立时间范围、原始 JSON 哈希、实际 CLI 版本及 profile 的数量/名称/类型/时间单位，并从原始数据重算文件 self-time 和完整时间区间成本。目标文件帧消失不能解释为耗时归零；采样无法解释至少 99% 的区间时间时拒绝验收。哈希用于检测内容变动，不是服务端真实性签名。插入行会移动栈帧，因此收益比较用受影响文件的 self-time，总成本用于退步保护。当前门槛为至少 1 ms、5% 或 3×MAD 的最大值；这是工具决策阈值，不是 Shopify 承诺或统计置信区间。

服务端无收益会在 Lighthouse 之前返回 hypothesis-not-confirmed，会话记入失败历史并回滚；不能靠导航分波动掩盖 Liquid 无效。服务端有收益还须通过独立导航目标收益，不能直接验收。正式验收需要每侧五次 Liquid profile，可在初次 experiment-liquid 使用 runs:5；如先探索三次，再将正式五次产物传给 `verification.liquidEvidence`。会话固定首份有效正式 Liquid 证据，补审阅不能再换样本；后续省略 liquidEvidence 时自动复用固定数据。被引用的诊断、回归和 Liquid 文件在探索通过时物化为会话快照，不能通过改写路径指向的文件替换证据。三阶段采集（部署校验、profile、部署复核）的时限均受剩余共享预算约束。

## 无收益时换实现

```json
{"schemaVersion":1,"action":"prepare","previous":"/absolute/last-step/session.json","candidateId":"当前候选 ID","method":"next","rationale":"根据上一轮实测解释为何改变机制","domain":{"schemaVersion":1,"review":{"summary":"实际审阅结果","sharedInstancesReviewed":true}}}
```

`next` 选择当前假设尚未执行过有效实验的方法，例如 eager 无效后选择 eager+high priority。随后仍要审阅、apply、显式同步和 experiment，不自动假定第二种方法有效。相同补丁/方法已验证无效则不能重复磨分；使用 `candidateId:"next"` 与 `method:"next"` 可以跨候选选择尚未尝试的方法；`session.nextDomainStep` 给出实际下一步。候选方法全部耗尽时进入 investigation-required，executionCoverage 不再把已耗尽候选计为可执行。明确结构不支持/无变化/补丁重复的方法会跳过；缺审阅或缺必要证据仍可补齐重试。所有切换仍受原会话预算约束，不自动增加轮数。缺少审阅信息不消耗方法，但实际执行失败仍按会话预算结算。

## 验证范围

首次实现的实际结果（包括无收益和退步）见 [验证记录](domain-validation.md)；后续漏洞修复及反例验证见 [闭环审查记录](domain-review.md)。旧数据没有脚本哈希、原始 Liquid 哈希/CLI 版本或部署前后回归证明时需要重采，不回填通过字段。

- `npm run test:domains`：源码绑定、尺寸/比例、Liquid 语义与采样反例、App 保持和布局生成。
- `npm run test:domains-browser`：真实 Chrome 的图片偏移、加载优先级与 App 首次操作。
- `npm run test:domains-live`：隔离人工夹具，真实 Chrome/Lighthouse 前后交替采样，负结果照实保留，回滚并尝试另一种图片加载方法。仅远端 source pull 用本地副本模拟。

这些测试不能代替商家真实主题验收。真实主题需指定项目、独立基线/候选未发布预览、权限和业务契约；本轮真实主题地址等待用户提供。工具不会承诺任意主题必然提分，不把流程完成报告为优化成功。
