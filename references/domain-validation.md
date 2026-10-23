# 四类性能闭环验证记录（2026-10-22）

本轮补齐工具实现与隔离验证。用户已说明稍后提供真实主题项目地址，因此**真实商家主题、Shopify 服务端 Liquid 收益和正式全矩阵验收尚未执行**。没有发布店铺主题。以下结果不能用于宣称所有主题必然提分。

后续全面审查见 [domain-review.md](domain-review.md)。本页保留首次实现时的原始结果；新增证据门槛不追溯修改这些历史结果。

## 已实现与审查修复

- 部署前后双重校验的 runtime/Liquid 采集；从真实元素、图片尺寸变化和服务器热点绑定当前解析器位置。无 ID 图片可用明确审阅且浏览器验证唯一的 selector 映射。
- 图片 eager/high priority、尺寸/比例，App 容器双断点空间预留，受限 Liquid 缓存与 App defer/async 都生成实际补丁；复用应用、源码漂移检查、回滚和独立实验。
- 无收益或回归记录后回滚，重诊断并选择不同方法。缺少审阅可以修复；明确结构不支持的同源码方法可跳过，不把准备失败伪装成实测无收益。
- Liquid 交替采样的顺序、时间独立性和次数重新核验；从原始 Speedscope 重算 self-time；服务端无收益不继续花费 Lighthouse 样本。正式五次数据固定，不能补审阅时换样本。
- 修复纳秒到毫秒的换算；拒绝采样权重与总区间不一致的 profile；缓存生成拒绝覆盖 forloop 元数据的循环。
- App 原脚本完成加载、真实业务 UI 响应在探索与正式回归都必须成立。平台控制资源、未知归属或无法确认的依赖不自动改写。
- 新增 assert-image-loaded，使最终布局比较发生在同一图片加载状态；独立导航仍从首次加载开始测量 CLS。
- 核验候选自身的 kind/page/device/binding/source，不能改偏移后套用旧证据；动态属性名/条件属性列表及重复属性拒绝自动改写。
- 根据实际实验发现，App 解析阻塞的默认假设改为 FCP。保留旧实验原目标与拒绝结果，不以事后更换指标取得通过。

## 回归验证

| 范围 | 结果 | 日志 |
| --- | --- | --- |
| Node 全量 | 503 项：480 通过、23 按配置跳过、0 失败 | `/private/tmp/perfkit-domain-full-verified.log` |
| 最后解析器边界修补后的专项 | 12 项通过 | `/private/tmp/perfkit-domain-final-unit.log` |
| Python | 62 项：60 通过、2 跳过 | `/private/tmp/perfkit-domain-python.log` |
| 原有 Chrome + 首批新增用例 | 18 项通过（原有 15、新增 3） | `/private/tmp/perfkit-domain-browser-final.log` |
| 最终专项 Chrome | 新增 5 项全部通过，包含前述 3 项 | `/private/tmp/perfkit-domains-browser-extra-final.log` |

真实 Chrome 专项覆盖：实际 LCP 与源码映射、eager/high priority 输出、图片尺寸消除偏移、无 ID 唯一 selector、图片完成/损坏断言、App defer 后首次点击、移动/桌面容器空间预留。在容器测试中以实际观察到偏移的候选设备验证效果，不将一个断点的结果外推到其他设备。

Liquid 生成后的空循环、单条、多条数据使用 LiquidJS 比较实际输出；服务器证据契约使用明确标注的合成 Speedscope 反例。它们验证语义与门禁，不代表真实 Shopify 服务端加速。已检查本机 CLI 的 theme profile 帮助与实现，支持真实 JSON 采集；仍需用户主题和账户会话实测。

## 独立 Lighthouse 结果

隔离人工主题夹具使用真实 Chrome/Lighthouse，每个有效实验两侧各 3 次，交替顺序，总计 24 次导航。仅 Shopify source pull 的远端传输用本地副本替代。没有关闭资源、隐藏内容或重复抽样直到通过。分数目标固定为 score，变更后执行内容/最终布局及业务点击回归；所有测试补丁最后均实际回滚。

| 方法 | 移动端中位分 | 指标中位数 | 原实验判定 |
| --- | --- | --- | --- |
| 图片 eager | 100 → 98 | LCP 752 → 2404 ms | performance-regressed，回滚 |
| 图片 eager + high priority | 100 → 98 | LCP 751 → 2403 ms | performance-regressed，回滚；未继续采样磨分 |
| 图片宽高预留 | 98 → 98 | CLS 0.020365 → 0 | 指标改善但 score 无收益，no-measurable-gain，回滚 |
| App defer | 88 → 91 | FCP 1952 → 1215 ms；SI 3090 → 1989 ms；LCP 3602 → 3454 ms | 原先声明 LCP 未超过 200 ms 门槛，hypothesis-not-confirmed，回滚 |

原始产物：

- `/private/tmp/perfkit-domains-live-gwkuOb`：两种图片 LCP 方案及最初 CLS 回归采集失败。最初 CLS 比较的是尚未加载的基线与已预留的候选，所以没有执行该方案的 Lighthouse；修复为显式图片完成断言后重新验证。
- `/private/tmp/perfkit-domains-live-on6sPt`：有效的 CLS 与 App 对比；包含原始 LHR、部署证明、实际计划、内容/布局回归、完整验证与 result.json。

LCP 两种方案的负结果照实保留，未将其他指标波动或静态规范通过当作优化成功。App 的实测分数上涨也未事后升级为原假设通过。后续真实主题会用修正后的 FCP 假设预先声明实验，再验证独立数据；本轮不重写既有结果。

完整命令和边界见 [domain-optimization.md](domain-optimization.md)，依据见 [Shopify 官方来源映射](shopify-recovery-sources.md)。收到真实主题项目与未发布预览信息后，继续执行真实源码检查、正式部署身份校验、单补丁实测和必要的 Theme Check；目前不能签发真实主题性能验收。
