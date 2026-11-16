# 跨主题交付与持续治理（0.20.0）

规范对齐第一批增加 CrUX 阈值观察、四态检查结果及版本化规则映射，见 [规范对齐基础](standards-foundation.md)。默认目标和原正式验收条件保持不变。

第二、三批增加 opt-in 指标验收、项目 Theme Check、范围清单、八项浏览器观察和 PageOtter 交接导入，见 [规范对齐扩展](standards-upgrade.md)。`validate:delivery` 同时验证已安装 Shopify CLI；标准发行需全部阶段通过并匹配包指纹。

这些能力扩展现有采集、源码图、补丁执行、资源预算与现场汇总导入，不替代原 `verify-optimization`。工具内置测试使用明确的隔离夹具；不能把测试通过称为商家主题提速。运行产物与发行包放到仓库外。

## P0：版本、适配与业务证据

`toolkit-manifest --out /absolute/manifest.json` 按 package.files 的发行白名单生成文件 SHA-256 与总指纹。`npm run release -- --out /absolute/package.zip` 在 ZIP 内加入 RELEASE-MANIFEST.json；它证明内容身份，不证明测试通过。`npm run validate:delivery -- --out /absolute/new-run` 串行执行单元、Python、浏览器、站点及按需加载流水线，保存每项原始日志、退出码、哈希、前后包指纹和完整 validation.json。必须匹配发行包指纹才能引用该测试结果；不自动安装或发布。

