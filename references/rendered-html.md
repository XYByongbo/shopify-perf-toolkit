# 渲染后 HTML 审查与快照状态

用于已保存的完整页面或 Section HTML。先用 `audit-quality` 定位源码问题，再按需检查最终输出；两者的证据用途不同。这个入口不下载页面、不渲染 Liquid、不执行 JS，也不会自动修改主题。

## CLI 与批处理

```sh
node scripts/perfkit.mjs audit-html --input /absolute/task/rendered.html --out /absolute/task/html-audit.json
node scripts/perfkit.mjs audit-html --input /absolute/task/section.html --fragment true --lcp-id actual-image-id --out /absolute/task/section-audit.json
node scripts/perfkit.mjs report --input /absolute/task/html-audit.json --out /absolute/task/html-audit.html
```

输入只接受 `.html` / `.htm`，最多 20 MiB；`--fragment` 必须为 true/false。`--lcp-id` 只能填写当前浏览器 trace 已确认的实际图片 ID；调用方提供的 ID 不是工具自行测得的 LCP。缺少 trace 时省略，不按名字猜 hero。

`batch` 配置可加 `renderedHtml`，1–12 项，每项为 `{ "input": "/absolute/task/rendered.html", "fragment": false }`，可选 `lcpId`。每项保存独立 JSON、HTML 和 `rendered-html-N.transport.json` 进程记录，沿用批处理总预算、单 agent 和顺序执行；不额外启动导航测量。全部完成后保存 `rendered-html.json` 数组，并由 `audit-site --html-audits` 汇入最终整站报告；标记 `unverified-source`，不当作当前主题源码身份或性能证据。后续输入失败/总预算超时时保留已完成结果与 completed/inputs，不把部分矩阵标为完成。HTML 辅助进程不创建独立进程组，随批处理监督组一起终止；直接调用仍有自身时限。输入错误会失败，错误/告警保留 `reviewRequired`，不能被评分达标遮盖。干净 HTML 也不能替代缺失或失败的原正式验收。

直接调用 Python helper 时，错误退出 1、输入失败退出 2、仅警告退出 0。统一 Node CLI 的错误或警告退出 3，输入/执行失败退出 2，干净审查退出 0；0 仅表示所覆盖的 HTML 检查完成。Python 3.9+ 标准库即可运行，无新增 npm 或 Python 依赖。

## 覆盖与归属

- 检查重复 ID，图片源、alt、尺寸与加载属性，外部 classic script 的阻塞候选，属性一致的重复 stylesheet。
- 完整页面检查 title、description、canonical 的数量、空值和 head 归属；fragment 不要求整页元数据，并标记片段重复输出这些标签。
- JSON-LD 检查严格 JSON 语法、重复成员与实体定义线索；仅 `@id` 引用不当重复实体。重复定义、多个 high 图片和 h1 数量是待复核项，不自动删除，也不推断排名影响。
- template/noscript 惰性内容不按活动 DOM 统计；不能据此认定其中 Liquid 查询没有服务端成本。HTMLParser 是辅助解析器，不是浏览器完整建树、可访问性树或结构化数据资格验证。
- 详情最多 200 项，完整问题数量仍保留。输入 SHA-256 对应实际读取的原始字节；`sourceAssociation=unverified-saved-html` 表示尚未证明店铺、主题及源码身份。不能将 HTML 行号直接当 Liquid 行号。

## 快照 version 2

`scenarios` 的 `checkpoint` 已使用现有采集器输出 version 2。沿用内容、属性、value/checked、几何和 computed style，并采集：

- indeterminate、readOnly、required、multiple、selected、open、hidden、inert 和 min/max/step/pattern。
- 祖先 fieldset 等导致的实际 `:disabled`、全部多选项的 index/value、根内焦点与元素滚动状态。
- 视口、DPR 和页面滚动位置；不在同一条件下的证据返回 `invalid-evidence`。

同场景在字体、图片、过渡和业务结果稳定后采集两侧。焦点或表单状态改变按原门禁报告 `regressed`，由操作者核对是否为预期变化，不自动放宽。新旧版本混用、缺少新字段、适用表单字段用 null 占位、无效几何不能通过。旧 version 1 对比保留历史兼容，结果标为 `legacy-dom-layout` 并明确缺少新增覆盖；要使用新覆盖，前后都重新采集，不能给旧记录补字段。

快照只覆盖所采字段；不穿透 iframe/shadow DOM，不证明像素、事件订阅、库存、购物车及支付正确。原源码指纹、部署、独立采样、交互断言、0.5 CSS px 最大几何容差和回滚机制继续使用。现有重复样式表/资源 URL 的受限差异豁免也继续重放原计划，不豁免焦点变化。

实现来源与许可见 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)，完整购买交互另见 [场景矩阵](interaction-scenarios.md)。