正式 `verify-optimization`、`optimize verify` 及 `improve collect` 的 formal 配置可设置 `policy: "delivery-v1"`。它要求绑定主题适配器；媒体、加载器、关键样式、自定义替换等策略要求部署绑定的 integrityProfiles。缺证据停止正式采样，异常不通过。未指定 policy 的旧配置保留兼容，输出明确 legacy-policy-not-enabled / not-assessed。报告附来源版本、配置指纹与各门禁状态。policy 不决定分数是否为正式门禁；它与 [acceptancePolicy](standards-upgrade.md#两种正式验收策略) 独立、可同时使用。省略 acceptancePolicy 保留原分数门禁；两种验收策略都保留 MAD、独立采样、部署、功能和视觉保护。

`theme-capabilities --project /theme --config /identity.json --out /profile.json` 复用 source-graph；identity 支持 store/themeId/vendor/version，context 支持 appRevision/generatorRevision/configurationRevision。静态 JSON 模板、Theme Blocks、jQuery、生成器线索只提供调查入口，不自动证明运行能力。

适配器 schemaVersion=1，字段为 id、version、identity、sourceHash、context、capabilities、strategies、coverage。五类 capability 为 rendering/resources/lifecycle/business/ownership，每类包含 status（verified/absent/unknown）、contract 说明及 evidence 数组（file/sourceHash/reason）。已知状态必须有绑定到当前源文件的证据。strategy 包含 id、requires、protectedFiles、reason。coverage 明确页面、设备、配置及实际验证范围，不自动扩大为全主题兼容。

`resolve-adapter --config /registry.json --out /resolution.json` 的配置为 project、adapters、identity、context、strategy、targets。必须唯一匹配；未知能力、源漂移、外部修订变化、保护文件或多个匹配均拒绝。App/生成器外部状态没有凭空自动探测：调用方须提供当前修订值，不能沿用旧值假装重验。

标准 plan-site recipe 可加入 `adapter: {adapter,identity,context,strategy}`。计划保存契约与解析结果，应用时重查当前源码；`apply --adapter-context /current-context.json` 或 optimize/improve apply 的 adapterContext 提供当前外部修订。缺失或不匹配拒绝应用。rollback 不受适配器失效阻碍，继续使用原冲突保护恢复源码。

### 复杂交互与真实业务

scenarios 新增 `fill {selector,value}`、`select {selector,values:[...]}`、`ime {selector,text,commit:boolean}`。IME 用 Chromium 的 Input.imeSetComposition / Input.insertText，属于浏览器输入法仿真，不是实体设备兼容证明。[CDP Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)、[Playwright Locator](https://playwright.dev/docs/api/class-locator)

可选 networkFaults 为 `[{url:完整URL,occurrence:1,delayMs:500,abort:false}]`，限定明确请求次数、延迟及只读请求。不同 URL/次数延迟可验证过时响应恢复；不是真实生产网络样本。结果保留 injectedFaults、assertionOutcome，并标记 constrained/blocked，不能直接充当无干预的正式性能或业务回归。POST、WebSocket 和下载保持原默认阻断。[Playwright Route](https://playwright.dev/docs/api/class-route)

真实 Cart 写入不另建不受控执行器，接入项目已有授权测试：`verify-business --config /business.json --out /result.json`。配置为 input（绝对 manifest 路径）、identity（sourceHash/store/themeId）、requiredCases。manifest 使用 external-business-run、mode=authorized-preview，记录 producer、authorization.reference/store/themeId、identity、startedAt/finishedAt 和 cases。

每个 case 含 id、artifact（相对原始 JSON）、sha256、expected。原始 JSON 包含 identity、时间、actions（type/target/at）、requests（method/url/status/completed）、cart、ui、events、errors、simulated=false。expected 的 cart/ui/events 与原始观察完整比较，writes 是按序预期的 `{url,status}` POST 列表。记录真实 line key、properties、价格、数量与事件计数；不能用已通过布尔值代替原始观察。独立校验身份、区间、原始文件哈希和必需场景；哈希不是服务端签名，测试来源仍须可信。正式回归通过 regression.businessEvidence（optimize 用 businessEvidence）引用同一配置，identity 强制绑定候选。

## P1：窗口预算、策略与规范

现有 resource-budget 仍读取 Lighthouse resource-summary 的逐导航硬限制。新增 `audit-window-budget --config /budget.json --out /result.json` 读取 runtime-profile 原始 CDP 请求，不重建第二套采集器。配置：profiles、可选 beforeProfiles、windows、owners、exceptions。

window 为 id、anchor（navigation/interaction）、fromMs/toMs、可选 owner/component、maxTransferBytes/maxRequests/maxDeltaBytes。首屏边界由证据明确声明，十秒窗口是 `[0,10000)`；交互相对 interactionStart。profile 必须覆盖区间，旧记录无时间字段需重采。每个请求/redirect hop 只算一次，按开始时间归窗；累计完整传输字节可能延伸到窗口末尾之后，各窗不得相加。CDP encodedDataLength 与源码字节、响应解码体积、Lighthouse 统计保持区别。

owner 映射为 origin/pathPrefix/owner（theme/app/platform）及可选 component。歧义或未知不补零；缓存保留明确标记；失败/未结束/缺字节/截断不能通过。净增比较要求同页面/设备/状态、环境与浏览器。每组暂接受一份 profile，不把多个样本或 p75 乱合并。exception 记录 window/url/device/reason/responsible/expiresAt，显示 active-review-required 或 expired，不自动掩盖失败。

`strategy-contract` 复用 createSitePlan，接收 project、strategy、adapter、identity、context、recipe、review；review.conditions 必须覆盖该策略条件。输出 embedded plan，继续既有 apply/experiment/verify。五类契约：jquery-lifecycle、section-styles、cart-bundled、font-fallback、media-presentation。正式验收按契约核对具名场景；Cart 五类反例必须有外部业务证据。契约检查不替代实际主题审阅。

assets/runtime/theme-adapter-primitives.mjs 提供 opt-in 模板：instanceLifecycle 管理多实例、卸载和挂起初始化；replaceSectionContents 保留返回的 style[data-section-stylesheet]、显式初始化并提供恢复函数；cartMutationQueue 保留 locale 和 payload、串行操作、同一 pending operationId 去重，渲染失败恢复，写入不确定时先读状态且不重放写请求。调用方提供真实 jQuery 插件与购物车协议；不全站注入、不自动执行 script、不接管任何主题私有 API。字体复用既有 liquid-font-display，媒体复用域策略和 LCP 身份检查，复杂改动继续 reviewed replacement。

`audit-policy --config /policy.json --out /audit.json` 接收 project、beforeProject、components、limits、exceptions。复用源码图，比较新增/恶化的非空物理行、显式组件源码体积、新依赖与共享资源变更；历史债务保留。组件须显式声明，聚合包不当作单组件。schema/javascript/stylesheet/script/style 区域分列；复杂混行人工复核。复杂度、嵌套、设置数沿用官方 Theme Check，语义重复人工审阅，报告标记 notAssessed，绝不自造同名官方算法。例外须有文件、规则、理由、负责人和到期日。

CI 配置可增加 engineeringPolicy（与 audit-policy 相同），复用现有 ci-check；要求 baseline/candidate 目录的源码指纹与各自正式导航部署证据一致，不能靠 CI commit 标签替代。未配置保持旧行为。

配置起点见 assets/examples/delivery-theme-identity.json、delivery-window-budget.json、delivery-policy-audit.json、delivery-input-scenarios.json、delivery-business-import.json 和 delivery-field-monitor.json。路径、ID、指纹、来源批准及选择器均须替换为实际证据；示例不是通过记录。

## P2：批准的现场汇总数据监控

`field-monitor --config /monitor.json --out /new-directory` 复用 import-field，支持已批准的本地汇总 JSON/CSV/CrUX 导出。sources 每项为 id/input/approvalRef/release；release 包含 version/sourceHash/deployedAt。previous 引用已保存快照；schedule 为 cycles（1–100）与 intervalMs（1 秒–1 天）。默认单轮，可由已有 CI/系统调度定时执行，也可显式运行有限多轮；工具不安装后台任务。

每轮保留独立快照、趋势和告警 JSON，失败来源不丢失。按 source、URL/Origin、模板、设备、国家、元素匹配分组；过期、样本不足、发布时间落在统计窗口中、窗口重叠/重复或长度不同，不形成可比回归结论。不平均 p75、不相加重叠样本；阈值超标与趋势退化分别记录。告警仅落盘，不发消息/邮件/webhook。自有 RUM 采集和 A/B 平台不在此实现中，现有批准的汇总导出已能驱动持续观察。

## 验证与实施范围

`npm run test:delivery` 验证三类合成主题适配、漂移/歧义/拒绝、业务证据、预算与趋势、生命周期与 Cart 反例；`npm run test:delivery:browser` 运行真实本机 Chrome 夹具，验证输入/IME、响应延迟、POST 阻断、动态样式和恢复。正式发行前执行 validate:delivery，并匹配 RELEASE-MANIFEST 的 sourceHash。无实际主题与现场数据时，交付只声明工具能力及隔离测试结果，不编造商家性能结论。
